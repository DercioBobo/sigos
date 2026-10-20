import frappe


def execute():
	"""Participação now follows the paper form: several infracções (child table
	`infracoes`) and a named participante. Existing records: their single
	tipo_de_infracao becomes the first infracção row, and the participante name is
	taken from registado_por. Written straight to the DB — also for submitted ones."""
	for p in frappe.get_all(
		"Participacao", fields=["name", "tipo_de_infracao", "registado_por", "participante_nome"],
	):
		if p.tipo_de_infracao and not frappe.db.exists(
			"Participacao Infracao", {"parent": p.name, "parenttype": "Participacao"}
		):
			frappe.get_doc({
				"doctype": "Participacao Infracao",
				"parent": p.name, "parenttype": "Participacao", "parentfield": "infracoes",
				"idx": 1, "tipo_de_infracao": p.tipo_de_infracao,
			}).db_insert()
		if not p.participante_nome and p.registado_por:
			nome = frappe.db.get_value("User", p.registado_por, "full_name")
			if nome:
				frappe.db.set_value("Participacao", p.name, "participante_nome", nome, update_modified=False)
	frappe.db.commit()
