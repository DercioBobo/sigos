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
	Return Activo reserve-pool vigilantes (Categoria pode_ser_substituto = 1) that are
	NOT already committed to an active escala. Used by the Escala 'Alocar Reservas' dialog.
	"""
	cats = frappe.get_all(
		"Categoria Vigilante", filters={"pode_ser_substituto": 1}, pluck="name"
	)
	if not cats:
		return []

	ocupados = set(_vigilantes_com_escala_futura(excluir_escala=excluir_escala))

	filters = {"status": "Activo", "categoria": ["in", cats]}
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
	Frappe link search for vigilante_substituto.
	Only returns Vigilantes whose Categoria Vigilante has pode_ser_substituto = 1.
	"""
	import json
	if isinstance(filters, str):
		filters = json.loads(filters)

	delegacao = filters.get("delegacao") or ""
	excluir   = filters.get("excluir")   or ""

	cats = frappe.get_all(
		"Categoria Vigilante",
		filters={"pode_ser_substituto": 1},
		pluck="name",
	)
	if not cats:
		return []

	delegacao_sql = "AND v.delegacao = %(delegacao)s" if delegacao else ""
	excluir_sql   = "AND v.name != %(excluir)s"       if excluir   else ""

	return frappe.db.sql(
		f"""
		SELECT v.name, v.nome_completo, v.categoria
		FROM `tabVigilante` v
		WHERE v.status    = 'Activo'
		  AND v.categoria IN %(cats)s
		  AND (v.name LIKE %(txt)s OR v.nome_completo LIKE %(txt)s)
		  {delegacao_sql}
		  {excluir_sql}
		ORDER BY v.nome_completo
		LIMIT %(start)s, %(page_len)s
		""",
		{
			"cats":      tuple(cats),
			"txt":       f"%{txt}%",
			"delegacao": delegacao,
			"excluir":   excluir,
			"start":     start,
			"page_len":  page_len,
		},
	)


@frappe.whitelist()
def get_substitutos_para_wizard(doctype, txt, searchfield, start, page_len, filters):
	"""
	Wizard substituto search: pode_ser_substituto = 1 AND not in another active Escala
	overlapping the given escala's period.
	"""
	import json
	if isinstance(filters, str):
		filters = json.loads(filters)

	escala_name = filters.get("escala_name") or ""
	excluir     = filters.get("excluir")     or ""

	cats = frappe.get_all(
		"Categoria Vigilante",
		filters={"pode_ser_substituto": 1},
		pluck="name",
	)
	if not cats:
		return []

	# Vigilantes already committed to a future schedule in another active Escala
	ocupados = _vigilantes_com_escala_futura(excluir_escala=escala_name) if escala_name else []

	excluidos = list(set(ocupados + ([excluir] if excluir else [])))
	not_in    = "AND v.name NOT IN %(excluidos)s" if excluidos else ""

	return frappe.db.sql(
		f"""
		SELECT v.name, v.nome_completo, v.categoria
		FROM `tabVigilante` v
		WHERE v.status    = 'Activo'
		  AND v.categoria IN %(cats)s
		  AND (v.name LIKE %(txt)s OR v.nome_completo LIKE %(txt)s)
		  {not_in}
		ORDER BY v.nome_completo
		LIMIT %(start)s, %(page_len)s
		""",
		{
			"cats":      tuple(cats),
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
def get_vigilantes_da_escala(data, periodo, grupo_delegados=None):
	"""
	Return every vigilante expected on shift for data+periodo,
	enriched with posto, turno, regime, delegacao and nome_completo.
	Optionally scoped to the delegacoes in grupo_delegados.
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
			return frappe.db.sql(
				base_sql.format(extra="AND v.delegacao IN %(delegacoes)s"),
				params,
				as_dict=True,
			)

	return frappe.db.sql(base_sql.format(extra=""), params, as_dict=True)


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
			pode = (frappe.db.get_value("Categoria Vigilante", cat_sub, "pode_ser_substituto")
			        or frappe.db.get_value("Categoria Vigilante", cat_vig, "pode_ser_substituto"))
			if not pode:
				out["avisos"].append("Categorias diferentes ({0} vs {1}) e nenhuma autorizada para substituição.".format(cat_vig, cat_sub))
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
		# A substituto is reserve-eligible by categoria and AVAILABLE to deploy — that
		# means a benched guard (status Reserva, the ideal pick) OR a floating reserve-
		# categoria guard (status Activo). We never pull a fixed guard from their posto.
		cats = frappe.get_all("Categoria Vigilante", filters={"pode_ser_substituto": 1}, pluck="name")
		if not cats:
			return []
		params["cats"] = tuple(cats); cond.append("v.categoria IN %(cats)s")
		cond.append("v.status IN ('Reserva', 'Activo')")
	else:
		cond.append("v.status = %(status)s"); params["status"] = status
	if delegacao:
		cond.append("v.delegacao = %(delegacao)s"); params["delegacao"] = delegacao
	if excluir:
		cond.append("v.name != %(excluir)s"); params["excluir"] = excluir
	where = " AND ".join(cond)
	# For substitutos, surface benched guards (Reserva) first — they free no posto.
	order = "FIELD(v.status, 'Reserva') DESC, v.nome_completo" if substituto else "v.nome_completo"
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
