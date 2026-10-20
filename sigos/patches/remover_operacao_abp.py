import frappe


def execute():
	"""The ABP ("Abandono de Posto") Rotatividade operation is obsolete: a guard in
	Abandono now keeps posto + escala and is handled by a Presunção de Abandono.
	Delete it when nothing references it, otherwise just deactivate it (history)."""
	if not frappe.db.exists("Operacao De Rotatividade", "ABP"):
		return
	if frappe.db.exists("Rotatividade", {"abreviatura_op": "ABP"}):
		frappe.db.set_value("Operacao De Rotatividade", "ABP", "activo", 0)
	else:
		frappe.delete_doc("Operacao De Rotatividade", "ABP", ignore_permissions=True, force=True)
	frappe.db.commit()
