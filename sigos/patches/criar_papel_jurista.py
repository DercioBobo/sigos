import frappe


def execute():
	"""Role for whoever handles Presunções de Abandono (and, later, the Processo
	Disciplinar). Pre-model-sync so the Presuncao De Abandono permissions find it."""
	if not frappe.db.exists("Role", "Jurista"):
		frappe.get_doc({"doctype": "Role", "role_name": "Jurista", "desk_access": 1}).insert(
			ignore_permissions=True
		)
		frappe.db.commit()
