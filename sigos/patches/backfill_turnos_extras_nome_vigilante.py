import frappe


def execute():
	"""Turnos Extras.nome_do_vigilante (new): fetch_from only fills on save, so seed
	existing records (submitted ones included) from their linked Vigilante."""
	frappe.db.sql(
		"""
		UPDATE `tabTurnos Extras` te
		INNER JOIN `tabVigilante` v ON v.name = te.vigilante
		SET te.nome_do_vigilante = v.nome_completo
		WHERE te.nome_do_vigilante IS NULL OR te.nome_do_vigilante = ''
		"""
	)
	frappe.db.commit()
