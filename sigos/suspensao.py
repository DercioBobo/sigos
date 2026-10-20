"""
Suspensão Preventiva — CCO takes a guard off the posto while the Jurista works the
disciplinary process, instead of waiting for it to end.

Started from a SUBMITTED Participação ("Suspender Preventivamente"): the guard goes
to status "Suspenso Preventivamente" — off posto + escala (the vacated turno becomes
a Vaga De Posto), out of every reserve pool and abandono detection, and no absence
may be recorded meanwhile (abandono.periodo_sem_registo). The episode lives on the
Participação (suspensao_* fields), so each case keeps its own history.

Pay is chosen per case (suspensao_remuneracao):
  - "Pago Normalmente": nothing changes in payroll;
  - "Salário Congelado": salary frozen (Vigilante._congelar_por_estado) — on the
    return RH decides whether the frozen period is paid (else it becomes Não Pago);
  - "Não Pago": the suspended days are deducted (salary_slip_hooks._dias_fora_emprego
    ← dias_nao_pagos).

It ends with the process: a Demissão (PD decision) dismisses the guard and closes
the episode; any other outcome → "Registar Regresso" (previous posto if it still
has room / Reserva / new posto).
"""

import frappe
from frappe import _
from frappe.utils import add_days, cint, getdate, today

ESTADO_SUSPENSO = "Suspenso Preventivamente"
REM_PAGO = "Pago Normalmente"
REM_CONGELADO = "Salário Congelado"
REM_NAO_PAGO = "Não Pago"
REMUNERACOES = (REM_PAGO, REM_CONGELADO, REM_NAO_PAGO)
PAPEIS_SUSPENSAO = (
	"System Manager", "SIGOS Manager", "Aprovador Operações", "Operações SIGOS", "Jurista",
)
_PODEM_SER_SUSPENSOS = ("Activo", "Reserva")


def suspender(part, remuneracao, data_inicio=None, motivo=None):
	"""`part`: the submitted Participação doc. Returns the Participação name."""
	frappe.only_for(PAPEIS_SUSPENSAO)
	if part.docstatus != 1:
		frappe.throw(_("Submeta a Participação antes de suspender o vigilante."))
	if remuneracao not in REMUNERACOES:
		frappe.throw(_("Escolha a remuneração durante a suspensão."))
	if part.suspensao_desde:
		frappe.throw(_("Esta Participação já tem uma suspensão preventiva registada."))
	vig = frappe.get_doc("Vigilante", part.vigilante)
	if vig.status not in _PODEM_SER_SUSPENSOS:
		frappe.throw(
			_("Só um vigilante <b>Activo</b> ou em <b>Reserva</b> pode ser suspenso preventivamente "
			  "(estado actual: <b>{0}</b>).").format(vig.status),
			title=_("Estado Inválido"),
		)
	inicio = getdate(data_inicio or today())
	if inicio > getdate(today()):
		frappe.throw(_("A data da suspensão não pode ser no futuro."))

	turno = None
	posto, regime = vig.posto_de_vigilancia, vig.regime_do_vigilante
	if posto and regime:
		from sigos.security_ops.doctype.escala_do_vigilante.escala_do_vigilante import (
			obter_turno_inicial_actual,
		)
		turno = obter_turno_inicial_actual(vig.name, posto, regime)

	part.db_set({
		"suspensao_desde": inicio,
		"suspensao_ate": None,
		"suspensao_remuneracao": remuneracao,
		"suspensao_motivo": (motivo or "").strip() or None,
		"suspensao_por": frappe.session.user,
		"suspensao_posto": posto,
		"suspensao_regime": regime,
		"suspensao_turno": turno,
		"suspensao_tipo_vigilante": vig.tipo_de_vigilante,
		"suspensao_estado_anterior": vig.status,
		"suspensao_destino": None,
	})

	from sigos.security_ops.doctype.vigilante.vigilante import limpar_campos_operacionais

	vig.status = ESTADO_SUSPENSO
	vig.participacao_suspensao = part.name
	vig.flags.congelado_desde = inicio
	vig.flags.suspensao_remuneracao = remuneracao
	limpar_campos_operacionais(vig)
	vig.flags.ignore_permissions = True
	vig.save()

	if posto and regime and turno:
		from sigos.security_ops.doctype.vaga_de_posto.vaga_de_posto import abrir_vaga
		part.db_set("suspensao_vaga", abrir_vaga(posto=posto, regime=regime, turno=turno,
			vigilante_anterior=vig.name))

	from sigos.timeline import registar
	registar(vig.name, _(
		"<b>Suspenso preventivamente</b> desde {0} (Participação {1}) — sai do posto{2} e da escala; "
		"remuneração: {3}."
	).format(frappe.format_value(inicio, {"fieldtype": "Date"}), part.name,
		_(" <b>{0}</b>").format(posto) if posto else "", remuneracao), part)
	_notificar_jurista(part, vig, inicio, remuneracao)
	return part.name


def _notificar_jurista(part, vig, inicio, remuneracao):
	try:
		users = set(frappe.get_all("Has Role", filters={"role": "Jurista", "parenttype": "User"}, pluck="parent"))
		activos = set(frappe.get_all("User", filters={"enabled": 1, "name": ["in", list(users) or [""]]},
			pluck="name"))
		for user in activos - {"Administrator", "Guest"}:
			frappe.get_doc({
				"doctype": "Notification Log",
				"subject": _("Suspensão preventiva: {0}").format(vig.nome_completo or vig.name),
				"email_content": _(
					"<b>{0}</b> foi suspenso preventivamente desde {1} (remuneração: {2}) e aguarda o "
					"Processo Disciplinar da Participação <b>{3}</b>."
				).format(vig.nome_completo or vig.name, frappe.format_value(inicio, {"fieldtype": "Date"}),
					remuneracao, part.name),
				"for_user": user, "type": "Alert",
				"document_type": "Participacao", "document_name": part.name,
			}).insert(ignore_permissions=True)
	except Exception as e:
		frappe.log_error(f"Suspensão {part.name}: erro ao notificar Jurista: {e}", "SIGOS Suspensão")


def registar_regresso(vig, destino="Reserva", data_regresso=None, pagar_periodo=1, observacoes=None):
	"""The process ended without dismissal: close the suspension and place the guard —
	"Posto Anterior" (only if active + room; capacity re-checked on save), "Reserva",
	or "Novo Posto" (Reserva; the form then opens APR). With "Salário Congelado",
	`pagar_periodo`=0 turns the suspended days into unpaid ones."""
	frappe.only_for(PAPEIS_SUSPENSAO)
	if vig.status != ESTADO_SUSPENSO:
		frappe.throw(_("O vigilante não está <b>Suspenso Preventivamente</b>."), title=_("Sem alteração"))
	if not vig.participacao_suspensao:
		frappe.throw(_("Não foi encontrada a Participação da suspensão."))
	part = frappe.get_doc("Participacao", vig.participacao_suspensao)
	regresso = getdate(data_regresso or today())
	if regresso < getdate(part.suspensao_desde) or regresso > getdate(today()):
		frappe.throw(_("A data de regresso tem de estar entre o início da suspensão e hoje."))
	if destino not in ("Posto Anterior", "Reserva", "Novo Posto"):
		frappe.throw(_("Destino inválido: {0}").format(destino))

	if destino == "Posto Anterior":
		if not (part.suspensao_posto and part.suspensao_regime):
			frappe.throw(_("Sem posto anterior — escolha Reserva ou Novo Posto."))
		if frappe.db.get_value("Posto De Vigilancia", part.suspensao_posto, "estado") != "Activo":
			frappe.throw(_("O posto anterior <b>{0}</b> já não está activo.").format(part.suspensao_posto))
		vig.posto_de_vigilancia = part.suspensao_posto
		vig.regime_do_vigilante = part.suspensao_regime
		if part.suspensao_tipo_vigilante:
			vig.tipo_de_vigilante = part.suspensao_tipo_vigilante
		if part.suspensao_turno:
			vig.flags.turno_inicial_preferido = part.suspensao_turno
		vig.status = "Activo"
	else:
		vig.status = "Reserva"
	vig.flags.suspensao_fechada = True
	vig.flags.ignore_permissions = True
	vig.save()  # capacity: _validar_capacidade_posto throws if the slot was filled

	if part.suspensao_remuneracao == REM_CONGELADO and not cint(pagar_periodo):
		part.db_set("suspensao_remuneracao", REM_NAO_PAGO)
	fechar(part, regresso, destino, observacoes)

	from sigos.timeline import registar
	registar(vig.name, _("<b>Fim da suspensão preventiva</b> (Participação {0}) — {1}. Remuneração do período: {2}.").format(
		part.name,
		_("volta ao posto <b>{0}</b>").format(part.suspensao_posto) if destino == "Posto Anterior"
		else _("fica em <b>Reserva</b>") + (_(", a destacar para novo posto") if destino == "Novo Posto" else ""),
		part.suspensao_remuneracao), part)
	return {"status": vig.status, "participacao": part.name}


def fechar(part, regresso, destino, observacoes=None):
	"""Stamp the end of the episode: suspensao_ate = the day before the return."""
	if isinstance(part, str):
		part = frappe.get_doc("Participacao", part)
	if not part.suspensao_desde or part.suspensao_ate:
		return part
	ate = max(getdate(add_days(regresso, -1)), getdate(add_days(part.suspensao_desde, -1)))
	valores = {"suspensao_ate": ate, "suspensao_destino": destino}
	if observacoes:
		valores["suspensao_motivo"] = ((part.suspensao_motivo or "") + "\n" + observacoes).strip()
	part.db_set(valores)
	return part


def ao_sair(vig):
	"""Vigilante.on_update: left the status another way (e.g. Demissão from the PD) —
	close the episode as of today."""
	if vig.flags.get("suspensao_fechada") or not vig.participacao_suspensao:
		return
	fechar(vig.participacao_suspensao, today(), vig.status)


def remuneracao(vigilante_doc):
	return vigilante_doc.flags.get("suspensao_remuneracao") or (
		frappe.db.get_value("Participacao", vigilante_doc.participacao_suspensao, "suspensao_remuneracao")
		if vigilante_doc.participacao_suspensao else None
	)


def _episodios(vigilante, ate, so_nao_pagos=False):
	filtros = {"vigilante": vigilante, "suspensao_desde": ["<=", ate], "docstatus": 1}
	if so_nao_pagos:
		filtros["suspensao_remuneracao"] = REM_NAO_PAGO
	return frappe.get_all("Participacao", filters=filtros,
		fields=["name", "suspensao_desde", "suspensao_ate"])


def dias_nao_pagos(vigilante, de, ate):
	"""Set of days of [de, ate] in a "Não Pago" suspension — deducted by payroll."""
	de, ate = getdate(de), getdate(ate)
	if not vigilante or de > ate:
		return set()
	dias = set()
	for e in _episodios(vigilante, ate, so_nao_pagos=True):
		d = max(de, getdate(e.suspensao_desde))
		f = min(ate, getdate(e.suspensao_ate)) if e.suspensao_ate else ate
		while d <= f:
			dias.add(d)
			d = getdate(add_days(d, 1))
	return dias


def periodo_suspenso(vigilante, data):
	"""Label when `data` falls inside a suspension of the guard (no absences then)."""
	data = getdate(data)
	for e in _episodios(vigilante, data):
		if not e.suspensao_ate or getdate(e.suspensao_ate) >= data:
			return _("Suspensão Preventiva (Participação {0})").format(e.name)
	return None
