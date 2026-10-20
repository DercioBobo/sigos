"""
Abandono de Posto — detection of guards absent for N consecutive calendar days.

A streak is read from the guard's own escala (Tabela De Escala De Vigilante),
walking BACKWARDS from yesterday over their WORKING days (folgas skipped):
  - an unexcused absence (Falta / Falta de Reserva / Abandono de Posto row with
    no tipo_justificacao, not covered by a submitted Justificacao De Faltas)
    extends the streak — the turno weight (n_de_faltas) is deliberately ignored,
    a day is a day;
  - approved leave (Leave Application) or a Licença/Suspensão row is neutral —
    it neither breaks the streak nor counts towards it;
  - anything else (no absence recorded = worked, or a justified falta) ends it.
The streak length is in CALENDAR days from its first falta through yesterday
(folgas included, leave days excluded).

Settings (SIGOS Settings): abandono_modo (Desactivado / Apenas Alerta /
Automático), abandono_dias_limite (15). Alert always fires once per streak
(Notification Log = the desk bell, same as the temporary-posto expiry warning)
and stamps Vigilante.abandono_detectado_em/abandono_primeira_falta, which drive
the form banner. Automático additionally applies an ABP Rotatividade (the same
operation the banner's button opens in the wizard), without a substituto.

While a guard IS in Abandono de Posto, registar_ausencias_abandono (daily) files
one "Ausência em Abandono" Ausencias row per calendar day. abandono_desconto
decides how payroll charges those days: as 1 falta each ("Faltas", default) or
as unpaid days in the Proporcional ("Dias não remunerados") — never both. A
return with a justification files a Justificacao De Faltas over the episode,
which pardons the days in either mode.
"""

import frappe
from frappe import _
from collections import defaultdict

from frappe.utils import add_days, cint, date_diff, getdate, today

OPERACAO_ABANDONO = "ABP"
ESTADO_ABANDONO = "Abandono de Posto"
# Generated daily for guards in the estado above (Ausencias tipo_de_registo AND
# Tabela Ausencia tipo_de_ausencia) — NOT the older "Abandono de Posto" row type,
# which is a guard who left mid-shift.
TIPO_AUSENCIA_EM_ABANDONO = "Ausência em Abandono"

# Tabela Ausencia.tipo_de_ausencia values. TIPO_AUSENCIA_EM_ABANDONO is deliberately
# absent: those days were already acted on (the guard was marked), so after a
# return they count as "presente" and a new streak starts from zero.
_TIPOS_AUSENTE = ("Falta", "Falta de Reserva", "Abandono de Posto")
_TIPOS_NEUTROS = ("Licença", "Suspensão")

# Only guards that can actually be "on a posto" are watched.
_ESTADOS_VIGIADOS = ("Activo", "Reserva")

_PAPEIS_ALERTA = ("SIGOS Manager", "Aprovador Operações", "Operações SIGOS")


def _modo():
	return frappe.db.get_single_value("SIGOS Settings", "abandono_modo") or "Apenas Alerta"


def _dias_limite():
	return cint(frappe.db.get_single_value("SIGOS Settings", "abandono_dias_limite")) or 15


# SIGOS Settings.abandono_desconto — what happens to each day a guard spends in
# Abandono de Posto (daily rows and/or payroll):
DESCONTO_FALTAS = "Faltas"                                                 # rows, 1 falta each
DESCONTO_DIAS = "Dias não remunerados"                                     # rows (0 faltas) + unpaid days
DESCONTO_DIAS_SEM_REGISTO = "Dias não remunerados (sem registo de ausências)"  # unpaid days only
DESCONTO_NENHUM = "Nenhum (sem registo nem desconto)"                      # nothing


def _desconto():
	return frappe.db.get_single_value("SIGOS Settings", "abandono_desconto") or DESCONTO_FALTAS


def abandono_conta_faltas():
	"""Each "Ausência em Abandono" row is 1 falta (otherwise 0 — a record only)."""
	return _desconto() == DESCONTO_FALTAS


def abandono_regista_ausencias():
	"""The daily job files "Ausência em Abandono" rows at all."""
	return _desconto() in (DESCONTO_FALTAS, DESCONTO_DIAS)


def abandono_dias_nao_remunerados():
	"""Payroll charges the Abandono window as unpaid days (salary_slip_hooks._dias_abandono)."""
	return _desconto() in (DESCONTO_DIAS, DESCONTO_DIAS_SEM_REGISTO)


def descricao_desconto():
	"""Plain-language effect of the current mode — banner, preview, wizard."""
	return {
		DESCONTO_FALTAS: _("cada dia é registado como ausência e descontado como 1 falta"),
		DESCONTO_DIAS: _("cada dia é registado como ausência e descontado como dia não remunerado"),
		DESCONTO_DIAS_SEM_REGISTO: _("cada dia é descontado como dia não remunerado (sem registo de ausências)"),
		DESCONTO_NENHUM: _("sem registo de ausências nem desconto no salário"),
	}.get(_desconto(), _("cada dia é registado como ausência e descontado como 1 falta"))


@frappe.whitelist()
def resumo_desconto():
	return descricao_desconto()


# ─── Streak computation ─────────────────────────────────────────────────────────

def calcular_sequencia_ausencia(vigilante, ate=None, desde=None):
	"""
	Current unbroken absence streak for a guard, ending at `ate` (default:
	yesterday — today's sheets may not be filed yet). Returns
	{"inicio": date|None, "dias": int, "ultima_falta": date|None}.

	`desde` widens the lookback (e.g. the stored abandono_primeira_falta) —
	otherwise it covers the limit plus a month, which the escala's own
	keep-buffer (manter_meses_passados) normally still holds.
	"""
	ate = getdate(ate) if ate else getdate(add_days(today(), -1))
	inicio_janela = getdate(add_days(ate, -(_dias_limite() + 31)))
	if desde and getdate(desde) < inicio_janela:
		inicio_janela = getdate(desde)

	vazio = {"inicio": None, "dias": 0, "ultima_falta": None}

	dias_trabalho = _dias_de_trabalho(vigilante, inicio_janela, ate)
	if not dias_trabalho:
		return vazio

	classe = _classificar_ausencias(vigilante, inicio_janela, ate)
	neutros = _dias_de_licenca(vigilante, inicio_janela, ate)
	justificados = dias_justificados(vigilante, inicio_janela, ate)

	inicio = ultima = None
	for d in sorted(dias_trabalho, reverse=True):
		if d in neutros or classe.get(d) == "neutro":
			continue
		if classe.get(d) == "falta" and d not in justificados:
			inicio = d
			ultima = ultima or d
			continue
		break  # worked (nothing recorded) or justified — streak ends here

	if not inicio:
		return vazio

	neutros |= {d for d, c in classe.items() if c == "neutro"}
	licenca_no_periodo = sum(1 for d in neutros if inicio <= d <= ate)
	return {
		"inicio": inicio,
		"dias": max(0, date_diff(ate, inicio) + 1 - licenca_no_periodo),
		"ultima_falta": ultima,
	}


def _dias_de_trabalho(vigilante, de, ate):
	"""Dates the guard was scheduled to WORK (any escala, folga turnos excluded)."""
	from sigos.utils import _folga_turnos

	rows = frappe.db.sql(
		"""
		SELECT te.data, te.turno, te.regime
		FROM `tabTabela De Escala De Vigilante` te
		WHERE te.vigilante = %(v)s AND te.data BETWEEN %(de)s AND %(ate)s
		""",
		{"v": vigilante, "de": de, "ate": ate},
		as_dict=True,
	)
	folgas = {}
	dias = set()
	for r in rows:
		if r.regime not in folgas:
			folgas[r.regime] = _folga_turnos(r.regime)
		if r.turno and r.turno in folgas[r.regime]:
			continue
		dias.add(getdate(r.data))
	return dias


def _classificar_ausencias(vigilante, de, ate):
	"""{date: "falta" | "neutro" | "presente"} from SUBMITTED Ausencias rows.
	A day with several rows takes the strongest signal: presente (e.g. a justified
	falta, an Atraso) > neutro > falta."""
	rows = frappe.db.sql(
		"""
		SELECT a.data, ta.tipo_de_ausencia, ta.tipo_justificacao
		FROM `tabTabela Ausencia` ta
		JOIN `tabAusencias` a ON a.name = ta.parent
		WHERE a.docstatus = 1 AND ta.vigilante = %(v)s AND a.data BETWEEN %(de)s AND %(ate)s
		""",
		{"v": vigilante, "de": de, "ate": ate},
		as_dict=True,
	)
	peso = {"falta": 0, "neutro": 1, "presente": 2}
	out = {}
	for r in rows:
		if r.tipo_de_ausencia in _TIPOS_NEUTROS:
			c = "neutro"
		elif r.tipo_de_ausencia in _TIPOS_AUSENTE and not r.tipo_justificacao:
			c = "falta"
		else:
			c = "presente"
		d = getdate(r.data)
		if d not in out or peso[c] > peso[out[d]]:
			out[d] = c
	return out


def _expandir(intervalos, de, ate):
	dias = set()
	for ini, fim in intervalos:
		if not (ini and fim):
			continue
		d, f = max(getdate(ini), de), min(getdate(fim), ate)
		while d <= f:
			dias.add(d)
			d = getdate(add_days(d, 1))
	return dias


def _dias_de_licenca(vigilante, de, ate):
	"""Days covered by an APPROVED Leave Application (any Leave Type)."""
	emp = frappe.db.get_value("Vigilante", vigilante, "funcionario")
	if not emp:
		return set()
	apps = frappe.get_all(
		"Leave Application",
		filters={
			"employee": emp, "status": "Approved", "docstatus": 1,
			"from_date": ["<=", ate], "to_date": [">=", de],
		},
		fields=["from_date", "to_date"],
	)
	return _expandir([(a.from_date, a.to_date) for a in apps], de, ate)


def dias_justificados(vigilante, de, ate):
	"""Days covered by a submitted (and, with a workflow, approved) Justificacao De
	Faltas — a justified absence is not abandonment, so it breaks the streak; also
	the days pardoned out of the unpaid Abandono window (salary_slip_hooks)."""
	from sigos.payroll_ext.salary_slip_hooks import _aprovado_filter

	de, ate = getdate(de), getdate(ate)
	filters = {
		"vigilante": vigilante, "docstatus": 1,
		"dia_de_inicio": ["<=", ate], "dia_de_fim": [">=", de],
	}
	filters.update(_aprovado_filter("Justificacao De Faltas"))
	docs = frappe.get_all(
		"Justificacao De Faltas", filters=filters, fields=["dia_de_inicio", "dia_de_fim"],
	)
	return _expandir([(j.dia_de_inicio, j.dia_de_fim) for j in docs], de, ate)


# ─── Daily job ──────────────────────────────────────────────────────────────────

def verificar_abandonos():
	"""Daily (sigos.tasks.daily): detect, alert, and — in Automático — mark."""
	modo = _modo()
	if modo == "Desactivado":
		return

	limite = _dias_limite()
	ontem = getdate(add_days(today(), -1))

	# Candidates: watched guards with an unexcused absence in the last two weeks
	# (any regime has a working day in that span), plus anyone already flagged —
	# so a broken streak clears its banner.
	recentes = frappe.db.sql(
		"""
		SELECT DISTINCT ta.vigilante
		FROM `tabTabela Ausencia` ta
		JOIN `tabAusencias` a ON a.name = ta.parent
		WHERE a.docstatus = 1 AND a.data BETWEEN %(de)s AND %(ate)s
		  AND ta.tipo_de_ausencia IN %(tipos)s
		""",
		{"de": add_days(ontem, -14), "ate": ontem, "tipos": _TIPOS_AUSENTE},
		pluck=True,
	)
	sinalizados = frappe.get_all(
		"Vigilante", filters={"abandono_detectado_em": ["is", "set"]}, pluck="name"
	)
	nomes = set(recentes) | set(sinalizados)
	if not nomes:
		return

	vigilantes = frappe.get_all(
		"Vigilante",
		filters={"name": ["in", list(nomes)]},
		fields=["name", "nome_completo", "status", "posto_de_vigilancia",
			"abandono_detectado_em", "abandono_primeira_falta"],
	)
	for v in vigilantes:
		try:
			_processar(v, modo, limite, ontem)
			frappe.db.commit()
		except Exception as ex:
			frappe.db.rollback()
			frappe.log_error(
				f"Erro ao verificar abandono de posto de {v.name}: {ex}", "SIGOS Abandono de Posto"
			)


def _processar(v, modo, limite, ontem):
	if v.status not in _ESTADOS_VIGIADOS:
		# Already marked (or left) — the flag has done its job; keep the history
		# on abandono_primeira_falta, just stop treating it as a pending alert.
		if v.abandono_detectado_em and v.status != ESTADO_ABANDONO:
			_limpar_sinal(v.name)
		return

	info = calcular_sequencia_ausencia(v.name, ontem, desde=v.abandono_primeira_falta)
	if info["dias"] < limite:
		if v.abandono_detectado_em:
			_limpar_sinal(v.name)
		return

	if not v.abandono_detectado_em:
		frappe.db.set_value("Vigilante", v.name, {
			"abandono_detectado_em": today(),
			"abandono_primeira_falta": info["inicio"],
		}, update_modified=False)
		_notificar(v, info, modo)
		from sigos.timeline import registar
		registar(v.name, _(
			"<b>Possível Abandono de Posto</b> — {0} dias seguidos de ausência desde {1}."
		).format(info["dias"], frappe.format_value(info["inicio"], {"fieldtype": "Date"})))

	if modo == "Automático":
		# Keep the alert even if the marking below fails (it's retried tomorrow,
		# without re-notifying — abandono_detectado_em is already stamped).
		frappe.db.commit()
		try:
			marcar_abandono(
				v.name,
				_("Marcado automaticamente: {0} dias seguidos de ausência desde {1} "
				  "(limite: {2}).").format(
					info["dias"], frappe.format_value(info["inicio"], {"fieldtype": "Date"}), limite),
			)
		except Exception as ex:
			frappe.db.rollback()
			frappe.log_error(
				f"Erro ao marcar automaticamente {v.name} em Abandono de Posto: {ex}",
				"SIGOS Abandono de Posto",
			)


def _limpar_sinal(vigilante):
	frappe.db.set_value("Vigilante", vigilante, {
		"abandono_detectado_em": None,
		"abandono_primeira_falta": None,
	}, update_modified=False)


def _destinatarios():
	users = frappe.get_all(
		"Has Role",
		filters={"role": ["in", list(_PAPEIS_ALERTA)], "parenttype": "User"},
		pluck="parent",
	)
	activos = set(frappe.get_all("User", filters={"enabled": 1}, pluck="name"))
	return [u for u in set(users) if u in activos and u not in ("Administrator", "Guest")]


def _notificar(v, info, modo):
	nome = v.nome_completo or v.name
	accao = (
		_("O vigilante foi marcado automaticamente em Abandono de Posto (Rotatividade ABP) — "
		  "atribua um substituto ao posto.")
		if modo == "Automático"
		else _("Abra o vigilante e use <b>Marcar Abandono de Posto</b> para o retirar do "
			   "posto e escolher um substituto.")
	)
	for user in _destinatarios():
		frappe.get_doc({
			"doctype": "Notification Log",
			"subject": _("Abandono de Posto: {0} — {1} dias seguidos ausente").format(nome, info["dias"]),
			"email_content": _(
				"<b>{0}</b> ({1}) está ausente há <b>{2}</b> dias seguidos, desde {3} "
				"(posto: {4}). {5}"
			).format(
				nome, v.name, info["dias"],
				frappe.format_value(info["inicio"], {"fieldtype": "Date"}),
				v.posto_de_vigilancia or "—", accao,
			),
			"for_user": user,
			"type": "Alert",
			"document_type": "Vigilante",
			"document_name": v.name,
		}).insert(ignore_permissions=True)


# ─── Marking (Automático mode) ──────────────────────────────────────────────────

def marcar_abandono(vigilante, motivo, data=None):
	"""Apply an ABP Rotatividade (no substituto) — the same operation the form's
	banner opens in the wizard, so both paths share Rotatividade.on_submit. Returns
	the Rotatividade name."""
	if not frappe.db.exists("Operacao De Rotatividade", OPERACAO_ABANDONO):
		frappe.throw(_("Operação {0} (Abandono de Posto) não encontrada.").format(OPERACAO_ABANDONO))

	v = frappe.db.get_value(
		"Vigilante", vigilante,
		["mecanografico", "delegacao", "regime_do_vigilante", "categoria", "posto_de_vigilancia"],
		as_dict=True,
	)
	rot = frappe.get_doc({
		"doctype": "Rotatividade", "data": data or today(),
		"vigilante": vigilante, "abreviatura_op": OPERACAO_ABANDONO,
		"antigo_posto": v.posto_de_vigilancia,
		"mecanografico": v.mecanografico, "delegacao": v.delegacao,
		"regime": v.regime_do_vigilante, "categoria_vigilante": v.categoria,
		"alocar_vigilante_substituto": "Não",
		"motivo": "Disciplinar", "motivo_rotatividade": motivo,
	})
	rot.insert(ignore_permissions=True)
	rot.submit()
	return rot.name


@frappe.whitelist()
def sequencia_vigilante(vigilante):
	"""Live streak for the Vigilante banner (read-only)."""
	frappe.has_permission("Vigilante", "read", doc=vigilante, throw=True)
	desde = frappe.db.get_value("Vigilante", vigilante, "abandono_primeira_falta")
	info = calcular_sequencia_ausencia(vigilante, desde=desde)
	info["limite"] = _dias_limite()
	info["modo"] = _modo()
	return info


# ─── Daily "Ausência em Abandono" rows ──────────────────────────────────────────

def registar_ausencias_abandono(vigilantes=None, em_lote=True):
	"""
	File one "Ausência em Abandono" row per calendar day (folgas included, each
	counting 1) for every guard in Abandono de Posto, from data_inicio_abandono
	through yesterday — or data_fim_abandono once they've returned/been dismissed,
	so the last days still get filed after the window closes. Idempotent catch-up:
	a day that already has any active row for the guard (or a CANCELLED generated
	one — cancelling is how a wrong day is removed for good) is skipped, as are
	approved-leave days. One submitted Ausencias per (grupo de delegados, day).

	`em_lote` (the daily job): commit per sheet, roll back + log on failure.
	Inline (Registar Regresso): no commits — the caller's request owns the
	transaction; failures are logged and returned, never block the caller.
	"""
	if not abandono_regista_ausencias():
		return {"criadas": [], "erros": [], "sem_grupo": []}

	ontem = getdate(add_days(today(), -1))
	cond = ""
	params = {"estado": ESTADO_ABANDONO, "recente": add_days(ontem, -31)}
	if vigilantes:
		cond = " AND name IN %(nomes)s"
		params["nomes"] = tuple(vigilantes)
	vigs = frappe.db.sql(
		f"""
		SELECT name, nome_completo, mecanografico, delegacao, funcionario,
		       data_inicio_abandono, data_fim_abandono
		FROM `tabVigilante`
		WHERE data_inicio_abandono IS NOT NULL
		  AND (status = %(estado)s OR data_fim_abandono >= %(recente)s) {cond}
		""",
		params,
		as_dict=True,
	)

	pendentes = defaultdict(list)  # (grupo, data) -> [vigilante rows]
	grupos = {}
	sem_grupo = []
	for v in vigs:
		ini = getdate(v.data_inicio_abandono)
		fim = min(getdate(v.data_fim_abandono), ontem) if v.data_fim_abandono else ontem
		saida = frappe.db.get_value("Employee", v.funcionario, "relieving_date") if v.funcionario else None
		if saida:
			fim = min(fim, getdate(saida))
		if ini > fim:
			continue

		if v.delegacao not in grupos:
			grupos[v.delegacao] = _grupo_de(v.delegacao)
		grupo = grupos[v.delegacao]
		if not grupo:
			sem_grupo.append(v.name)
			continue

		ocupados = {getdate(d) for d in frappe.db.sql(
			"""
			SELECT DISTINCT a.data
			FROM `tabTabela Ausencia` ta
			JOIN `tabAusencias` a ON a.name = ta.parent
			WHERE ta.vigilante = %(v)s AND a.data BETWEEN %(ini)s AND %(fim)s
			  AND (a.docstatus < 2 OR ta.tipo_de_ausencia = %(tipo)s)
			""",
			{"v": v.name, "ini": ini, "fim": fim, "tipo": TIPO_AUSENCIA_EM_ABANDONO},
			pluck=True,
		)}
		ocupados |= _dias_de_licenca(v.name, ini, fim)

		d = ini
		while d <= fim:
			if d not in ocupados:
				pendentes[(grupo, d)].append(v)
			d = getdate(add_days(d, 1))

	if sem_grupo:
		frappe.log_error(
			"Vigilantes em Abandono de Posto sem Grupo De Delegados para a sua delegação "
			f"— ausências diárias não registadas: {', '.join(sem_grupo)}",
			"SIGOS Abandono de Posto",
		)

	criadas, erros = [], []
	for (grupo, d), vs in sorted(pendentes.items(), key=lambda kv: (kv[0][1], kv[0][0])):
		try:
			criadas.append(_criar_folha_abandono(grupo, d, vs))
			if em_lote:
				frappe.db.commit()
		except Exception as ex:
			if em_lote:
				frappe.db.rollback()
			erros.append(str(d))
			frappe.log_error(
				f"Erro ao registar Ausência em Abandono ({grupo}, {d}): {ex}", "SIGOS Abandono de Posto"
			)
	return {"criadas": criadas, "erros": erros, "sem_grupo": sem_grupo}


def _grupo_de(delegacao):
	if not delegacao:
		return None
	grupos = frappe.get_all(
		"Grupo Delegados Item", filters={"delegacao": delegacao}, pluck="parent", limit=1
	)
	return grupos[0] if grupos else None


def _criar_folha_abandono(grupo, data, vigilantes):
	doc = frappe.get_doc({
		"doctype": "Ausencias",
		"data": data,
		"periodo": "Único",
		"grupo_delegados": grupo,
		"tipo_de_registo": TIPO_AUSENCIA_EM_ABANDONO,
	})
	for v in vigilantes:
		doc.append("tabela_ausencia", {
			"vigilante": v.name,
			"nome_do_vigilante": v.nome_completo,
			"mecanografico": v.mecanografico,
			"delegacao": v.delegacao,
			"periodo": "Único",
			"tipo_de_ausencia": TIPO_AUSENCIA_EM_ABANDONO,
			"jutificativo": _("Abandono de Posto desde {0}").format(
				frappe.format_value(v.data_inicio_abandono, {"fieldtype": "Date"})),
		})
	doc.insert(ignore_permissions=True)
	doc.submit()
	return doc.name


# ─── Return with justification (pardon) ─────────────────────────────────────────

def justificar_abandono(vigilante, de, ate, justificativo=None, observacoes=None):
	"""
	Pardon an Abandono episode: a Justificacao De Faltas over [de, ate] (normally
	from the streak's first falta to the day before the return). It clears the
	faltas in "Faltas" mode (salary_slip_hooks._compute_justificadas) and the
	unpaid days in "Dias não remunerados" mode (_dias_abandono), and breaks the
	streak. Submitted directly when the user may submit Justificações and no
	workflow is active; otherwise left as a draft for RH. Returns
	{"name", "submetida"} or None when there's nothing to justify.
	"""
	from sigos.api import has_active_workflow

	de, ate = getdate(de), getdate(ate)
	if de > ate:
		return None
	# Every day up to `ate` must already have its row, or the justification's
	# numero (recomputed from the rows) would come out short.
	registar_ausencias_abandono([vigilante], em_lote=False)

	doc = frappe.get_doc({
		"doctype": "Justificacao De Faltas",
		"naming_series": "JF-.YY.-.##",
		"vigilante": vigilante,
		"funcionario": frappe.db.get_value("Vigilante", vigilante, "funcionario"),
		"data_do_justificativo": today(),
		"dia_de_inicio": de,
		"dia_de_fim": ate,
		"dias_a_justificar": date_diff(ate, de) + 1,
		"justificativo": justificativo,
		"observacoes": observacoes or _("Justificação do Abandono de Posto (registada no regresso)."),
	})
	doc.insert(ignore_permissions=True)
	submeter = (
		not has_active_workflow("Justificacao De Faltas")
		and frappe.has_permission("Justificacao De Faltas", "submit")
	)
	if submeter:
		doc.submit()
	return {"name": doc.name, "submetida": submeter}
