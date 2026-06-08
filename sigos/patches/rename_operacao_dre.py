import frappe


def execute():
	"""Rename the rotatividade operation DRE -> APR ('Atribuir Posto aos Reservas')."""
	if not frappe.db.exists("Operacao De Rotatividade", "DRE"):
		return
	if not frappe.db.exists("Operacao De Rotatividade", "APR"):
		frappe.rename_doc("Operacao De Rotatividade", "DRE", "APR", force=True)
	frappe.db.set_value("Operacao De Rotatividade", "APR", {
		"abreviatura": "APR",
		"operacao": "Atribuir Posto aos Reservas",
	})
	frappe.db.commit()
