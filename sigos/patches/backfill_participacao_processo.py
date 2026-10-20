import frappe


def execute():
	"""Participação.processo_disciplinar (new): point it at the live process already
	opened from each participação."""
	for pd in frappe.get_all(
		"Processo Disciplinar",
		filters={"participacao_referente": ["is", "set"], "docstatus": ["<", 2]},
		fields=["name", "participacao_referente"], order_by="creation asc",
	):
		frappe.db.set_value("Participacao", pd.participacao_referente, "processo_disciplinar", pd.name,
			update_modified=False)
	frappe.db.commit()
