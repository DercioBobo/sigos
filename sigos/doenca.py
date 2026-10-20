"""
Doentes — guards on sick leave (Baixa Médica).

Marcar Doente (Vigilante button) opens a Baixa Medica and puts the guard in status
"Doente": off posto + escala (like Reserva — limpar_campos_operacionais), the
vacated turno opened as a Vaga De Posto, out of every reserve pool and headcount.
No absences are recorded meanwhile (they're on no escala). Registar Regresso
closes the Baixa: back to the previous posto (only if it still has room — capacity
is re-checked), Reserva, or a new posto (Reserva, then the APR wizard). The
atestado is optional.

Payroll — the 3-day rule (SIGOS Settings.doenca_dias_pagos_empresa, default 3):
a sickness of up to N days is paid by the company (nothing deducted); longer, ALL
its days are paid by INSS and deducted. The salary is frozen on Marcar Doente and
unfrozen on the return (Vigilante._congelar_por_estado: no Payroll Entry, no
Salary Slip meanwhile — the length is only known then); each month's slip then
deducts that month's own INSS days in the Proporcional (salary_slip_hooks.
_dias_fora_emprego). The same rule applies to faltas justified as sickness
(Justificacao De Faltas.doenca): the faltas are cleared, and if the justified
period is longer than N days its days are unpaid too (dias_doenca_justificada).
"""

import frappe
from frappe import _
from frappe.utils import add_days, cint, date_diff, getdate, today

ESTADO_DOENTE = "Doente"
BAIXA = "Baixa Medica"
BAIXA_EM_CURSO = "Em Curso"
BAIXA_CONCLUIDA = "Concluída"
PAPEIS_DOENCA = (
	"System Manager", "SIGOS Manager", "Aprovador Operações", "Operações SIGOS",
	"Aprovador RH", "RH Normal",
)
_PODEM_ADOECER = ("Activo", "Reserva")


def dias_pagos_empresa():
	"""N: a sickness of up to N days is paid by the company. An explicit 0 is
	respected; never set = 3."""
	from sigos.utils import valor_settings_bruto
	v = valor_settings_bruto("doenca_dias_pagos_empresa")
	return 3 if v in (None, "") else cint(v)


def pago_pelo_inss(dias):
	return dias > dias_pagos_empresa()


def baixa_em_curso(vigilante):
	nomes = frappe.get_all(
		BAIXA, filters={"vigilante": vigilante, "estado": BAIXA_EM_CURSO},
		pluck="name", order_by="creation desc", limit=1,
	)
	return nomes[0] if nomes else None


def marcar_doente(vig, data_inicio=None, atestado=None, observacoes=None):
	"""`vig`: the Vigilante doc. Opens the Baixa, frees the posto (+ Vaga), saves."""
	frappe.only_for(PAPEIS_DOENCA)
	if vig.status not in _PODEM_ADOECER:
		frappe.throw(
			_("Só um vigilante <b>Activo</b> ou em <b>Reserva</b> pode ser marcado como Doente "
			  "(estado actual: <b>{0}</b>).").format(vig.status),
			title=_("Estado Inválido"),
		)
	if baixa_em_curso(vig.name):
		frappe.throw(_("O vigilante já tem uma Baixa Médica em curso."), title=_("Baixa Existente"))
	inicio = getdate(data_inicio or today())
	if inicio > getdate(today()):
		frappe.throw(_("A data de início não pode ser no futuro."))

	turno = None
	if vig.posto_de_vigilancia and vig.regime_do_vigilante:
		from sigos.security_ops.doctype.escala_do_vigilante.escala_do_vigilante import (
			obter_turno_inicial_actual,
		)
		turno = obter_turno_inicial_actual(vig.name, vig.posto_de_vigilancia, vig.regime_do_vigilante)

	baixa = frappe.get_doc({
		"doctype": BAIXA,
		"vigilante": vig.name,
		"nome_do_vigilante": vig.nome_completo,
		"mecanografico": vig.mecanografico,
		"delegacao": vig.delegacao,
		"estado": BAIXA_EM_CURSO,
		"data_inicio": inicio,
		"posto_anterior": vig.posto_de_vigilancia,
		"regime_anterior": vig.regime_do_vigilante,
		"turno_anterior": turno,
		"tipo_de_vigilante_anterior": vig.tipo_de_vigilante,
		"estado_anterior": vig.status,
		"atestado_medico": atestado,
		"observacoes": observacoes,
	})
	baixa.flags.sistema = True
	baixa.insert(ignore_permissions=True)

	posto, regime = vig.posto_de_vigilancia, vig.regime_do_vigilante
	from sigos.security_ops.doctype.vigilante.vigilante import limpar_campos_operacionais

	vig.status = ESTADO_DOENTE
	vig.baixa_medica = baixa.name
	vig.flags.congelado_desde = inicio  # salary frozen from the first sick day
	limpar_campos_operacionais(vig)
	vig.flags.ignore_permissions = True
	vig.save()

	# The vacated turno, so a replacement can take exactly that slot (closed
	# automatically when someone lands on it — escala_do_vigilante).
	if posto and regime and turno:
		from sigos.security_ops.doctype.vaga_de_posto.vaga_de_posto import abrir_vaga
		baixa.db_set("vaga", abrir_vaga(posto=posto, regime=regime, turno=turno, vigilante_anterior=vig.name))

	from sigos.timeline import registar
	registar(vig.name, _("<b>Doente</b> desde {0} — Baixa Médica <b>{1}</b>; sai do posto{2} e da escala; salário congelado (pago pelo INSS).").format(
		frappe.format_value(inicio, {"fieldtype": "Date"}), baixa.name,
		_(" <b>{0}</b>").format(posto) if posto else ""), baixa)

	_avisar_faltas_no_periodo(vig.name, inicio)
	return baixa.name


def _avisar_faltas_no_periodo(vigilante, inicio):
	"""Back-dated Baixa: faltas already submitted inside it would be deducted twice
	(as faltas AND as sick days) — point them out."""
	if inicio >= getdate(today()):
		return
	n = frappe.db.sql(
		"""
		SELECT COUNT(*) FROM `tabTabela Ausencia` ta JOIN `tabAusencias` a ON a.name = ta.parent
		WHERE a.docstatus = 1 AND ta.vigilante = %(v)s AND a.data >= %(d)s
		  AND ta.tipo_de_ausencia IN ('Falta', 'Falta de Reserva')
		""",
		{"v": vigilante, "d": inicio},
	)[0][0]
	if n:
		frappe.msgprint(
			_("Existem <b>{0}</b> falta(s) registadas desde {1}, já dentro da baixa. Os dias de baixa "
			  "são descontados por inteiro — justifique ou cancele essas faltas para não descontar "
			  "duas vezes.").format(n, frappe.format_value(inicio, {"fieldtype": "Date"})),
			title=_("Faltas Dentro da Baixa"), indicator="orange",
		)


def registar_regresso(vig, destino="Reserva", data_regresso=None, atestado=None, observacoes=None):
	"""Close the Baixa and place the guard: "Posto Anterior" (capacity re-checked
	on save), "Reserva", or "Novo Posto" (Reserva; the form then opens APR)."""
	frappe.only_for(PAPEIS_DOENCA)
	if vig.status != ESTADO_DOENTE:
		frappe.throw(_("O vigilante não está <b>Doente</b>."), title=_("Sem alteração"))
	nome = baixa_em_curso(vig.name) or vig.baixa_medica
	if not nome:
		frappe.throw(_("Não foi encontrada a Baixa Médica em curso."))
	baixa = frappe.get_doc(BAIXA, nome)
	regresso = getdate(data_regresso or today())
	if regresso < getdate(baixa.data_inicio) or regresso > getdate(today()):
		frappe.throw(_("A data de regresso tem de estar entre o início da baixa e hoje."))
	if destino not in ("Posto Anterior", "Reserva", "Novo Posto"):
		frappe.throw(_("Destino inválido: {0}").format(destino))

	if destino == "Posto Anterior":
		if not (baixa.posto_anterior and baixa.regime_anterior):
			frappe.throw(_("Sem posto anterior — escolha Reserva ou Novo Posto."))
		if frappe.db.get_value("Posto De Vigilancia", baixa.posto_anterior, "estado") != "Activo":
			frappe.throw(_("O posto anterior <b>{0}</b> já não está activo.").format(baixa.posto_anterior))
		vig.posto_de_vigilancia = baixa.posto_anterior
		vig.regime_do_vigilante = baixa.regime_anterior
		if baixa.tipo_de_vigilante_anterior:
			vig.tipo_de_vigilante = baixa.tipo_de_vigilante_anterior
		vig.status = "Activo"
		if baixa.turno_anterior:
			vig.flags.turno_inicial_preferido = baixa.turno_anterior  # their old slot, if still free
	else:
		vig.status = "Reserva"
	vig.flags.baixa_fechada = True
	vig.flags.ignore_permissions = True
	vig.save()  # capacity: _validar_capacidade_posto throws if the slot was filled

	fechar_baixa(baixa, regresso, destino, atestado, observacoes)

	from sigos.timeline import registar
	registar(vig.name, _("<b>Regressou</b> da Baixa Médica {0} ({1} dia(s), pago por: {2}) — {3}.").format(
		baixa.name, baixa.dias, baixa.pago_por,
		_("volta ao posto <b>{0}</b>").format(baixa.posto_anterior) if destino == "Posto Anterior"
		else _("fica em <b>Reserva</b>") + (_(", a destacar para novo posto") if destino == "Novo Posto" else "")),
		baixa)
	return {"status": vig.status, "baixa": baixa.name}


def fechar_baixa(baixa, regresso, destino, atestado=None, observacoes=None):
	if isinstance(baixa, str):
		baixa = frappe.get_doc(BAIXA, baixa)
	if baixa.estado != BAIXA_EM_CURSO:
		return baixa
	regresso = getdate(regresso)
	baixa.estado = BAIXA_CONCLUIDA
	baixa.data_regresso = regresso
	baixa.dias = max(0, date_diff(regresso, baixa.data_inicio))  # through the day before return
	baixa.pago_por = (
		_("INSS") if pago_pelo_inss(baixa.dias)
		else _("Empresa (até {0} dias)").format(dias_pagos_empresa())
	)
	baixa.destino_regresso = destino
	if atestado:
		baixa.atestado_medico = atestado
	if observacoes:
		baixa.observacoes = ((baixa.observacoes or "") + "\n" + observacoes).strip()
	baixa.flags.sistema = True
	baixa.flags.ignore_permissions = True
	baixa.save()
	return baixa


def ao_sair_de_doente(vig):
	"""Vigilante.on_update: left Doente by another path (e.g. a DEM dismissal) —
	close the Baixa as of today."""
	if vig.flags.get("baixa_fechada"):
		return
	nome = baixa_em_curso(vig.name)
	if nome:
		fechar_baixa(nome, today(), vig.status)


def dias_inss(vigilante, de, ate):
	"""Set of calendar days of [de, ate] the COMPANY doesn't pay because of
	sickness (the 3-day rule): days of a Baixa Médica longer than N days (a closed
	one ends the day before the return; an open one is measured up to today), and
	days of a sickness-justified period longer than N days."""
	de, ate = getdate(de), getdate(ate)
	if not vigilante or de > ate:
		return set()
	dias = set()
	for b in frappe.get_all(
		BAIXA, filters={"vigilante": vigilante, "data_inicio": ["<=", ate]},
		fields=["data_inicio", "data_regresso"],
	):
		ini_b = getdate(b.data_inicio)
		fim_b = getdate(add_days(b.data_regresso, -1)) if b.data_regresso else getdate(today())
		if not pago_pelo_inss(date_diff(fim_b, ini_b) + 1):
			continue  # short sickness — the company pays it
		_somar(dias, max(de, ini_b), min(ate, fim_b) if b.data_regresso else ate)
	dias |= dias_doenca_justificada(vigilante, de, ate)
	return dias


def dias_doenca_justificada(vigilante, de, ate):
	"""Faltas justified as sickness (Justificacao De Faltas.doenca): cleared as
	faltas, but a period longer than N days is paid by INSS — its days are unpaid."""
	from sigos.payroll_ext.salary_slip_hooks import _aprovado_filter

	filters = {
		"vigilante": vigilante, "docstatus": 1, "doenca": 1,
		"dia_de_inicio": ["<=", ate], "dia_de_fim": [">=", de],
	}
	filters.update(_aprovado_filter("Justificacao De Faltas"))
	dias = set()
	for j in frappe.get_all("Justificacao De Faltas", filters=filters, fields=["dia_de_inicio", "dia_de_fim"]):
		ini, fim = getdate(j.dia_de_inicio), getdate(j.dia_de_fim)
		if pago_pelo_inss(date_diff(fim, ini) + 1):
			_somar(dias, max(de, ini), min(ate, fim))
	return dias


def _somar(dias, d, fim):
	while d <= fim:
		dias.add(d)
		d = getdate(add_days(d, 1))


def dias_de_baixa(vigilante, de, ate):
	"""How many days of [de, ate] are unpaid by the company for sickness."""
	return len(dias_inss(vigilante, de, ate))
