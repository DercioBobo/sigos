import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime


class VagaDePosto(Document):
	pass


def _equipa_do_slot(posto, regime, turno):
	"""Calendário de Equipas: the team owning this turno_inicial slot at this posto."""
	from sigos import calendario_equipas as ce
	cal = ce.calendario(regime)
	if not cal:
		return None
	ajuste = frappe.db.get_value("Escala Do Vigilante",
		{"posto_de_vigilancia": posto, "regime_do_vigilante": regime}, "ajuste_local_dias") or 0
	return ce.equipa_do_turno_inicial(cal, turno, ajuste)


def abrir_vaga(posto, regime, turno, vigilante_anterior=None, origem_rotatividade=None):
	"""
	Persist a posto+regime+turno slot vacated with nobody taking it over immediately.
	Idempotent per slot AND leaving guard: on a Calendário de Equipas escala several
	guards share one team slot, so two of them leaving are two vagas. The team
	(turno_equipa) is recorded for the board ("Falta 1 — Equipa 2").
	"""
	equipa = _equipa_do_slot(posto, regime, turno)
	filtros = {"posto_de_vigilancia": posto, "regime": regime, "turno": turno, "estado": "Aberta"}
	if equipa and vigilante_anterior:
		filtros["vigilante_anterior"] = vigilante_anterior  # team slot: one vaga per leaving guard
	existente = frappe.db.exists("Vaga De Posto", filtros)
	if existente:
		return existente

	vaga = frappe.get_doc({
		"doctype": "Vaga De Posto",
		"posto_de_vigilancia": posto,
		"regime": regime,
		"turno": turno,
		"turno_equipa": equipa,
		"vigilante_anterior": vigilante_anterior,
		"origem_rotatividade": origem_rotatividade,
		"data_abertura": now_datetime(),
		"estado": "Aberta",
	})
	vaga.insert(ignore_permissions=True)
	return vaga.name


def fechar_vaga(posto, regime, turno, vigilante=None):
	"""Auto-resolve the OLDEST open vacancy of this exact slot once someone fills it
	(one guard fills one vaga — a team slot may have several open)."""
	from sigos.calendario_equipas import calendario
	abertas = frappe.get_all(
		"Vaga De Posto",
		filters={"posto_de_vigilancia": posto, "regime": regime, "turno": turno, "estado": "Aberta"},
		pluck="name", order_by="data_abertura asc",
		limit=1 if calendario(regime) else None,  # without the calendar: every match, as before
	)
	for nome in abertas:
		frappe.db.set_value(
			"Vaga De Posto",
			nome,
			{
				"estado": "Preenchida",
				"vigilante_preenchido": vigilante,
				"data_preenchimento": now_datetime(),
			},
			update_modified=False,
		)
