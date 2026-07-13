import frappe


def execute():
	"""Vigilante.banco and Employee.custom_banco move from free-text (Data) to a
	Link -> Banco master. Seed a Banco record for every distinct existing value
	so historical data doesn't turn into a broken link once the fieldtype change
	lands (Banco.autoname = field:nome, so the existing text becomes the doc name)."""
	valores = set()
	for v in frappe.get_all("Vigilante", filters={"banco": ["is", "set"]}, pluck="banco"):
		if v and v.strip():
			valores.add(v.strip())
	for v in frappe.get_all("Employee", filters={"custom_banco": ["is", "set"]}, pluck="custom_banco"):
		if v and v.strip():
			valores.add(v.strip())

	for nome in valores:
		if not frappe.db.exists("Banco", nome):
			frappe.get_doc({"doctype": "Banco", "nome": nome}).insert(ignore_permissions=True)

	frappe.db.commit()
