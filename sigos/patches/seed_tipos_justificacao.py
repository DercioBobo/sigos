import frappe


def execute():
	"""Seed the initial Tipo De Justificacao reasons (the doctype is dynamic — more can be added in the UI)."""
	for t in ["Nojo", "Doença", "Formação", "Abandono de Posto"]:
		if not frappe.db.exists("Tipo De Justificacao", t):
			frappe.get_doc({"doctype": "Tipo De Justificacao", "justificacao": t, "activo": 1}).insert(
				ignore_permissions=True
			)
	frappe.db.commit()
