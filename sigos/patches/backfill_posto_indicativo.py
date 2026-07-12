import frappe


def execute():
	"""One-time backfill for the Posto De Vigilancia naming rework (2026-07-12):
	- indicativo is now mandatory and drives the new autoname/title — pre-existing
	  rows have no value, so seed it from the current name (the old user-typed
	  codename, e.g. BC-59, which IS the indicativo conceptually).
	- nome_financeiro is a new field defaulting to nome_do_posto for new records
	  (see Posto De Vigilancia.validate); backfill the same default here so
	  existing postos aren't left blank.
	"""
	frappe.db.sql(
		"""
		UPDATE `tabPosto De Vigilancia`
		SET indicativo = name
		WHERE indicativo IS NULL OR indicativo = ''
		"""
	)
	frappe.db.sql(
		"""
		UPDATE `tabPosto De Vigilancia`
		SET nome_financeiro = nome_do_posto
		WHERE nome_financeiro IS NULL OR nome_financeiro = ''
		"""
	)
	frappe.db.commit()
