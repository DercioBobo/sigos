import frappe
from frappe import _


def execute():
	"""
	One-time backfill (2026-07-24) for Project Subsidio Item rows that predate
	aplicar_a/resumo_beneficiarios/vigilantes_json: every existing row was, in
	effect, "Todos do Projecto" (the only behaviour that existed before this
	change), so backfill them as such explicitly rather than leaving the new
	columns blank until the next time someone happens to save that Project.

	Direct DB writes: these are cosmetic/default-value columns on an existing
	child row, nothing to re-cascade.
	"""
	frappe.db.sql(
		"""
		UPDATE `tabProject Subsidio Item`
		SET aplicar_a = %(aplicar_a)s,
		    resumo_beneficiarios = %(resumo)s,
		    vigilantes_json = '[]'
		WHERE IFNULL(aplicar_a, '') = ''
		""",
		{"aplicar_a": "Todos do Projecto", "resumo": str(_("Todos"))},
	)
	frappe.db.commit()
