import frappe


def execute():
	"""
	Arma.estado relabel (2026-07-17): 'Operacional' -> 'Boas Condições – Operacional',
	'Abatida' -> 'Arsenal' (a stored weapon, not a written-off one — 'Avariado' is the
	new broken/malfunctioning state and has no old value to migrate). Idempotent —
	re-running matches nothing once converted.
	"""
	if not frappe.db.table_exists("Arma"):
		return

	frappe.db.sql(
		"UPDATE `tabArma` SET estado = 'Boas Condições – Operacional' WHERE estado = 'Operacional'"
	)
	frappe.db.sql("UPDATE `tabArma` SET estado = 'Arsenal' WHERE estado = 'Abatida'")
	frappe.db.commit()
