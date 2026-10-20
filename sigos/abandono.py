"""
Abandono de Posto — detection of guards absent for N consecutive days/faltas,
and the Presunção de Abandono that documents it.

A streak is read from the guard's own escala (Tabela De Escala De Vigilante),
walking BACKWARDS from yesterday over their WORKING days (folgas skipped):
  - an unexcused absence (Falta / Falta de Reserva / Abandono de Posto row with
    no tipo_justificacao, not covered by a submitted Justificacao De Faltas)
    extends the streak;
  - approved leave (Leave Application) or a Licença/Suspensão row is neutral —
    it neither breaks the streak nor counts towards it;
  - anything else (no absence recorded = worked, or a justified falta) ends it.
It is measured in calendar days or in turno-weighted faltas
(SIGOS Settings.abandono_criterio) and compared to abandono_dias_limite.

Once over the limit (abandono_modo: Automático = opened by the daily job, the
default; Apenas Alerta = bell + Vigilante banner with a "Criar Presunção"
button) a Presunção De Abandono is opened — from then on it is a known
abandonment and NOTHING more is recorded:
  - evidence = the faltas that reached the limit (late sheets for days BEFORE the
    Presunção are still added while it is "Aberta" — sincronizar_presuncao);
  - the guard goes to status "Abandono de Posto": off posto + escala (the
    vacated turno becomes a Vaga), and no falta can be recorded for them
    (ausencias._validar_periodo_sem_registo);
  - the salary is frozen (Vigilante._congelar_por_estado) and the company does
    not pay from the Presunção date to the day before the return
    (dias_em_abandono → salary_slip_hooks._dias_fora_emprego).
Registar Regresso (previous posto if it still has room / Reserva / new posto)
unfreezes; a justification clears the faltas before the limit and gives back
the férias withheld for them — the frozen period stays unpaid (INSS).
"""

import frappe
from frappe import _
from frappe.utils import add_days, cint, date_diff, getdate, today

ESTADO_ABANDONO = "Abandono de Posto"
DOCTYPE_PRESUNCAO = "Presuncao De Abandono"

# Presunção estados. Only ABERTA keeps adding faltas; the Jurista moving it on
# freezes the evidence.
PRESUNCAO_ABERTA = "Aberta"
PRESUNCAO_EM_ANALISE = "Em Análise"
PRESUNCAO_EM_PROCESSO = "Encaminhada para Processo"
PRESUNCAO_REGRESSOU = "Regressou"
PRESUNCAO_CONCLUIDA = "Concluída"
PRESUNCAO_ARQUIVADA = "Arquivada"
PRESUNCAO_EM_CURSO = (PRESUNCAO_ABERTA, PRESUNCAO_EM_ANALISE, PRESUNCAO_EM_PROCESSO)

# Tabela Ausencia.tipo_de_ausencia values
_TIPOS_AUSENTE = ("Falta", "Falta de Reserva", "Abandono de Posto")
_TIPOS_NEUTROS = ("Licença", "Suspensão")

# Only guards in service are watched.
_ESTADOS_VIGIADOS = ("Activo", "Reserva")

_PAPEIS_ALERTA = ("SIGOS Manager", "Aprovador Operações", "Operações SIGOS", "Aprovador RH", "Jurista")
PAPEIS_CRIAR_PRESUNCAO = ("System Manager", "SIGOS Manager", "Aprovador Operações", "Operações SIGOS")


def _modo():
	return frappe.db.get_single_value("SIGOS Settings", "abandono_modo") or "Automático"


def _dias_limite():
	"""The threshold — calendar days or faltas, per abandono_criterio."""
	return cint(frappe.db.get_single_value("SIGOS Settings", "abandono_dias_limite")) or 15


# SIGOS Settings.abandono_criterio — what the streak is measured in.
CRITERIO_DIAS = "Dias de Calendário"   # a day is a day (folgas included, leave excluded)
CRITERIO_FALTAS = "Nº de Faltas"       # sum of the turno-weighted faltas (1ª Manhã = 3 ...)


def _criterio():
	return frappe.db.get_single_value("SIGOS Settings", "abandono_criterio") or CRITERIO_DIAS


def _descrever(info):
	"""'19 dias seguidos de ausência' / '40 faltas em ausência seguida'."""
	if info.get("unidade") == "faltas":
		return _("{0} faltas em ausência seguida").format(info.get("valor", 0))
	return _("{0} dias seguidos de ausência").format(info.get("valor", 0))


# ─── Congelar Salário ───────────────────────────────────────────────────────────
# A frozen guard is left out of every Payroll Entry and can't get a Salary Slip
# (payroll_entry_hooks / salary_slip_hooks). The months frozen are simply not
# processed yet — once the process ends (return / dismissal / manual unfreeze)
# RH creates those slips, which then already see any justification. Frozen
# automatically on entering Abandono de Posto or Doente and lifted on leaving
# (Vigilante._congelar_por_estado). Fields live on the Vigilante (permlevel 0,
# read-only).

PAPEIS_CONGELAR = ("System Manager", "SIGOS Manager", "Aprovador RH", "RH Normal")


def vigilantes_congelados(employees=None):
	"""{employee: vigilante} for frozen guards (optionally among `employees`)."""
	filters = {"salario_congelado": 1, "funcionario": ["is", "set"]}
	if employees is not None:
		if not employees:
			return {}
		filters["funcionario"] = ["in", list(employees)]
	return {
		v.funcionario: v.name
		for v in frappe.get_all("Vigilante", filters=filters, fields=["name", "funcionario"])
	}


def folhas_em_falta(vigilante):
	"""Where payroll stopped for this guard: the last SUBMITTED slip's end_date
	(None if never paid) — the frozen months start right after it."""
	emp = frappe.db.get_value("Vigilante", vigilante, "funcionario")
	if not emp:
		return None
	ult = frappe.get_all(
		"Salary Slip", filters={"employee": emp, "docstatus": 1},
		fields=["end_date"], order_by="end_date desc", limit=1,
	)
	return ult[0].end_date if ult else None


def aviso_descongelado(vigilante):
	ultima = folhas_em_falta(vigilante)
	if ultima:
		return _("Salário descongelado. Última folha processada até <b>{0}</b> — crie as "
			"Salary Slips em falta a partir de <b>{1}</b> (Payroll Entry ou individualmente).").format(
			frappe.format_value(ultima, {"fieldtype": "Date"}),
			frappe.format_value(add_days(ultima, 1), {"fieldtype": "Date"}))
	return _("Salário descongelado. O vigilante ainda não tem nenhuma Salary Slip submetida — "
		"processe os meses em falta.")


# ─── Streak computation ─────────────────────────────────────────────────────────

def calcular_sequencia_ausencia(vigilante, ate=None, desde=None):
	"""
	Current unbroken absence streak for a guard, ending at `ate` (default:
	yesterday — today's sheets may not be filed yet). Returns
	{"inicio", "dias", "faltas", "ultima_falta", "valor", "unidade"}:
	`dias` = calendar days, `faltas` = the same streak's absences weighted like
	payroll (utils.calcular_faltas_detalhado: turno weight + consecutive de-dup),
	`valor`/`unidade` = whichever SIGOS Settings.abandono_criterio compares to
	the limit. The streak itself (which days break it) is the same either way.

	`desde` widens the lookback (e.g. the stored abandono_primeira_falta) —
	otherwise it covers the limit plus a month, which the escala's own
	keep-buffer (manter_meses_passados) normally still holds.
	"""
	ate = getdate(ate) if ate else getdate(add_days(today(), -1))
	inicio_janela = getdate(add_days(ate, -(_dias_limite() + 31)))
	if desde and getdate(desde) < inicio_janela:
		inicio_janela = getdate(desde)

	unidade = "faltas" if _criterio() == CRITERIO_FALTAS else "dias"
	vazio = {"inicio": None, "dias": 0, "faltas": 0, "ultima_falta": None,
		"valor": 0, "unidade": unidade}

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
	dias = max(0, date_diff(ate, inicio) + 1 - licenca_no_periodo)
	faltas = _faltas_na_sequencia(vigilante, inicio, ate, justificados)
	return {
		"inicio": inicio,
		"dias": dias,
		"faltas": faltas,
		"ultima_falta": ultima,
		"valor": faltas if unidade == "faltas" else dias,
		"unidade": unidade,
	}


def _faltas_na_sequencia(vigilante, inicio, ate, justificados):
	"""Weighted faltas of the streak, counted exactly like payroll (e.g. 1ª Manhã
	= 3 + 2ª Manhã = 1 -> 4), unjustified absence rows only."""
	from sigos.utils import calcular_faltas_detalhado

	return sum(
		r["n_de_faltas"] or 0
		for r in calcular_faltas_detalhado(vigilante, inicio, ate)
		if r["tipo_de_ausencia"] in _TIPOS_AUSENTE
		and not r.get("tipo_justificacao")
		and getdate(r["data"]) not in justificados
	)


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
	"""Daily (sigos.tasks.daily): add late-filed faltas to open Presunções, then
	detect new streaks — alert, and in Automático open the Presunção."""
	sincronizar_presuncoes_abertas()

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
		# Already in Abandono (Presunção open) or out of service — nothing to detect;
		# a stale flag on someone who left service is just cleared.
		if v.abandono_detectado_em and v.status != ESTADO_ABANDONO:
			_limpar_sinal(v.name)
		return

	info = calcular_sequencia_ausencia(v.name, ontem, desde=v.abandono_primeira_falta)
	if info["valor"] < limite:
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
			"<b>Possível Abandono de Posto</b> — {0} desde {1}."
		).format(_descrever(info), frappe.format_value(info["inicio"], {"fieldtype": "Date"})))

	if modo == "Automático":
		# Keep the alert even if the Presunção below fails (retried tomorrow,
		# without re-notifying — abandono_detectado_em is already stamped).
		frappe.db.commit()
		try:
			criar_presuncao(v.name, info, origem="Automática")
		except Exception as ex:
			frappe.db.rollback()
			frappe.log_error(
				f"Erro ao criar Presunção de Abandono para {v.name}: {ex}", "SIGOS Abandono de Posto"
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
		_("Foi aberta automaticamente uma <b>Presunção de Abandono</b>: o vigilante saiu do posto "
		  "e da escala (o turno ficou como vaga), o salário foi congelado e não se registam mais "
		  "faltas.")
		if modo == "Automático"
		else _("Abra o vigilante e use <b>Criar Presunção de Abandono</b>.")
	)
	for user in _destinatarios():
		frappe.get_doc({
			"doctype": "Notification Log",
			"subject": _("Abandono de Posto: {0} — {1}").format(nome, _descrever(info)),
			"email_content": _(
				"<b>{0}</b> ({1}): <b>{2}</b>, desde {3} (posto: {4}). {5}"
			).format(
				nome, v.name, _descrever(info),
				frappe.format_value(info["inicio"], {"fieldtype": "Date"}),
				v.posto_de_vigilancia or "—", accao,
			),
			"for_user": user,
			"type": "Alert",
			"document_type": "Vigilante",
			"document_name": v.name,
		}).insert(ignore_permissions=True)


# ─── Presunção de Abandono ──────────────────────────────────────────────────────

def presuncao_em_curso(vigilante):
	"""The guard's Presunção still in progress (Aberta / Em Análise / Em Processo)."""
	nomes = frappe.get_all(
		DOCTYPE_PRESUNCAO,
		filters={"vigilante": vigilante, "estado": ["in", list(PRESUNCAO_EM_CURSO)]},
		pluck="name", order_by="creation desc", limit=1,
	)
	return nomes[0] if nomes else None


def criar_presuncao(vigilante, info=None, origem="Manual"):
	"""Open the Presunção (evidence: every falta of the streak) and put the guard
	in Abandono de Posto: off posto + escala (vacated turno → Vaga), salary frozen
	(Vigilante._congelar_por_estado). Returns its name."""
	vig = frappe.get_doc("Vigilante", vigilante)
	if vig.status not in _ESTADOS_VIGIADOS:
		frappe.throw(
			_("Só um vigilante <b>Activo</b> ou em <b>Reserva</b> pode entrar em Abandono de "
			  "Posto (estado actual: <b>{0}</b>).").format(vig.status),
			title=_("Estado Inválido"),
		)
	existente = presuncao_em_curso(vigilante)
	if existente:
		frappe.throw(
			_("O vigilante já tem a Presunção de Abandono <b>{0}</b> em curso.").format(existente),
			title=_("Presunção Existente"),
		)

	ontem = getdate(add_days(today(), -1))
	info = info or calcular_sequencia_ausencia(vigilante, ontem, desde=vig.abandono_primeira_falta)
	if not info.get("inicio"):
		frappe.throw(
			_("O vigilante não tem ausências seguidas por justificar — não há base para uma "
			  "Presunção de Abandono."),
			title=_("Sem Ausências"),
		)

	turno = None
	if vig.posto_de_vigilancia and vig.regime_do_vigilante:
		from sigos.security_ops.doctype.escala_do_vigilante.escala_do_vigilante import (
			obter_turno_inicial_actual,
		)
		turno = obter_turno_inicial_actual(vig.name, vig.posto_de_vigilancia, vig.regime_do_vigilante)

	doc = frappe.get_doc({
		"doctype": DOCTYPE_PRESUNCAO,
		"vigilante": vigilante,
		"nome_do_vigilante": vig.nome_completo,
		"mecanografico": vig.mecanografico,
		"delegacao": vig.delegacao,
		"estado": PRESUNCAO_ABERTA,
		"origem": origem,
		"data_deteccao": today(),
		"primeira_falta": info["inicio"],
		"posto_de_vigilancia": vig.posto_de_vigilancia,
		"regime": vig.regime_do_vigilante,
		"turno_anterior": turno,
		"tipo_de_vigilante_anterior": vig.tipo_de_vigilante,
		"estado_anterior": vig.status,
		"abandono_desde": today(),
		"criterio": _criterio(),
		"limite": _dias_limite(),
		"valor_na_deteccao": info.get("valor") or 0,
	})
	_preencher_faltas(doc, vigilante, info["inicio"], ontem)
	doc.insert(ignore_permissions=True)

	posto, regime = vig.posto_de_vigilancia, vig.regime_do_vigilante
	from sigos.security_ops.doctype.vigilante.vigilante import limpar_campos_operacionais

	vig.status = ESTADO_ABANDONO
	vig.data_inicio_abandono = today()
	vig.data_fim_abandono = None
	vig.abandono_primeira_falta = info["inicio"]
	vig.presuncao_abandono = doc.name
	limpar_campos_operacionais(vig)
	vig.flags.ignore_permissions = True
	vig.save()

	# The vacated turno, so a replacement can take exactly that slot.
	if posto and regime and turno:
		from sigos.security_ops.doctype.vaga_de_posto.vaga_de_posto import abrir_vaga
		doc.db_set("vaga", abrir_vaga(posto=posto, regime=regime, turno=turno, vigilante_anterior=vigilante))

	from sigos.timeline import registar
	registar(vigilante, _(
		"<b>Abandono de Posto</b> — Presunção <b>{0}</b> aberta ({1}). Sai do posto{2} e da "
		"escala; salário congelado; não se registam mais faltas."
	).format(doc.name, _descrever(info), _(" <b>{0}</b>").format(posto) if posto else ""), doc)
	return doc.name


@frappe.whitelist()
def criar_presuncao_manual(vigilante):
	"""Vigilante banner button (Apenas Alerta mode, or anytime by hand)."""
	frappe.only_for(PAPEIS_CRIAR_PRESUNCAO)
	return criar_presuncao(vigilante, origem="Manual")


def _faltas_desde(vigilante, inicio, ate):
	"""Unjustified absence rows (the evidence) from `inicio` through `ate`,
	weighted like payroll (utils.calcular_faltas_detalhado)."""
	from sigos.utils import calcular_faltas_detalhado

	justificados = dias_justificados(vigilante, inicio, ate)
	return [
		r for r in calcular_faltas_detalhado(vigilante, inicio, ate)
		if r["tipo_de_ausencia"] in _TIPOS_AUSENTE
		and not r.get("tipo_justificacao")
		and getdate(r["data"]) not in justificados
	]


def _preencher_faltas(doc, vigilante, inicio, ate):
	"""(Re)build the evidence table and its totals."""
	linhas = _faltas_desde(vigilante, inicio, ate)
	doc.set("faltas", [])
	for r in linhas:
		doc.append("faltas", {
			"data": r["data"],
			"turno": r.get("turno"),
			"posto": r.get("posto"),
			"regime": r.get("regime"),
			"tipo_de_ausencia": r["tipo_de_ausencia"],
			"n_de_faltas": r["n_de_faltas"],
			"ausencia": r.get("ausencia"),
		})
	datas = {getdate(r["data"]) for r in linhas}
	doc.total_dias = len(datas)
	doc.total_faltas = sum(r["n_de_faltas"] or 0 for r in linhas)
	doc.ultima_falta = max(datas) if datas else None


def sincronizar_presuncao(nome):
	"""Re-read the faltas that originated an ABERTA Presunção — every unjustified
	falta from the first one to the day BEFORE it was opened (a sheet filed late
	for those days is added, a justified/cancelled one drops out). Nothing after
	the Presunção counts: no faltas are recorded from then on. No-op once the
	Jurista moved it on — the evidence is then frozen. Returns True if changed."""
	doc = frappe.get_doc(DOCTYPE_PRESUNCAO, nome)
	if doc.estado != PRESUNCAO_ABERTA or not doc.primeira_falta:
		return False
	antes = [(str(f.data), f.ausencia, f.n_de_faltas) for f in doc.faltas]
	ate = getdate(add_days(doc.abandono_desde or doc.data_deteccao or today(), -1))
	_preencher_faltas(doc, doc.vigilante, doc.primeira_falta, ate)
	depois = [(str(f.data), f.ausencia, f.n_de_faltas) for f in doc.faltas]
	if antes == depois:
		return False
	doc.flags.ignore_permissions = True
	doc.save()
	return True


def sincronizar_presuncoes_abertas(vigilantes=None):
	filters = {"estado": PRESUNCAO_ABERTA}
	if vigilantes:
		filters["vigilante"] = ["in", list(vigilantes)]
	for nome in frappe.get_all(DOCTYPE_PRESUNCAO, filters=filters, pluck="name"):
		try:
			sincronizar_presuncao(nome)
			if not vigilantes:
				frappe.db.commit()
		except Exception as ex:
			if not vigilantes:
				frappe.db.rollback()
			frappe.log_error(f"Erro ao actualizar a Presunção {nome}: {ex}", "SIGOS Abandono de Posto")


def ao_mudar_ausencias(doc, method=None):
	"""Ausencias on_submit / on_cancel: pile the new faltas straight away."""
	vigs = {r.vigilante for r in (doc.get("tabela_ausencia") or []) if r.vigilante}
	if vigs:
		sincronizar_presuncoes_abertas(vigs)


def ao_mudar_justificacao(doc, method=None):
	"""Justificacao De Faltas on_submit / on_cancel: a justified falta leaves the evidence."""
	if doc.get("vigilante"):
		sincronizar_presuncoes_abertas([doc.vigilante])


def fechar_presuncao(vigilante, estado, nota=None, fim=None):
	"""The guard left Abandono (return / dismissal) on the day after `fim`: stamp
	the end of the unpaid window (abandono_ate) on their latest Presunção whatever
	its estado, and close it with `estado` if still open / in analysis. One already
	forwarded to a Processo Disciplinar is left alone (the process carries on)."""
	fim = getdate(fim or add_days(today(), -1))
	ultima = frappe.db.get_value("Vigilante", vigilante, "presuncao_abandono")
	if ultima and frappe.db.exists(DOCTYPE_PRESUNCAO, ultima) and not frappe.db.get_value(
		DOCTYPE_PRESUNCAO, ultima, "abandono_ate"
	):
		desde = frappe.db.get_value(DOCTYPE_PRESUNCAO, ultima, "abandono_desde")
		if desde:
			fim = max(fim, getdate(add_days(desde, -1)))  # same-day return: empty window
		frappe.db.set_value(DOCTYPE_PRESUNCAO, ultima, "abandono_ate", fim)
	nome = presuncao_em_curso(vigilante)
	if not nome:
		return None
	doc = frappe.get_doc(DOCTYPE_PRESUNCAO, nome)
	if doc.estado == PRESUNCAO_ABERTA:
		sincronizar_presuncao(nome)
		doc.reload()
	if doc.estado == PRESUNCAO_EM_PROCESSO:
		doc.add_comment("Info", _("Vigilante saiu de Abandono de Posto ({0}).").format(estado))
		return nome
	doc.estado = estado
	doc.data_fecho = today()
	if nota:
		doc.nota_fecho = nota
	doc.flags.ignore_permissions = True
	doc.save()
	return nome


def dias_em_abandono(vigilante, de, ate):
	"""How many days of [de, ate] fall in an Abandono episode (see dias_abandono)."""
	return len(dias_abandono(vigilante, de, ate))


def dias_abandono(vigilante, de, ate):
	"""Set of calendar days of [de, ate] inside any Abandono episode of the guard —
	[Presunção.abandono_desde, abandono_ate or open] — not paid by the company
	(salary_slip_hooks._dias_fora_emprego). A justification does NOT pay these."""
	de, ate = getdate(de), getdate(ate)
	if not vigilante or de > ate:
		return set()
	eps = frappe.get_all(
		DOCTYPE_PRESUNCAO,
		filters={"vigilante": vigilante, "abandono_desde": ["<=", ate]},
		fields=["abandono_desde", "abandono_ate"],
	)
	dias = set()
	for e in eps:
		if not e.abandono_desde:
			continue
		d = max(de, getdate(e.abandono_desde))
		f = min(ate, getdate(e.abandono_ate)) if e.abandono_ate else ate
		while d <= f:
			dias.add(d)
			d = getdate(add_days(d, 1))
	return dias


def periodo_sem_registo(vigilante, data):
	"""Label if `data` falls in a period where no absence may be recorded for the
	guard — an Abandono de Posto episode (known abandonment) or a Baixa Médica —
	else None. Used by Ausencias."""
	data = getdate(data)
	for e in frappe.get_all(
		DOCTYPE_PRESUNCAO,
		filters={"vigilante": vigilante, "abandono_desde": ["<=", data]},
		fields=["name", "abandono_ate"],
	):
		if not e.abandono_ate or getdate(e.abandono_ate) >= data:
			return _("Abandono de Posto (Presunção {0})").format(e.name)
	for b in frappe.get_all(
		"Baixa Medica", filters={"vigilante": vigilante, "data_inicio": ["<=", data]},
		fields=["name", "data_regresso"],
	):
		if not b.data_regresso or getdate(b.data_regresso) > data:
			return _("Doente (Baixa Médica {0})").format(b.name)
	return None


@frappe.whitelist()
def sequencia_vigilante(vigilante):
	"""Live streak for the Vigilante banner (read-only)."""
	frappe.has_permission("Vigilante", "read", doc=vigilante, throw=True)
	desde = frappe.db.get_value("Vigilante", vigilante, "abandono_primeira_falta")
	info = calcular_sequencia_ausencia(vigilante, desde=desde)
	info["limite"] = _dias_limite()
	info["modo"] = _modo()
	info["texto"] = _descrever(info)
	return info


# ─── Return with justification (pardon) ─────────────────────────────────────────

def justificar_abandono(vigilante, de, ate, justificativo=None, observacoes=None, doenca=0):
	"""
	Pardon an Abandono episode: a Justificacao De Faltas over [de, ate] (normally
	from the streak's first falta to the day before the return). It clears those
	faltas in payroll (salary_slip_hooks._compute_justificadas), drops them from
	the open Presunção's evidence and breaks the streak. Submitted directly when the user may submit Justificações and no
	workflow is active; otherwise left as a draft for RH. Returns
	{"name", "submetida"} or None when there's nothing to justify.
	"""
	from sigos.api import has_active_workflow

	de, ate = getdate(de), getdate(ate)
	if de > ate:
		return None
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
		# Sickness: faltas cleared, days follow the 3-day rule (sigos.doenca)
		"doenca": cint(doenca),
	})
	doc.insert(ignore_permissions=True)
	submeter = (
		not has_active_workflow("Justificacao De Faltas")
		and frappe.has_permission("Justificacao De Faltas", "submit")
	)
	if submeter:
		doc.submit()
	return {"name": doc.name, "submetida": submeter}
