import frappe
from frappe import _


def _vigilantes_com_escala_futura(excluir_escala=None):
	"""
	Vigilantes that have FUTURE rows (data >= today) in any active Escala.
	With one-escala-per-posto, this is how we detect 'already scheduled elsewhere'.
	"""
	from frappe.utils import nowdate
	cond = "AND e.name != %(excl)s" if excluir_escala else ""
	return frappe.db.sql(
		f"""
		SELECT DISTINCT te.vigilante
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent
		WHERE e.estado = 'Activo'
		  AND te.data >= %(hoje)s
		  {cond}
		""",
		{"hoje": nowdate(), "excl": excluir_escala or ""},
		pluck="vigilante",
	)


@frappe.whitelist()
def get_reservas_disponiveis(delegacao=None, excluir_escala=None):
	"""
	Return benched reserve guards (status = Reserva) that are NOT already committed to an
	active escala. Used by the Escala 'Alocar Reservas' dialog. Reserva is an ESTADO — a
	benched, available guard; categoria is irrelevant to the pool.
	"""
	ocupados = set(_vigilantes_com_escala_futura(excluir_escala=excluir_escala))

	filters = {"status": "Reserva"}
	if delegacao:
		filters["delegacao"] = delegacao

	vigs = frappe.get_all(
		"Vigilante",
		filters=filters,
		fields=["name", "nome_completo", "categoria", "posto_de_vigilancia"],
		order_by="nome_completo",
		limit_page_length=500,
	)
	return [v for v in vigs if v.name not in ocupados]


@frappe.whitelist()
def alocar_reservas(posto, vigilantes, regime=None):
	"""
	Deploy a team of reserve guards to a (temporary) posto.
	Assigns each to the posto + regime (vig.save → occupation, Employee sync, capacity).
	Categoria is kept, so they return to the pool when the post closes.
	The post's Escala (built separately) then picks them up via Sincronizar.
	"""
	import json
	if isinstance(vigilantes, str):
		vigilantes = json.loads(vigilantes)
	if not vigilantes:
		return {"alocados": 0}

	max_vagas = frappe.db.get_value("Posto De Vigilancia", posto, "numero_de_vagas") or 0
	if max_vagas:
		atual = frappe.db.count("Vigilante", {"posto_de_vigilancia": posto, "status": "Activo"})
		a_adicionar = sum(
			1 for v in vigilantes
			if frappe.db.get_value("Vigilante", v, "posto_de_vigilancia") != posto
		)
		if atual + a_adicionar > max_vagas:
			frappe.throw(
				_("Capacidade excedida: o posto tem <b>{0}</b> vaga(s) livre(s), "
				  "mas seleccionou <b>{1}</b> nova(s).").format(max_vagas - atual, a_adicionar),
				title=_("Capacidade do Posto"),
			)

	alocados = 0
	for v in vigilantes:
		vig = frappe.get_doc("Vigilante", v)
		vig.posto_de_vigilancia = posto
		if regime:
			vig.regime_do_vigilante = regime
		vig.save(ignore_permissions=True)
		alocados += 1

	return {"alocados": alocados}


@frappe.whitelist()
def get_substitutos_disponiveis(doctype, txt, searchfield, start, page_len, filters):
	"""
	Frappe link search for vigilante_substituto. Eligible = benched reserve guards
	(status = Reserva). Reserva is an ESTADO, not a categoria — an available, benched
	guard ready to cover an absence.
	When grupo_delegados is passed, the pool is scoped to that grupo's delegações —
	each grupo covers its absences with its own people.
	When data (+periodo) is passed, guards are EXCLUDED if a submitted Ausencias of
	that day already marks them absent, or already books them as substituto for the
	same periodo — no double-booking a reserve across documents.
	"""
	import json
	if isinstance(filters, str):
		filters = json.loads(filters)

	excluir     = filters.get("excluir") or ""
	data        = filters.get("data") or ""
	periodo     = filters.get("periodo") or ""
	excluir_doc = filters.get("excluir_doc") or ""
	grupo       = filters.get("grupo_delegados") or ""
	# excluir_lista: the CURRENT (unsaved) doc's absentees + already-chosen replacements
	excluir_lista = filters.get("excluir_lista") or []
	if isinstance(excluir_lista, str):
		excluir_lista = json.loads(excluir_lista)

	lista = [v for v in excluir_lista if v]
	if excluir:
		lista.append(excluir)
	excluir_sql = "AND v.name NOT IN %(lista)s" if lista else ""

	grupo_sql = ""
	delegs = ()
	if grupo:
		delegs = tuple(frappe.get_all(
			"Grupo Delegados Item", filters={"parent": grupo}, pluck="delegacao",
		))
		if delegs:
			grupo_sql = "AND v.delegacao IN %(delegs)s"

	ocupado_sql = ""
	if data:
		excl_doc_sql = "AND a.name != %(excluir_doc)s" if excluir_doc else ""
		ocupado_sql = f"""
		  AND NOT EXISTS (
			SELECT 1 FROM `tabTabela Ausencia` ta
			JOIN `tabAusencias` a ON a.name = ta.parent
			WHERE a.docstatus = 1 AND a.data = %(data)s {excl_doc_sql}
			  AND (ta.vigilante = v.name
			       OR (ta.vigilante_substituto = v.name AND a.periodo = %(periodo)s))
		  )"""

	return frappe.db.sql(
		f"""
		SELECT v.name, v.nome_completo, v.categoria, v.status
		FROM `tabVigilante` v
		WHERE v.status = 'Reserva'
		  AND (v.name LIKE %(txt)s OR v.nome_completo LIKE %(txt)s)
		  {excluir_sql}
		  {grupo_sql}
		  {ocupado_sql}
		ORDER BY v.nome_completo
		LIMIT %(start)s, %(page_len)s
		""",
		{
			"txt":         f"%{txt}%",
			"lista":       tuple(lista) or ("",),
			"delegs":      delegs,
			"data":        data,
			"periodo":     periodo,
			"excluir_doc": excluir_doc,
			"start":       start,
			"page_len":    page_len,
		},
	)


@frappe.whitelist()
def get_escalados_no_posto_dia(doctype, txt, searchfield, start, page_len, filters):
	"""
	Link search for 'Dobra de Turno': only Vigilantes that were ESCALADOS (scheduled)
	at the given posto on the given day — they're already on site and can double up.
	Excludes guards with a SUBMITTED absence on that day, plus everyone in
	excluir_lista (the current doc's absentees and already-chosen replacements).
	"""
	import json
	if isinstance(filters, str):
		filters = json.loads(filters)

	posto       = filters.get("posto")   or ""
	data        = filters.get("data")    or ""
	excluir     = filters.get("excluir") or ""
	excluir_doc = filters.get("excluir_doc") or ""
	excluir_lista = filters.get("excluir_lista") or []
	if isinstance(excluir_lista, str):
		excluir_lista = json.loads(excluir_lista)
	if not (posto and data):
		return []

	lista = [v for v in excluir_lista if v]
	if excluir:
		lista.append(excluir)
	excluir_sql = "AND te.vigilante NOT IN %(lista)s" if lista else ""
	excl_doc_sql = "AND ax.name != %(excluir_doc)s" if excluir_doc else ""

	return frappe.db.sql(
		f"""
		SELECT DISTINCT te.vigilante, v.nome_completo, te.turno
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabVigilante` v ON v.name = te.vigilante
		WHERE te.posto = %(posto)s AND te.data = %(data)s
		  AND (te.vigilante LIKE %(txt)s OR v.nome_completo LIKE %(txt)s)
		  {excluir_sql}
		  AND NOT EXISTS (
			SELECT 1 FROM `tabTabela Ausencia` tax
			JOIN `tabAusencias` ax ON ax.name = tax.parent
			WHERE ax.docstatus = 1 AND ax.data = %(data)s {excl_doc_sql}
			  AND tax.vigilante = te.vigilante
		  )
		ORDER BY v.nome_completo
		LIMIT %(start)s, %(page_len)s
		""",
		{
			"posto":       posto,
			"data":        data,
			"lista":       tuple(lista) or ("",),
			"excluir_doc": excluir_doc,
			"txt":         f"%{txt}%",
			"start":       start,
			"page_len":    page_len,
		},
	)


@frappe.whitelist()
def get_substitutos_para_wizard(doctype, txt, searchfield, start, page_len, filters):
	"""
	Wizard substituto search: benched reserve guards (status = Reserva) AND not in another
	active Escala overlapping the given escala's period. Reserva is an ESTADO, not a categoria.
	"""
	import json
	if isinstance(filters, str):
		filters = json.loads(filters)

	escala_name = filters.get("escala_name") or ""
	excluir     = filters.get("excluir")     or ""

	# Vigilantes already committed to a future schedule in another active Escala
	ocupados = _vigilantes_com_escala_futura(excluir_escala=escala_name) if escala_name else []

	excluidos = list(set(ocupados + ([excluir] if excluir else [])))
	not_in    = "AND v.name NOT IN %(excluidos)s" if excluidos else ""

	return frappe.db.sql(
		f"""
		SELECT v.name, v.nome_completo, v.categoria
		FROM `tabVigilante` v
		WHERE v.status    = 'Reserva'
		  AND (v.name LIKE %(txt)s OR v.nome_completo LIKE %(txt)s)
		  {not_in}
		ORDER BY v.nome_completo
		LIMIT %(start)s, %(page_len)s
		""",
		{
			"txt":       f"%{txt}%",
			"excluidos": tuple(excluidos) if excluidos else ("__none__",),
			"start":     start,
			"page_len":  page_len,
		},
	)


@frappe.whitelist()
def get_vigilante_data(vigilante, data):
	"""Return schedule data (posto, regime, turno, periodo) for a vigilante on a given date."""
	return frappe.db.sql(
		"""
		SELECT
			te.vigilante,
			te.posto,
			te.regime,
			te.turno,
			te.periodo
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent
		WHERE te.vigilante = %s
		  AND te.data = %s
		  AND e.estado = 'Activo'
		""",
		(vigilante, data),
		as_dict=True
	)


@frappe.whitelist()
def get_filtered_vigilantes(periodo, data):
	"""Return distinct vigilantes active in the schedule for a given periodo and date."""
	results = frappe.db.sql(
		"""
		SELECT DISTINCT te.vigilante
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent
		JOIN `tabTurno` t ON t.name = te.turno
		WHERE t.periodo = %s
		  AND te.data = %s
		  AND e.estado = 'Activo'
		""",
		(periodo, data),
		as_dict=True
	)
	return [r["vigilante"] for r in results]


@frappe.whitelist()
def get_vigilantes_on_folga(data):
	"""Return vigilantes whose turno is a folga turn on the given date (from active Escalas)."""
	if not data:
		frappe.throw(_("Data é obrigatória"))

	return frappe.db.sql(
		"""
		SELECT te.vigilante, te.posto, te.turno
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent
		JOIN `tabTurno` t ON t.name = te.turno
		WHERE te.data = %(data)s
		  AND t.e_folga = 1
		  AND e.estado = 'Activo'
		""",
		{"data": data},
		as_dict=True
	)


@frappe.whitelist()
def get_vigilantes_sem_escala_activa_query(doctype, txt, searchfield, start, page_len, filters):
	"""
	Frappe link search query — returns Vigilantes not in any active Escala
	overlapping the given escala's period. Used by the wizard substituto picker.
	"""
	escala_name = filters.get("escala_name") or ""
	excluir     = filters.get("excluir") or ""

	if not escala_name:
		return []

	ocupados = _vigilantes_com_escala_futura(excluir_escala=escala_name)

	excluidos = list(set(ocupados + ([excluir] if excluir else [])))

	not_in = "AND v.name NOT IN %(excluidos)s" if excluidos else ""

	return frappe.db.sql(
		f"""
		SELECT v.name, v.nome_completo
		FROM `tabVigilante` v
		WHERE v.status = 'Activo'
		  AND (v.name LIKE %(txt)s OR v.nome_completo LIKE %(txt)s)
		  {not_in}
		ORDER BY v.nome_completo
		LIMIT %(start)s, %(page_len)s
		""",
		{
			"txt":       f"%{txt}%",
			"excluidos": tuple(excluidos) if excluidos else ("__none__",),
			"start":     start,
			"page_len":  page_len,
		},
	)


@frappe.whitelist()
def get_vigilantes_sem_escala_activa(escala_name, delegacao=None):
	"""
	Return Vigilante names that are NOT currently in any active Escala
	with a period overlapping the given escala's period.
	Used to filter the substituto picker in the wizard.
	"""
	ocupados = _vigilantes_com_escala_futura(excluir_escala=escala_name)

	filters = [
		["status", "=", "Activo"],
	]
	if ocupados:
		filters.append(["name", "not in", ocupados])
	if delegacao:
		filters.append(["delegacao", "=", delegacao])

	return frappe.get_all("Vigilante", filters=filters, fields=["name", "nome_completo"], limit=200)


@frappe.whitelist()
def get_vigilantes_em_outra_escala(escala_name, vigilantes):
	"""
	Given a list of vigilante names, return those that already have FUTURE rows
	in another active Escala.
	"""
	import json
	from frappe.utils import nowdate
	if isinstance(vigilantes, str):
		vigilantes = json.loads(vigilantes)
	if not vigilantes:
		return []

	return frappe.db.sql(
		"""
		SELECT DISTINCT te.vigilante, e.name AS escala
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent
		WHERE e.estado     = 'Activo'
		  AND e.name       != %(escala)s
		  AND te.data      >= %(hoje)s
		  AND te.vigilante IN %(vigilantes)s
		""",
		{
			"escala":     escala_name,
			"hoje":       nowdate(),
			"vigilantes": tuple(vigilantes),
		},
		as_dict=True,
	)


@frappe.whitelist()
def get_escalas_activas_para_vigilante(vigilante):
	"""Return active Escalas containing this vigilante, with row counts."""
	from sigos.utils import get_escalas_activas_com_vigilante
	escalas = get_escalas_activas_com_vigilante(vigilante)

	for e in escalas:
		nome_vig = frappe.db.get_value("Vigilante", vigilante, "nome_completo")
		e["nome_vigilante"] = nome_vig or vigilante

		# Count future rows for this vigilante
		from frappe.utils import today
		e["linhas_futuras"] = frappe.db.count(
			"Tabela De Escala De Vigilante",
			{"parent": e.name, "vigilante": vigilante, "data": [">=", today()]},
		)

	return escalas


@frappe.whitelist()
def actualizar_escala_apos_mudanca(
	escala_name, vigilante, accao, data_inicio=None,
	novo_vigilante=None, turno_inicial=None, detectar_turno=0, novo_regime=None,
):
	"""
	After a guard change, update the posto's Escala via its guard list.
	Day rows regenerate automatically through reconciliar_escala() on save.

	accao:
	  "remover"    — remove vigilante from the escala's guard list
	  "substituir" — remove vigilante, add novo_vigilante to the guard list
	  "manter" / "pular" — nothing
	"""
	if accao in ("manter", "pular"):
		return {"removido": 0, "adicionado": 0}

	escala = frappe.get_doc("Escala Do Vigilante", escala_name)

	# Capture the slot (turno_inicial) the removed guard occupied
	vacated = next(
		(g.turno_inicial for g in escala.tab_vigilante_do_posto if g.vigilante == vigilante),
		None,
	)

	# Remove the affected vigilante from the guard list
	escala.set("tab_vigilante_do_posto", [
		g for g in escala.tab_vigilante_do_posto if g.vigilante != vigilante
	])

	adicionado = 0
	if accao == "substituir" and novo_vigilante:
		if novo_vigilante in _vigilantes_com_escala_futura(excluir_escala=escala_name):
			frappe.throw(
				_("O vigilante <b>{0}</b> já está noutra escala activa. "
				  "Um vigilante só pode estar numa escala.").format(novo_vigilante),
				title=_("Vigilante em Escala Duplicada"),
			)

		# By default the replacement inherits the vacated slot (preserves coverage).
		# If a turno was explicitly chosen, use it.
		turno = turno_inicial if (turno_inicial and not detectar_turno) else vacated
		if not turno:
			from sigos.utils import get_regime_turno_sequence
			seq = get_regime_turno_sequence(escala.regime_do_vigilante)
			working = [t for t in seq if not t.get("e_folga")]
			turno = working[0]["turno"] if working else None

		# Collision: another guard already on this slot → swap them to the vacated slot
		if turno and turno != vacated and vacated:
			colidente = next(
				(g for g in escala.tab_vigilante_do_posto if g.turno_inicial == turno),
				None,
			)
			if colidente:
				colidente.turno_inicial = vacated

		escala.append("tab_vigilante_do_posto", {
			"vigilante": novo_vigilante,
			"turno_inicial": turno,
		})
		adicionado = 1

	escala.save(ignore_permissions=True)  # validate → reconciliar regenerates day rows
	return {"removido": 1, "adicionado": adicionado}


@frappe.whitelist()
def gerar_escala_posto(escala_name):
	"""Manually generate/extend the escala (button). Reconcile runs in validate on save."""
	escala = frappe.get_doc("Escala Do Vigilante", escala_name)
	escala.reconciliar_escala()
	escala.save(ignore_permissions=True)
	return {"gerado_ate": str(escala.gerado_ate), "linhas": len(escala.tabela_de_escala)}


@frappe.whitelist()
def limpar_futuro_escala(escala_name):
	"""Remove all future, non-override rows."""
	escala = frappe.get_doc("Escala Do Vigilante", escala_name)
	escala.limpar_futuro()
	escala.save(ignore_permissions=True)
	return {"linhas": len(escala.tabela_de_escala)}


@frappe.whitelist()
def get_regime_turnos(regime):
	"""
	Return the ordered turno sequence for a regime.
	Used by Escala Do Vigilante JS to generate the schedule dynamically.
	"""
	from sigos.utils import get_regime_turno_sequence
	return get_regime_turno_sequence(regime)


@frappe.whitelist()
def get_turnos_do_regime_query(doctype, txt, searchfield, start, page_len, filters):
	"""Link search: working (non-folga) turnos that belong to a regime."""
	import json
	if isinstance(filters, str):
		filters = json.loads(filters)
	regime = filters.get("regime") or ""
	if not regime:
		return []

	return frappe.db.sql(
		"""
		SELECT t.name, t.periodo
		FROM `tabRegime Turno Item` rti
		JOIN `tabTurno` t ON t.name = rti.turno
		WHERE rti.parent = %(regime)s
		  AND (t.e_folga IS NULL OR t.e_folga = 0)
		  AND (t.name LIKE %(txt)s)
		ORDER BY rti.idx
		LIMIT %(start)s, %(page_len)s
		""",
		{"regime": regime, "txt": f"%{txt}%", "start": start, "page_len": page_len},
	)


@frappe.whitelist()
def get_vigilantes_da_escala(data, periodo, grupo_delegados=None, excluir_doc=None):
	"""
	Return every vigilante expected on shift for data+periodo,
	enriched with posto, turno, regime, delegacao and nome_completo.
	Optionally scoped to the delegacoes in grupo_delegados.
	Each row is annotated with ja_registado_em / ja_registado_estado when the guard
	already has an absence in ANOTHER doc (draft or submitted) for this data+periodo —
	the deck greys them out at add-time instead of erroring at save.
	Used by the Ausencias quick-add dialog and set_query filter.
	"""
	base_sql = """
		SELECT
			te.vigilante,
			v.nome_completo,
			v.mecanografico,
			v.delegacao,
			te.posto,
			te.turno,
			te.regime,
			COALESCE(NULLIF(te.periodo, ''), t.periodo) AS periodo,
			COALESCE(rti.n_de_faltas, 1) AS n_de_faltas
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent
		JOIN `tabVigilante` v ON v.name = te.vigilante
		JOIN `tabTurno` t ON t.name = te.turno
		LEFT JOIN `tabRegime Turno Item` rti
			ON rti.parent = te.regime AND rti.turno = te.turno
		WHERE e.estado = 'Activo'
		  AND te.data = %(data)s
		  AND t.periodo = %(periodo)s
		  AND (t.e_folga IS NULL OR t.e_folga = 0)
		{extra}
		ORDER BY v.delegacao, v.nome_completo
	"""
	params = {"data": data, "periodo": periodo}

	extra = ""
	if grupo_delegados:
		delegacoes = frappe.get_all(
			"Grupo Delegados Item",
			filters={"parent": grupo_delegados},
			fields=["delegacao"],
			pluck="delegacao",
		)
		if delegacoes:
			# frappe.db.sql supports tuple for IN
			params["delegacoes"] = tuple(delegacoes)
			extra = "AND v.delegacao IN %(delegacoes)s"

	rows = frappe.db.sql(base_sql.format(extra=extra), params, as_dict=True)
	_marcar_ja_registados(rows, data, periodo, excluir_doc)
	_marcar_licencas(rows, data)
	return rows


def _marcar_ja_registados(rows, data, periodo, excluir_doc=None):
	"""
	Annotate roster rows whose guard already has an absence registered in another
	Ausencias doc (any grupo) for the same data+periodo. Submitted wins over draft.
	"""
	vigs = [r.vigilante for r in rows if r.get("vigilante")]
	if not vigs:
		return
	params = {"d": data, "p": periodo, "vigs": tuple(vigs)}
	excl = ""
	if excluir_doc:
		excl = "AND a.name != %(excl)s"
		params["excl"] = excluir_doc
	conflitos = frappe.db.sql(
		f"""
		SELECT ta.vigilante, a.name AS doc, a.docstatus
		FROM `tabTabela Ausencia` ta
		JOIN `tabAusencias` a ON a.name = ta.parent
		WHERE a.docstatus < 2 AND a.data = %(d)s AND a.periodo = %(p)s
		  AND ta.vigilante IN %(vigs)s {excl}
		""",
		params,
		as_dict=True,
	)
	por_vig = {}
	for c in conflitos:
		if c.vigilante not in por_vig or c.docstatus > por_vig[c.vigilante].docstatus:
			por_vig[c.vigilante] = c
	for r in rows:
		c = por_vig.get(r.vigilante)
		if c:
			r["ja_registado_em"] = c.doc
			r["ja_registado_estado"] = "Submetido" if c.docstatus == 1 else "Rascunho"

	# Guards COVERING an absence (substituto/dobra/adiantamento) in a submitted doc
	# of the same date can't be marked absent — grey them too.
	cobrindo = frappe.db.sql(
		f"""
		SELECT a.name AS doc,
		       ta.vigilante_substituto, ta.vigilante_a_dobrar, ta.vigilante_a_adiantar
		FROM `tabTabela Ausencia` ta
		JOIN `tabAusencias` a ON a.name = ta.parent
		WHERE a.docstatus = 1 AND a.data = %(d)s {excl}
		  AND (ta.vigilante_substituto IN %(vigs)s
		       OR ta.vigilante_a_dobrar IN %(vigs)s
		       OR ta.vigilante_a_adiantar IN %(vigs)s)
		""",
		params,
		as_dict=True,
	)
	cobre_doc = {}
	for c in cobrindo:
		for campo in ("vigilante_substituto", "vigilante_a_dobrar", "vigilante_a_adiantar"):
			if c.get(campo):
				cobre_doc.setdefault(c.get(campo), c.doc)
	for r in rows:
		if not r.get("ja_registado_em") and r.vigilante in cobre_doc:
			r["ja_registado_em"] = cobre_doc[r.vigilante]
			r["ja_registado_estado"] = "a cobrir uma ausência"


def _marcar_licencas(rows, data):
	"""
	Annotate roster rows whose guard has an APPROVED leave (any Leave Type)
	covering `data` — soft warning only, does NOT grey the guard out like
	_marcar_ja_registados does. Lets the Ausencias deck flag "this guard is on
	leave" before a supervisor taps Falta on them by mistake.
	"""
	vigs = [r.vigilante for r in rows if r.get("vigilante")]
	if not vigs:
		return

	pares = frappe.get_all(
		"Vigilante", filters={"name": ["in", vigs]}, fields=["name", "funcionario"],
	)
	emp_de_vig = {p.name: p.funcionario for p in pares if p.funcionario}
	if not emp_de_vig:
		return
	vig_de_emp = {emp: vig for vig, emp in emp_de_vig.items()}

	apps = frappe.get_all(
		"Leave Application",
		filters={
			"employee": ["in", list(emp_de_vig.values())],
			"status": "Approved",
			"docstatus": 1,
			"from_date": ["<=", data],
			"to_date": [">=", data],
		},
		fields=["employee", "leave_type"],
	)
	licenca_de_vig = {vig_de_emp[a.employee]: a.leave_type for a in apps if a.employee in vig_de_emp}
	for r in rows:
		if r.vigilante in licenca_de_vig:
			r["em_licenca"] = licenca_de_vig[r.vigilante]


@frappe.whitelist()
def get_vigilante_dash(vigilante):
	"""
	Mini-dash for the Vigilante form: faltas accumulated this month (same single
	source as payroll/report) + today's escala shift. Both indexed and cheap.
	"""
	from frappe.utils import getdate, nowdate
	from sigos.utils import calcular_faltas_vigilante

	hoje = getdate(nowdate())
	out = {"faltas_mes": calcular_faltas_vigilante(vigilante, hoje.replace(day=1), hoje)}

	turno = frappe.db.sql(
		"""
		SELECT te.turno, te.posto,
		       COALESCE(NULLIF(te.periodo, ''), t.periodo) AS periodo,
		       COALESCE(t.e_folga, 0) AS e_folga
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent
		LEFT JOIN `tabTurno` t ON t.name = te.turno
		WHERE e.estado = 'Activo' AND te.vigilante = %(v)s AND te.data = %(d)s
		LIMIT 1
		""",
		{"v": vigilante, "d": hoje},
		as_dict=True,
	)
	out["hoje"] = turno[0] if turno else None
	return out


@frappe.whitelist()
def get_contexto_faltas(data, linhas):
	"""
	Falta context for the Ausencias deck cards, in one batch call.
	linhas = JSON list of {vigilante, regime, turno}. Returns a map
	vigilante -> {base, efetivo, dedup, faltas_mes}:
	- base    = Regime Turno Item weight for the (regime, turno)
	- efetivo = weight after the escala-aware consecutive de-dup
	- faltas_mes = SUBMITTED faltas accumulated this month up to `data`
	  (same source as the Cumulativo de Faltas report and payroll).
	"""
	import json
	from frappe.utils import getdate
	from sigos.utils import calcular_n_faltas, calcular_n_faltas_efetivo, calcular_faltas_vigilante

	if isinstance(linhas, str):
		linhas = json.loads(linhas)
	d = getdate(data)
	inicio_mes = d.replace(day=1)

	out = {}
	for l in linhas or []:
		vig = l.get("vigilante")
		if not vig or vig in out:
			continue
		base = calcular_n_faltas(l.get("regime"), l.get("turno"))
		efetivo = calcular_n_faltas_efetivo(vig, l.get("regime"), l.get("turno"), d)
		out[vig] = {
			"base": base,
			"efetivo": efetivo,
			"dedup": efetivo < base,
			"faltas_mes": calcular_faltas_vigilante(vig, inicio_mes, d),
		}
	return out


@frappe.whitelist()
def get_vigilantes(from_date=None, to_date=None, status=None, delegacao=None, projecto=None):
	"""
	Fetch Vigilante records with optional filters.
	- from_date / to_date: filter by data_admissao
	- status: exact match
	- delegacao: exact match
	- projecto: exact match
	"""
	filters = {}

	if from_date and to_date:
		filters["data_admissao"] = ["between", [from_date, to_date]]
	elif from_date:
		filters["data_admissao"] = [">=", from_date]
	elif to_date:
		filters["data_admissao"] = ["<=", to_date]

	if status:
		filters["status"] = status
	if delegacao:
		filters["delegacao"] = delegacao
	if projecto:
		filters["projecto"] = projecto

	return frappe.get_all(
		"Vigilante",
		filters=filters,
		fields=[
			"name as docname",
			"nome_completo",
			"mecanografico",
			"status",
			"categoria",
			"regime_do_vigilante",
			"tipo_de_vigilante",
			"delegacao",
			"posto_de_vigilancia",
			"tipo_de_posto",
			"cliente",
			"projecto",
			"nome_do_projecto",
			"data_admissao",
			"motivo_de_admissao",
			"empresa",
			"sexo",
			"data_de_nascimento",
			"idade",
			"contacto",
			"residencia",
			"dependentes",
			"codename",
			"documento",
			"anexar_documento",
			"funcionario",
			"owner",
			"creation",
			"modified"
		],
		order_by="data_admissao desc, creation desc"
	)


@frappe.whitelist()
def get_ausencias(from_date=None, to_date=None, delegacao=None, periodo=None, limit=500):
	"""
	Return absence rows with full summaries (total, justificadas, por_tipo, top_vigilantes).
	rows: limited by the `limit` parameter.
	summaries: computed over the full unfiltered dataset.
	"""
	conditions = ["a.docstatus < 2"]
	params = {"limit": int(limit)}

	if from_date and to_date:
		conditions.append("a.data between %(from_date)s and %(to_date)s")
		params.update({"from_date": from_date, "to_date": to_date})
	elif from_date:
		conditions.append("a.data >= %(from_date)s")
		params["from_date"] = from_date
	elif to_date:
		conditions.append("a.data <= %(to_date)s")
		params["to_date"] = to_date

	if delegacao:
		conditions.append("ta.delegacao = %(delegacao)s")
		params["delegacao"] = delegacao

	if periodo:
		conditions.append("a.periodo = %(periodo)s")
		params["periodo"] = periodo

	where_sql = " and ".join(conditions)

	# Raw rows (limited)
	rows = frappe.db.sql(
		f"""
		select
			a.name              as docname_parent,
			a.data              as data,
			a.periodo           as periodo,
			ta.name             as rowname,
			ta.vigilante        as vigilante,
			ta.nome_do_vigilante as nome_do_vigilante,
			ta.mecanografico    as mecanografico,
			ta.tipo_de_ausencia as tipo_de_ausencia,
			ta.turno            as turno,
			ta.posto            as posto,
			ta.delegacao        as delegacao,
			ta.jutificativo     as jutificativo,
			ta.data_justificativo as data_justificativo
		from `tabTabela Ausencia` ta
		join `tabAusencias` a on ta.parent = a.name
		where {where_sql}
		order by a.data desc, ta.modified desc
		limit %(limit)s
		""",
		params,
		as_dict=True
	)

	base_params = dict(params)

	# Total count
	total_registos = frappe.db.sql(
		f"""
		select count(1) as c
		from `tabTabela Ausencia` ta
		join `tabAusencias` a on ta.parent = a.name
		where {where_sql}
		""",
		base_params,
		as_dict=True
	)[0]["c"] or 0

	# Justificadas vs sem justificativo
	just_row = frappe.db.sql(
		f"""
		select
			sum(case when ta.jutificativo is not null or ta.data_justificativo is not null then 1 else 0 end) as justificadas,
			sum(case when ta.jutificativo is null and ta.data_justificativo is null then 1 else 0 end) as sem_justificativo
		from `tabTabela Ausencia` ta
		join `tabAusencias` a on ta.parent = a.name
		where {where_sql}
		""",
		base_params,
		as_dict=True
	)[0] or {"justificadas": 0, "sem_justificativo": 0}

	# Por tipo
	por_tipo_rows = frappe.db.sql(
		f"""
		select coalesce(ta.tipo_de_ausencia, '—') as tipo, count(1) as c
		from `tabTabela Ausencia` ta
		join `tabAusencias` a on ta.parent = a.name
		where {where_sql}
		group by coalesce(ta.tipo_de_ausencia, '—')
		""",
		base_params,
		as_dict=True
	)
	por_tipo = {r["tipo"]: r["c"] for r in por_tipo_rows}

	# Top vigilantes
	top_vigilantes = frappe.db.sql(
		f"""
		select
			coalesce(ta.vigilante, ta.nome_do_vigilante, '—') as vigilante_key,
			max(ta.nome_do_vigilante) as nome,
			count(1) as ocorrencias
		from `tabTabela Ausencia` ta
		join `tabAusencias` a on ta.parent = a.name
		where {where_sql}
		group by coalesce(ta.vigilante, ta.nome_do_vigilante, '—')
		order by ocorrencias desc
		limit 10
		""",
		base_params,
		as_dict=True
	)

	return {
		"rows": rows,
		"summary": {
			"total_registos": total_registos,
			"ocorrencias_total": total_registos,
			"justificadas": just_row.get("justificadas", 0) or 0,
			"sem_justificativo": just_row.get("sem_justificativo", 0) or 0,
			"por_tipo": por_tipo,
		},
		"top_vigilantes": top_vigilantes,
	}


@frappe.whitelist()
def get_vigilantes_sem_posto(delegacao=None):
	"""
	Return assignable vigilantes (admitted, active without posto, or in Reserva) that:
	  - have no posto assigned
	  - have a linked Employee (funcionario is set)
	Reserva guards are the prime candidates here — the reserve pool is what you deploy.
	Used by the Atribuir Vigilantes dialog on Posto De Vigilancia.
	"""
	filters = {
		"status":              ["in", ["Pre-Adimissão", "Activo", "Reserva"]],
		"posto_de_vigilancia": ["is", "not set"],
		"funcionario":         ["is", "set"],
	}
	if delegacao:
		filters["delegacao"] = delegacao

	return frappe.get_all(
		"Vigilante",
		filters=filters,
		fields=["name", "nome_completo", "status", "categoria", "regime_do_vigilante", "delegacao"],
		order_by="nome_completo",
		limit_page_length=500,
	)


@frappe.whitelist()
def atribuir_vigilantes_ao_posto(posto, vigilantes, regime=None):
	"""
	Assign unassigned admitted vigilantes to a posto.
	Validates posto state, capacity, and employee link.
	Saves via vig.save() so all Vigilante validations fire.
	"""
	import json
	if isinstance(vigilantes, str):
		vigilantes = json.loads(vigilantes)
	if not vigilantes:
		return {"atribuidos": 0, "erros": []}

	posto_doc = frappe.get_doc("Posto De Vigilancia", posto)

	if posto_doc.estado != "Activo":
		frappe.throw(
			_("O posto <b>{0}</b> deve estar <b>Activo</b> para receber vigilantes.").format(posto),
			title=_("Posto Inactivo"),
		)

	max_vagas = posto_doc.numero_de_vagas or 0
	if max_vagas:
		atual = frappe.db.count(
			"Vigilante",
			{"posto_de_vigilancia": posto, "status": ["in", ["Pre-Adimissão", "Activo"]]},
		)
		livres = max_vagas - atual
		if len(vigilantes) > livres:
			frappe.throw(
				_("Capacidade excedida: <b>{0}</b> vaga(s) livre(s), tentou adicionar <b>{1}</b>.").format(
					livres, len(vigilantes)
				),
				title=_("Capacidade do Posto"),
			)

	nome_proj = (
		frappe.db.get_value("Project", posto_doc.project, "project_name")
		if posto_doc.project else None
	)

	atribuidos = 0
	erros = []

	for v in vigilantes:
		try:
			vig = frappe.get_doc("Vigilante", v)

			if vig.posto_de_vigilancia:
				erros.append(
					_("{0} já está no posto {1} — ignorado.").format(vig.nome_completo, vig.posto_de_vigilancia)
				)
				continue

			if not vig.funcionario:
				erros.append(
					_("{0} sem Funcionário associado — use Admitir (RH) primeiro.").format(vig.nome_completo)
				)
				continue

			vig.posto_de_vigilancia = posto
			vig.tipo_de_posto       = posto_doc.tipo_de_posto
			vig.cliente             = posto_doc.cliente
			vig.projecto            = posto_doc.project
			vig.nome_do_projecto    = nome_proj
			if regime:
				vig.regime_do_vigilante = regime

			vig.save(ignore_permissions=True)
			atribuidos += 1

		except frappe.ValidationError as e:
			erros.append(f"{vig.nome_completo}: {e}")
		except Exception as e:
			frappe.log_error(f"atribuir_vigilantes: {posto}/{v}: {e}", "SIGOS")
			erros.append(f"{v}: erro interno.")

	return {"atribuidos": atribuidos, "erros": erros}


@frappe.whitelist()
def get_escala_preview_posto(posto, dias=7):
	"""
	Return a 7-day schedule preview for every Escala at a posto.
	Used by the Ver Escala dialog on Posto De Vigilancia.
	"""
	from frappe.utils import today, add_days, getdate

	hoje = getdate(today())
	fim  = add_days(hoje, int(dias) - 1)

	escalas = frappe.get_all(
		"Escala Do Vigilante",
		filters={"posto_de_vigilancia": posto},
		fields=["name", "estado", "regime_do_vigilante", "gerado_ate", "data_de_inicio"],
		order_by="FIELD(estado,'Activo','Rascunho','Arquivado'), name",
	)

	result = []
	for esc in escalas:
		# Day-by-day rows for the window
		rows = frappe.get_all(
			"Tabela De Escala De Vigilante",
			filters={
				"parent": esc.name,
				"data":   ["between", [str(hoje), str(fim)]],
			},
			fields=["vigilante", "data", "turno", "periodo", "override"],
			order_by="data, vigilante",
		)

		# Guard list (ordered)
		guards_raw = frappe.get_all(
			"Tab Vigilante Do Posto",
			filters={"parent": esc.name},
			fields=["vigilante"],
			order_by="idx",
		)

		# Vigilante names
		all_vigs = list({r.vigilante for r in rows} | {g.vigilante for g in guards_raw})
		vig_map = {}
		if all_vigs:
			for v in frappe.get_all(
				"Vigilante",
				filters={"name": ["in", all_vigs]},
				fields=["name", "nome_completo"],
			):
				vig_map[v.name] = v.nome_completo

		# Index rows by (vigilante, date)
		by_vd = {}
		for r in rows:
			by_vd[(r.vigilante, str(r.data))] = {
				"turno":    r.turno,
				"periodo":  r.periodo or "",
				"override": r.override,
			}

		days = [str(add_days(hoje, i)) for i in range(int(dias))]

		result.append({
			"name":       esc.name,
			"estado":     esc.estado,
			"regime":     esc.regime_do_vigilante,
			"gerado_ate": str(esc.gerado_ate) if esc.gerado_ate else None,
			"days":       days,
			"guards": [
				{
					"name": g.vigilante,
					"nome": vig_map.get(g.vigilante, g.vigilante),
					"dias": [by_vd.get((g.vigilante, d)) for d in days],
				}
				for g in guards_raw
			],
		})

	return result


@frappe.whitelist()
def has_active_workflow(doctype):
	"""Whether an ACTIVE Workflow currently governs doctype — unlike checking for
	the workflow_state field client-side, this doesn't false-positive once a
	Workflow has been disabled (Frappe never removes the field just for that)."""
	from frappe.model.workflow import get_workflow_name
	return bool(get_workflow_name(doctype))


@frappe.whitelist()
def preview_rotatividade(vigilante, abreviatura_op=None, novo_posto=None, novo_regime=None,
                         nova_categoria=None, novo_vigilante=None, motivo=None, data=None,
                         motivo_3meses=None):
	"""
	Dry-run a Rotatividade: compute every cascade WITHOUT saving anything, so the
	wizard can show what will happen before commit. Shares the operation-flag and
	escala-pair logic with the on_submit executor, so preview and execution agree.
	"""
	from sigos.security_ops.doctype.escala_do_vigilante.escala_do_vigilante import _escala_do_par

	out = {
		"vigilante": vigilante, "nome": None, "operacao": None,
		"mudancas": [], "escala": None, "ocupacao": [], "substituto": None,
		"demite": False, "avisos": [],
	}
	if not vigilante:
		return out

	vig = frappe.get_doc("Vigilante", vigilante)
	out["nome"] = vig.nome_completo or vigilante

	op = None
	if abreviatura_op and frappe.db.exists("Operacao De Rotatividade", abreviatura_op):
		op = frappe.get_doc("Operacao De Rotatividade", abreviatura_op)
		out["operacao"] = op.operacao

	cur_posto, cur_regime, cur_categoria = vig.posto_de_vigilancia, vig.regime_do_vigilante, vig.categoria
	new_posto, new_regime = cur_posto, cur_regime
	if op and op.muda_posto and novo_posto:
		new_posto = novo_posto
	if op and op.muda_regime and novo_regime:
		new_regime = novo_regime

	demite = bool(op and op.demite) or motivo == "Demissão"
	reserva = bool(op and op.get("enviar_reserva")) and not demite
	out["demite"] = demite

	def _nome_posto(p):
		return frappe.db.get_value("Posto De Vigilancia", p, "nome_do_posto") or p if p else None

	# ── Changes ──
	if new_posto != cur_posto:
		out["mudancas"].append({"campo": "Posto", "de": _nome_posto(cur_posto), "para": _nome_posto(new_posto)})
		# Contract (project) + customer follow the posto — flag cross-contract moves
		old_proj = frappe.db.get_value("Posto De Vigilancia", cur_posto, "project") if cur_posto else None
		new_proj = frappe.db.get_value("Posto De Vigilancia", new_posto, "project") if new_posto else None
		if old_proj != new_proj:
			old_cust = frappe.db.get_value("Project", old_proj, "customer") if old_proj else None
			new_cust = frappe.db.get_value("Project", new_proj, "customer") if new_proj else None
			out["mudancas"].append({"campo": "Contrato", "de": old_proj or "—", "para": new_proj or "—"})
			if old_cust != new_cust:
				out["mudancas"].append({"campo": "Cliente", "de": old_cust or "—", "para": new_cust or "—"})
			out["avisos"].append(
				"Transferência entre contratos ({0} → {1}) — exige justificação.".format(old_proj or "—", new_proj or "—")
			)
	if new_regime != cur_regime:
		out["mudancas"].append({"campo": "Regime", "de": cur_regime, "para": new_regime})
	if demite:
		out["mudancas"].append({"campo": "Estado", "de": vig.status, "para": "Demitido"})
	elif reserva:
		out["mudancas"].append({"campo": "Estado", "de": vig.status, "para": "Reserva"})
		if cur_posto:
			out["mudancas"].append({"campo": "Posto", "de": _nome_posto(cur_posto), "para": "— (sai do posto)"})

	# ── Escala migration ──
	old_pair = (cur_posto, cur_regime)
	# demissão and reserva both pull the guard out of any escala (no destination)
	dest_posto, dest_regime = (None, None) if (demite or reserva) else (new_posto, new_regime)
	if old_pair != (dest_posto, dest_regime):
		sai = _escala_do_par(cur_posto, cur_regime)
		if sai and not frappe.db.exists("Tab Vigilante Do Posto", {"parent": sai, "vigilante": vigilante}):
			sai = None
		entra, entra_criada = None, False
		if dest_posto and dest_regime:
			entra = _escala_do_par(dest_posto, dest_regime)
			entra_criada = entra is None
		out["escala"] = {"sai": sai, "entra": entra, "entra_criada": entra_criada}

	# ── Occupation deltas ──
	deltas = {}
	def _d(p, n):
		if p:
			deltas[p] = deltas.get(p, 0) + n
	if demite or new_posto != cur_posto:
		_d(cur_posto, -1)
	if not demite and new_posto != cur_posto:
		_d(new_posto, +1)
	if op and op.requer_substituto and novo_vigilante and cur_posto:
		sub_cur = frappe.db.get_value("Vigilante", novo_vigilante, "posto_de_vigilancia")
		_d(sub_cur, -1)
		_d(cur_posto, +1)
	for p, dlt in deltas.items():
		if dlt == 0:
			continue
		atual = frappe.db.count("Vigilante", {"posto_de_vigilancia": p, "status": "Activo"})
		out["ocupacao"].append({"posto": _nome_posto(p), "de": atual, "para": atual + dlt})

	# ── Substituto (must already match the guard's categoria) ──
	if op and op.requer_substituto and novo_vigilante and cur_posto:
		sub_cat = frappe.db.get_value("Vigilante", novo_vigilante, "categoria")
		out["substituto"] = {
			"vigilante": novo_vigilante,
			"nome": frappe.db.get_value("Vigilante", novo_vigilante, "nome_completo") or novo_vigilante,
			"assume_posto": _nome_posto(cur_posto),
		}
		if cur_categoria and sub_cat and sub_cat != cur_categoria:
			out["avisos"].append(
				"O substituto tem categoria {0}, mas a vaga exige {1} — faça primeiro uma Troca De Categoria.".format(sub_cat, cur_categoria)
			)

	# ── Warnings ──
	if new_posto and new_posto != cur_posto:
		max_vagas = frappe.db.get_value("Posto De Vigilancia", new_posto, "numero_de_vagas") or 0
		if max_vagas:
			atual = frappe.db.count("Vigilante", {"posto_de_vigilancia": new_posto, "status": "Activo"})
			if atual >= max_vagas:
				out["avisos"].append("O posto de destino já está no limite ({0}/{1}).".format(atual, max_vagas))
	if op and op.requer_substituto and novo_vigilante:
		cat_vig = vig.categoria
		cat_sub = frappe.db.get_value("Vigilante", novo_vigilante, "categoria")
		if cat_vig and cat_sub and cat_vig != cat_sub:
			out["avisos"].append("Categorias diferentes ({0} vs {1}) — faça primeiro uma Troca De Categoria.".format(cat_vig, cat_sub))
	dias_min = frappe.db.get_single_value("SIGOS Settings", "dias_minimos_rotatividade") or 90
	base = frappe.db.get_value("Vigilante", vigilante, "data_admissao")
	if base and not motivo_3meses:
		from frappe.utils import date_diff, today as _today
		if date_diff(_today(), base) < dias_min:
			out["avisos"].append("Vigilante ainda não completou {0} dias desde a admissão — exige justificação.".format(dias_min))

	return out


@frappe.whitelist()
def search_vigilantes_rich(txt="", status="Activo", delegacao=None, excluir=None, so_substitutos=0):
	"""Rich vigilante search for the Rotatividade wizard pickers — returns name + current posto/regime/categoria."""
	cond = []
	params = {"txt": "%" + (txt or "") + "%"}
	substituto = int(so_substitutos or 0)
	if substituto:
		# A substituto is an AVAILABLE benched guard: Reserva is an ESTADO, not a categoria.
		# We surface guards in Reserva and never pull one from an active posto. Categoria-
		# match to the vacancy is enforced at submit (see _validar_substituto_categoria).
		cond.append("v.status = 'Reserva'")
	else:
		cond.append("v.status = %(status)s"); params["status"] = status
	if delegacao:
		cond.append("v.delegacao = %(delegacao)s"); params["delegacao"] = delegacao
	if excluir:
		cond.append("v.name != %(excluir)s"); params["excluir"] = excluir
	where = " AND ".join(cond)
	# For substitutos, surface benched guards (Reserva) first — they free no posto.
	order = "v.nome_completo"
	return frappe.db.sql(f"""
		SELECT v.name, v.nome_completo, v.mecanografico, v.posto_de_vigilancia AS posto,
		       v.regime_do_vigilante AS regime, v.categoria, v.delegacao, v.status
		FROM `tabVigilante` v
		WHERE {where}
		  AND (v.name LIKE %(txt)s OR v.nome_completo LIKE %(txt)s OR v.mecanografico LIKE %(txt)s)
		ORDER BY {order}
		LIMIT 25
	""", params, as_dict=True)


@frappe.whitelist()
def get_regime_rate(project, regime):
	"""
	Monthly billed rate per vigilante for a regime under a contract (Project).
	Reads the project's per-regime tariff table; falls back to the project's
	default valor (custom_valor_do_contrato) when the regime has no specific rate.
	"""
	if not project:
		return 0
	rate = frappe.db.get_value("Project Regime Rate", {"parent": project, "regime": regime}, "valor")
	if rate:
		return rate
	return frappe.db.get_value("Project", project, "custom_valor_do_contrato") or 0


# ─── Salário base por contrato/regime ────────────────────────────────────────────

@frappe.whitelist()
def get_regime_salary(project, regime):
	"""
	Default base salary per vigilante for a regime under a contract (Project).
	Reads the project's per-regime table (salario_base column). Unlike the billing
	rate there is no project-level fallback — a regime with no base returns 0, which
	the apply action surfaces as 'ignorado'.
	"""
	if not project or not regime:
		return 0
	return frappe.db.get_value(
		"Project Regime Rate", {"parent": project, "regime": regime}, "salario_base"
	) or 0


@frappe.whitelist()
def resolver_salario_base(vigilante):
	"""
	A vigilante's base = manual override if set, else the contract's per-regime
	salary — then floored at the Salário Mínimo Padrão (SIGOS Settings). The floor
	doubles as the fallback: a vigilante with no override and no contract/regime base
	still resolves to the minimum (when one is set). `vigilante` may be a name (str)
	or a dict carrying the needed fields.
	"""
	from frappe.utils import flt
	if isinstance(vigilante, str):
		v = frappe.db.get_value(
			"Vigilante", vigilante,
			["salario_base_manual", "projecto", "regime_do_vigilante"],
			as_dict=True,
		) or {}
	else:
		v = vigilante or {}

	manual = flt(v.get("salario_base_manual"))
	base = manual if manual > 0 else flt(get_regime_salary(v.get("projecto"), v.get("regime_do_vigilante")))

	minimo = flt(frappe.db.get_single_value("SIGOS Settings", "salario_minimo_padrao"))
	if minimo > 0:
		base = max(base, minimo)
	return base


def _aplicar_salario_base_vigilante(v, estrutura, from_date):
	"""
	Write one vigilante's resolved base to a Salary Structure Assignment.
	Idempotent: no-op when the latest SSA already carries the resolved base; a draft
	on the same date is updated, otherwise a new dated, submitted SSA supersedes it.
	Returns (status, detalhe) where status ∈ atribuido|actualizado|inalterado|ignorado.
	"""
	from frappe.utils import flt, getdate

	funcionario = v.get("funcionario")
	if not funcionario:
		return ("ignorado", _("{0}: sem Funcionário").format(v.get("name")))

	base = resolver_salario_base(v)
	if flt(base) <= 0:
		return ("ignorado", _("{0}: sem salário base (regime do contrato sem valor)").format(v.get("name")))

	existing = frappe.get_all(
		"Salary Structure Assignment",
		filters={"employee": funcionario, "docstatus": ["<", 2]},
		fields=["name", "base", "docstatus", "from_date"],
		order_by="from_date desc",
		limit=1,
	)
	if existing and flt(existing[0].base) == flt(base):
		return ("inalterado", v.get("name"))

	# Effective date of the assignment. The FIRST SSA must start at the employee's
	# date_of_joining so the joining-month salary slip can be generated; later changes
	# (raises) take effect at the change date passed in (today). It can never be before
	# the joining date — ERPNext rejects an SSA from_date earlier than date_of_joining.
	doj, company = frappe.db.get_value("Employee", funcionario, ["date_of_joining", "company"])
	efetiva = from_date if existing else (doj or from_date)
	if doj and getdate(efetiva) < getdate(doj):
		efetiva = doj

	dup = frappe.db.exists("Salary Structure Assignment", {
		"employee": funcionario,
		"salary_structure": estrutura,
		"from_date": efetiva,
		"docstatus": ["<", 2],
	})
	# Payroll Payable account comes from SIGOS Settings (falls back to the company
	# default when left blank). Drives the credit side of the salary slip's accounting.
	conta_pagar = frappe.db.get_single_value("SIGOS Settings", "payroll_payable_account")

	if dup:
		ssa = frappe.get_doc("Salary Structure Assignment", dup)
		if ssa.docstatus == 0:
			ssa.base = base
			if conta_pagar:
				ssa.payroll_payable_account = conta_pagar
			ssa.save(ignore_permissions=True)
			ssa.submit()
			return ("actualizado", v.get("name"))
		return ("ignorado", _("{0}: já existe SSA submetida em {1}").format(v.get("name"), efetiva))

	ssa = frappe.get_doc({
		"doctype": "Salary Structure Assignment",
		"employee": funcionario,
		"salary_structure": estrutura,
		"from_date": efetiva,
		"base": base,
		"company": company,
		"custom_project": v.get("projecto"),
		"custom_cliente": v.get("cliente"),
	})
	if conta_pagar:
		ssa.payroll_payable_account = conta_pagar
	ssa.insert(ignore_permissions=True)
	ssa.submit()
	return ("atribuido", v.get("name"))


@frappe.whitelist()
def aplicar_salario_base(project=None, vigilante=None, vigilantes=None, silent=False):
	"""
	Assign the resolved base salary to the Salary Structure Assignment of every
	active vigilante on a contract (Project), a single vigilante, or an explicit
	list of vigilantes. Used by the Project button (bulk), onboarding (single,
	silent), and the Ajuste de Salários page (filtered bulk). Idempotent.
	"""
	from frappe.utils import today
	import json as _json

	estrutura = frappe.db.get_single_value("SIGOS Settings", "estrutura_salarial_padrao")
	if not estrutura:
		if silent:
			return {}
		frappe.throw(_(
			"Defina a <b>Estrutura Salarial Padrão</b> em SIGOS Settings antes de "
			"atribuir o salário base."
		), title=_("Estrutura Salarial em Falta"))

	if isinstance(vigilantes, str):
		vigilantes = _json.loads(vigilantes) if vigilantes else None

	if vigilantes:
		filters = {"name": ["in", vigilantes]}
	elif vigilante:
		filters = {"name": vigilante}
	elif project:
		filters = {"projecto": project, "status": "Activo"}
	else:
		frappe.throw(_("Indique um contrato (Projecto), um vigilante, ou uma lista de vigilantes."))

	vigs = frappe.get_all(
		"Vigilante",
		filters=filters,
		fields=["name", "funcionario", "projecto", "cliente", "regime_do_vigilante", "salario_base_manual"],
	)

	resumo = {"atribuido": 0, "actualizado": 0, "inalterado": 0, "ignorado": 0}
	ignorados = []
	for v in vigs:
		try:
			status, detalhe = _aplicar_salario_base_vigilante(v, estrutura, today())
		except Exception as e:
			status, detalhe = "ignorado", _("{0}: erro — {1}").format(v.get("name"), e)
			frappe.log_error(f"aplicar_salario_base {v.get('name')}: {e}", "SIGOS Salario Base")
		resumo[status] = resumo.get(status, 0) + 1
		if status == "ignorado":
			ignorados.append(detalhe)

	if not silent:
		msg = _(
			"Salário base — atribuídos: <b>{0}</b> · actualizados: <b>{1}</b> · "
			"inalterados: <b>{2}</b> · ignorados: <b>{3}</b>"
		).format(resumo["atribuido"], resumo["actualizado"], resumo["inalterado"], resumo["ignorado"])
		if ignorados:
			msg += "<br><br>" + "<br>".join(ignorados[:20])
			if len(ignorados) > 20:
				msg += "<br>…"
		frappe.msgprint(msg, title=_("Atribuição de Salário Base"), indicator="blue")

	return resumo


@frappe.whitelist()
def get_ajuste_salarios(filters=None):
	"""
	Filterable/searchable salary-adjustment worklist for HR (Ajuste de Salários
	page): every matching vigilante's CURRENT (latest submitted SSA) base side by
	side with the RESOLVED base (contract/regime + override + floor), so HR can
	see the picture before bulk-applying via `aplicar_salario_base(vigilantes=...)`.

	`stats` are computed over the full status/delegação/regime/etc.-filtered scope
	BEFORE the three so_* view toggles narrow `rows` — so a stat tile's count
	doesn't move when the user clicks it to filter the table by that same tile.
	"""
	import json as _json
	from frappe.utils import flt

	if isinstance(filters, str):
		filters = _json.loads(filters) if filters else {}
	filters = filters or {}

	status = filters.get("status") or "Activo"
	conds = {} if status == "Todos" else {"status": status}
	for campo in ("delegacao", "categoria", "regime_do_vigilante", "posto_de_vigilancia", "projecto"):
		valor = filters.get(campo)
		if valor:
			conds[campo] = valor

	or_filters = None
	texto = (filters.get("search") or "").strip()
	if texto:
		or_filters = [
			["nome_completo", "like", f"%{texto}%"],
			["mecanografico", "like", f"%{texto}%"],
		]

	vigs = frappe.get_all(
		"Vigilante",
		filters=conds,
		or_filters=or_filters,
		fields=["name", "nome_completo", "status", "delegacao", "categoria",
				"regime_do_vigilante", "posto_de_vigilancia", "projecto", "cliente",
				"funcionario", "salario_base_manual"],
		order_by="nome_completo asc",
		limit_page_length=2000,
	)

	funcionarios = [v.funcionario for v in vigs if v.funcionario]
	atual_by_emp = {}
	if funcionarios:
		ssa_rows = frappe.db.sql(
			"""
			SELECT s.employee, s.base
			FROM `tabSalary Structure Assignment` s
			INNER JOIN (
				SELECT employee, MAX(from_date) AS max_date
				FROM `tabSalary Structure Assignment`
				WHERE docstatus = 1 AND employee IN %(funcionarios)s
				GROUP BY employee
			) latest ON latest.employee = s.employee AND latest.max_date = s.from_date
			WHERE s.docstatus = 1
			""",
			{"funcionarios": funcionarios},
			as_dict=True,
		)
		atual_by_emp = {r.employee: flt(r.base) for r in ssa_rows}

	rows = []
	stats = {"total": 0, "sem_salario": 0, "sem_ssa": 0, "com_override": 0, "divergentes": 0}
	for v in vigs:
		atual = atual_by_emp.get(v.funcionario, 0) if v.funcionario else 0
		resolvido = flt(resolver_salario_base(v))
		diferenca = resolvido - atual
		tem_ssa = bool(v.funcionario) and v.funcionario in atual_by_emp
		tem_override = flt(v.salario_base_manual) > 0

		stats["total"] += 1
		if resolvido <= 0:
			stats["sem_salario"] += 1
		if not tem_ssa:
			stats["sem_ssa"] += 1
		if tem_override:
			stats["com_override"] += 1
		if diferenca:
			stats["divergentes"] += 1

		row = dict(v)
		row.update({
			"salario_atual": atual,
			"salario_resolvido": resolvido,
			"diferenca": diferenca,
			"tem_ssa": tem_ssa,
			"tem_override": tem_override,
		})
		rows.append(row)

	if filters.get("so_sem_ssa"):
		rows = [r for r in rows if not r["tem_ssa"]]
	if filters.get("so_com_override"):
		rows = [r for r in rows if r["tem_override"]]
	if filters.get("so_divergentes"):
		rows = [r for r in rows if r["diferenca"]]

	return {"rows": rows, "stats": stats}


@frappe.whitelist()
def definir_salario_base(vigilante, valor=None, usar_contrato=0, confirmar_reducao=0):
	"""
	Set (or clear) a single guard's manual base salary and immediately write the
	resolved base to a new Salary Structure Assignment. Unlike the on-save seed,
	this works for ANY employed guard (Activo/Reserva/Inactivo) — it has no status
	gate. `usar_contrato` clears the manual override so the guard reverts to the
	contract's per-regime base.

	Safety: if the new resolved base is LOWER than the guard's current one, nothing
	is written — the method returns {"requires_confirm": 1, "atual", "novo"} so the
	caller can confirm a pay cut with HR before re-calling with confirmar_reducao=1.
	Otherwise returns {"base", "resumo"}.
	"""
	from frappe.utils import flt

	if not frappe.db.exists("Vigilante", vigilante):
		frappe.throw(_("Vigilante {0} não encontrado.").format(vigilante))

	func = frappe.db.get_value("Vigilante", vigilante, "funcionario")
	if not func:
		frappe.throw(
			_("O vigilante <b>{0}</b> ainda não tem Funcionário associado — admita-o "
			  "pelo RH antes de definir o salário.").format(vigilante),
			title=_("Sem Funcionário"),
		)

	usar_contrato = int(usar_contrato or 0)
	if usar_contrato:
		novo_manual = None
	else:
		novo_manual = flt(valor)
		if novo_manual <= 0:
			frappe.throw(
				_("Indique um salário maior que zero — ou opte por herdar o salário do contrato."),
				title=_("Valor Inválido"),
			)

	# Resolve current vs prospective base WITHOUT mutating anything yet, so a pay
	# cut can be confirmed first. resolver_salario_base accepts a dict, so we mirror
	# the guard's contract/regime with the proposed manual override.
	atual = flt(resolver_salario_base(vigilante))
	proj, regime = frappe.db.get_value(
		"Vigilante", vigilante, ["projecto", "regime_do_vigilante"]
	)
	novo = flt(resolver_salario_base({
		"salario_base_manual": novo_manual,
		"projecto": proj,
		"regime_do_vigilante": regime,
	}))

	if novo < atual and not int(confirmar_reducao or 0):
		return {"requires_confirm": 1, "atual": atual, "novo": novo}

	# permlevel-2 field — set server-side (whitelisted method already trusts the role gate)
	frappe.db.set_value("Vigilante", vigilante, "salario_base_manual", novo_manual)

	resumo = aplicar_salario_base(vigilante=vigilante, silent=True)
	base = resolver_salario_base(vigilante)

	from sigos.timeline import registar
	base_fmt = frappe.format_value(base, {"fieldtype": "Currency"})
	if usar_contrato:
		registar(vigilante, _("Salário base passou a <b>herdar do contrato</b> — base resolvida: <b>{0}</b>").format(base_fmt))
	else:
		registar(vigilante, _("Salário base (manual) definido para <b>{0}</b>").format(base_fmt))

	return {"base": base, "resumo": resumo}


@frappe.whitelist()
def get_employee_hr360(employee):
	"""
	Aggregator for the "Painel RH 360" on the Employee form — default-on for every
	customer (SIGOS Settings.painel_rh_360_activo). Reuses the same canonical
	sources as the rest of SIGOS instead of recomputing anything:
	  - faltas: sigos.utils.calcular_faltas_vigilante / calcular_faltas_detalhado
	    (Vigilante-keyed — same source as the Cumulativo de Faltas report and payroll);
	  - férias: sigos.ferias._saldo, ledger-summed per Leave Type (same source as
	    Pedido De Licenca's consultar_saldo) — never new_leaves_allocated;
	  - salário: resolver_salario_base + the latest submitted Salary Structure
	    Assignment + recent Salary Slips (all core HRMS, keyed on `employee`);
	  - money docs: Outras Deducoes / Emprestimo / Outras Remuneracoes /
	    Reclamacao De Salario — already keyed on Employee via `funcionario`, no
	    vigilante resolution needed for these.
	"""
	from frappe.utils import add_months, flt, get_first_day, get_last_day, getdate, nowdate
	from sigos.ferias import _saldo
	from sigos.utils import calcular_faltas_detalhado, calcular_faltas_vigilante

	emp = frappe.db.get_value(
		"Employee", employee,
		["employee_name", "custom_vigilante", "status"],
		as_dict=True,
	)
	if not emp:
		frappe.throw(_("Employee {0} não encontrado.").format(employee))

	vigilante = emp.custom_vigilante
	today = getdate(nowdate())
	inicio_mes, fim_mes = get_first_day(today), get_last_day(today)

	# ─── Faltas (Vigilante-keyed) ──────────────────────────────────────────────
	faltas = {"mes_atual": 0, "recentes": []}
	if vigilante:
		faltas["mes_atual"] = calcular_faltas_vigilante(vigilante, inicio_mes, fim_mes)
		detalhe = calcular_faltas_detalhado(vigilante, add_months(today, -3), today)
		faltas["recentes"] = list(reversed(detalhe))[:15]

	# ─── Férias (ledger-correct, per Leave Type the employee actually holds) ───
	ferias = []
	for a in frappe.get_all(
		"Leave Allocation",
		filters={"employee": employee, "docstatus": 1, "to_date": [">=", today]},
		fields=["leave_type"],
		distinct=True,
	):
		ferias.append({"leave_type": a.leave_type, "saldo": flt(_saldo(employee, a.leave_type, today))})

	# ─── Salário ────────────────────────────────────────────────────────────────
	ssa_atual = frappe.get_all(
		"Salary Structure Assignment",
		filters={"employee": employee, "docstatus": 1},
		fields=["name", "salary_structure", "base", "from_date"],
		order_by="from_date desc",
		limit=1,
	)
	salario = {
		"base_resolvida": flt(resolver_salario_base(vigilante)) if vigilante else 0,
		"ssa_atual": ssa_atual[0] if ssa_atual else None,
		"slips_recentes": frappe.get_all(
			"Salary Slip",
			filters={"employee": employee, "docstatus": 1},
			fields=["name", "start_date", "end_date", "gross_pay", "total_deduction", "net_pay"],
			order_by="start_date desc",
			limit=6,
		),
	}

	# ─── Money docs (already Employee-keyed via `funcionario`) ─────────────────
	deducoes = frappe.get_all(
		"Outras Deducoes",
		filters={"funcionario": employee, "docstatus": ["<", 2], "estado": "Activo"},
		fields=["name", "tipo", "valor_a_pagar", "valor_mensal", "meses_a_pagar",
				"data_de_inicio", "data_de_fim", "estado", "docstatus"],
		order_by="data_de_inicio desc",
	)
	emprestimos = frappe.get_all(
		"Emprestimo",
		filters={"funcionario": employee, "docstatus": ["<", 2], "estado": "Activo"},
		fields=["name", "valor_a_pagar", "valor_mensal", "meses_a_pagar",
				"data_de_inicio", "data_de_fim", "estado", "docstatus"],
		order_by="data_de_inicio desc",
	)
	remuneracoes = frappe.get_all(
		"Outras Remuneracoes",
		filters={"funcionario": employee, "docstatus": ["<", 2]},
		fields=["name", "tipo_de_subsidios", "valor_a_pagar", "valor_mensal",
				"mes_referencia", "docstatus"]
				+ (["workflow_state"] if frappe.get_meta("Outras Remuneracoes").has_field("workflow_state") else []),
		order_by="creation desc",
		limit=10,
	)
	reclamacoes = frappe.get_all(
		"Reclamacao De Salario",
		filters={"funcionario": employee, "docstatus": ["<", 2]},
		fields=["name", "mes_a_ser_pago", "valor_a_reclamar", "motivo", "docstatus"]
				+ (["workflow_state"] if frappe.get_meta("Reclamacao De Salario").has_field("workflow_state") else []),
		order_by="creation desc",
		limit=10,
	)

	return {
		"employee": employee,
		"employee_name": emp.employee_name,
		"vigilante": vigilante,
		"faltas": faltas,
		"ferias": ferias,
		"salario": salario,
		"deducoes": deducoes,
		"emprestimos": emprestimos,
		"remuneracoes": remuneracoes,
		"reclamacoes": reclamacoes,
	}


@frappe.whitelist()
def get_employee_disciplinar(employee):
	"""
	Disciplinar summary for the Diretório de Colaboradores page — Processo
	Disciplinar + Participação, both Vigilante-keyed, resolved through the
	Employee's linked Vigilante (same resolution as get_employee_hr360). Kept as
	a separate call so get_employee_hr360's contract (already used by the
	shipped Employee "Painel RH 360" panel) doesn't change.
	"""
	vigilante = frappe.db.get_value("Employee", employee, "custom_vigilante")
	if not vigilante:
		return {"vigilante": None, "processos": [], "participacoes": []}

	processos = frappe.get_all(
		"Processo Disciplinar",
		filters={"vigilante": vigilante, "docstatus": ["<", 2]},
		fields=["name", "data", "gravidade", "motivo", "decisao", "valor_a_pagar", "docstatus"],
		order_by="data desc",
		limit=15,
	)
	participacoes = frappe.get_all(
		"Participacao",
		filters={"vigilante": vigilante, "docstatus": ["<", 2]},
		fields=["name", "data", "gravidade", "tipo_de_infracao", "relato", "docstatus"],
		order_by="data desc",
		limit=15,
	)
	return {"vigilante": vigilante, "processos": processos, "participacoes": participacoes}


@frappe.whitelist()
def get_employee_directory(filters=None):
	"""
	Lightweight, filterable/searchable Employee list for the Diretório de
	Colaboradores page. Deliberately does NO per-row aggregation — faltas/férias/
	salário/disciplinar are fetched only for the SELECTED employee (via
	get_employee_hr360 / get_employee_disciplinar), so this stays fast at any
	headcount instead of running N queries for N employees.
	"""
	import json as _json

	if isinstance(filters, str):
		filters = _json.loads(filters) if filters else {}
	filters = filters or {}

	conds = {}
	for campo in ("status", "custom_posto", "custom_regime", "custom_categoria", "custom_cliente"):
		valor = filters.get(campo.replace("custom_", ""))
		if valor:
			conds[campo] = valor

	or_filters = None
	texto = (filters.get("search") or "").strip()
	if texto:
		or_filters = [
			["employee_name", "like", f"%{texto}%"],
			["custom_mecanografico", "like", f"%{texto}%"],
		]

	return frappe.get_all(
		"Employee",
		filters=conds,
		or_filters=or_filters,
		fields=["name", "employee_name", "status",
				"custom_posto", "custom_regime", "custom_categoria", "custom_cliente", "image"],
		order_by="employee_name asc",
		limit_page_length=500,
	)


@frappe.whitelist()
def enviar_posto_para_reserva(posto, motivo):
	"""
	Bench every Activo guard at a (closing) posto: creates + submits a RES rotatividade
	per guard (status -> Reserva, posto cleared, escala removed), with a shared reason.
	"""
	from frappe.utils import today
	if not (motivo or "").strip():
		frappe.throw(_("Indique o motivo para enviar os vigilantes para reserva."))
	if not frappe.db.exists("Operacao De Rotatividade", "RES"):
		frappe.throw(_("Operação RES (Enviar para Reserva) não encontrada."))

	guards = frappe.get_all("Vigilante", filters={"posto_de_vigilancia": posto, "status": "Activo"}, pluck="name")
	criados = []
	for g in guards:
		v = frappe.db.get_value("Vigilante", g,
			["mecanografico", "delegacao", "regime_do_vigilante", "categoria"], as_dict=True)
		rot = frappe.get_doc({
			"doctype": "Rotatividade", "data": today(),
			"vigilante": g, "abreviatura_op": "RES", "antigo_posto": posto,
			"mecanografico": v.mecanografico, "delegacao": v.delegacao,
			"regime": v.regime_do_vigilante, "categoria_vigilante": v.categoria,
			"motivo": "Reserva", "motivo_rotatividade": motivo,
		})
		rot.insert(ignore_permissions=True)
		rot.submit()
		criados.append(rot.name)

	return {"benched": len(criados), "rotatividades": criados}


@frappe.whitelist()
def encerrar_posto(posto, motivo):
	"""
	Dismantle a posto in one guided action: bench the whole active team to Reserva
	(RES rotatividade per guard) AND inactivate the posto (which archives its escalas).
	Avoids the limbo of an Inactivo posto still holding Activo guards with no schedule.
	"""
	if not (motivo or "").strip():
		frappe.throw(_("Indique o motivo do encerramento do posto."))
	if not frappe.db.exists("Posto De Vigilancia", posto):
		frappe.throw(_("Posto <b>{0}</b> não encontrado.").format(posto))

	# 1. Bench every Activo guard -> Reserva (each RES rotatividade also drops them
	#    from their escala via the keystone). Safe with an empty team (benched = 0).
	resultado = enviar_posto_para_reserva(posto, motivo)

	# 2. Inactivate the posto — _tratar_estado archives any remaining active escalas.
	doc = frappe.get_doc("Posto De Vigilancia", posto)
	if doc.estado != "Inactivo":
		doc.estado = "Inactivo"
		doc.save(ignore_permissions=True)

	arquivadas = frappe.db.count(
		"Escala Do Vigilante", {"posto_de_vigilancia": posto, "estado": "Arquivado"}
	)
	return {
		"benched": resultado["benched"],
		"rotatividades": resultado["rotatividades"],
		"arquivadas": arquivadas,
	}


@frappe.whitelist()
def licencas_na_escala(escala_name):
	"""
	Read-only leave indicator for the escala grid. Returns {"<vig>|<YYYY-MM-DD>":
	"<leave_type>"} for every day a guard in this escala is on an APPROVED leave —
	any Leave Type (férias, doença, sem vencimento, ...), not just férias. It does
	NOT pull the guard off the escala — it only flags the cells. Maps guards ->
	Employees and reads their approved Leave Applications within the escala window.
	"""
	from frappe.utils import getdate, add_days

	datas = frappe.db.sql(
		"""
		SELECT DISTINCT te.vigilante, MIN(te.data) AS de, MAX(te.data) AS ate
		FROM `tabTabela De Escala De Vigilante` te
		WHERE te.parent = %s
		GROUP BY te.vigilante
		""",
		(escala_name,),
		as_dict=True,
	)
	if not datas:
		return {}

	vigs = [r.vigilante for r in datas if r.vigilante]
	de = min(getdate(r.de) for r in datas)
	ate = max(getdate(r.ate) for r in datas)

	# Guard -> Employee (and reverse) — only guards that have an Employee.
	pares = frappe.get_all(
		"Vigilante", filters={"name": ["in", vigs]},
		fields=["name", "funcionario"],
	)
	emp_de_vig = {p.name: p.funcionario for p in pares if p.funcionario}
	if not emp_de_vig:
		return {}
	vig_de_emp = {emp: vig for vig, emp in emp_de_vig.items()}

	apps = frappe.get_all(
		"Leave Application",
		filters={
			"employee": ["in", list(emp_de_vig.values())],
			"status": "Approved",
			"docstatus": 1,
			"from_date": ["<=", ate],
			"to_date": [">=", de],
		},
		fields=["employee", "leave_type", "from_date", "to_date"],
	)

	marcas = {}
	for a in apps:
		vig = vig_de_emp.get(a.employee)
		if not vig:
			continue
		d = max(getdate(a.from_date), de)
		fim = min(getdate(a.to_date), ate)
		while d <= fim:
			# If a guard somehow has two overlapping approved leaves the same day,
			# the last one read just wins — not expected in practice.
			marcas[f"{vig}|{d.isoformat()}"] = a.leave_type
			d = getdate(add_days(d, 1))
	return marcas
