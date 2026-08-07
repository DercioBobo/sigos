import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime


class VagaDePosto(Document):
	pass


def abrir_vaga(posto, regime, turno, vigilante_anterior=None, origem_rotatividade=None):
	"""
	Persist a posto+regime+turno slot vacated with nobody taking it over immediately.
	Idempotent: won't duplicate an already-open vacancy for the same exact slot.
	"""
	existente = frappe.db.exists(
		"Vaga De Posto",
		{"posto_de_vigilancia": posto, "regime": regime, "turno": turno, "estado": "Aberta"},
	)
	if existente:
		return existente

	vaga = frappe.get_doc({
		"doctype": "Vaga De Posto",
		"posto_de_vigilancia": posto,
		"regime": regime,
		"turno": turno,
		"vigilante_anterior": vigilante_anterior,
		"origem_rotatividade": origem_rotatividade,
		"data_abertura": now_datetime(),
		"estado": "Aberta",
	})
	vaga.insert(ignore_permissions=True)
	return vaga.name


def fechar_vaga(posto, regime, turno, vigilante=None):
	"""Auto-resolve any open vacancy matching this exact slot once someone fills it."""
	abertas = frappe.get_all(
		"Vaga De Posto",
		filters={"posto_de_vigilancia": posto, "regime": regime, "turno": turno, "estado": "Aberta"},
		pluck="name",
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
