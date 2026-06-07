import frappe


def execute():
	"""
	Standardise status spelling on existing records:
	  Vigilante.status         'Ativo'  -> 'Activo'   ('Inactivo' was already correct)
	  Posto De Vigilancia.estado 'Ativo' -> 'Activo', 'Inativo' -> 'Inactivo'
	Idempotent — re-running matches nothing once converted.
	"""
	if frappe.db.table_exists("Vigilante"):
		frappe.db.sql("UPDATE `tabVigilante` SET status = 'Activo' WHERE status = 'Ativo'")

	if frappe.db.table_exists("Posto De Vigilancia"):
		frappe.db.sql("UPDATE `tabPosto De Vigilancia` SET estado = 'Activo' WHERE estado = 'Ativo'")
		frappe.db.sql("UPDATE `tabPosto De Vigilancia` SET estado = 'Inactivo' WHERE estado = 'Inativo'")

	frappe.db.commit()
