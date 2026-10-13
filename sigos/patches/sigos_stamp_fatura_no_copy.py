import frappe


def execute():
	"""
	The SIGOS stamp on Sales Invoice (custom_mes_referencia / custom_faturacao_mensal)
	marks THE month's contract invoice for the double-billing guard. Without no_copy,
	'Duplicate' carried it into a new invoice (e.g. one for extra services), which
	then counted as a second monthly invoice. Amend still keeps it (Frappe copies
	no_copy fields on amend), so a cancel-and-amend stays the month's invoice.
	_load_custom_fields skips existing fields, so set it here. Idempotent.
	"""
	for fieldname in ("custom_mes_referencia", "custom_faturacao_mensal"):
		nome = frappe.db.get_value("Custom Field", {"dt": "Sales Invoice", "fieldname": fieldname})
		if nome:
			frappe.db.set_value("Custom Field", nome, "no_copy", 1, update_modified=False)
	frappe.clear_cache(doctype="Sales Invoice")
