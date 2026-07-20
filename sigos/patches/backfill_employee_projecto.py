import frappe

from sigos.install import _load_custom_fields


def execute():
	"""One-time backfill for the new Employee.custom_project ops-mirror field
	(2026-07-20, sync.py _OPS_MIRROR) — added so Salary Structure Assignment can
	fetch_from employee.custom_project when the user picks an Employee. New
	saves are kept in sync going forward by vigilante_to_employee(); this just
	seeds existing rows from their linked Vigilante's projecto.

	Runs as a post_model_sync patch, which fires BEFORE the after_migrate hook
	that normally creates custom_fields.json fields — so custom_project may not
	exist yet on this site. Load custom fields here first to guarantee it does.
	"""
	_load_custom_fields()

	frappe.db.sql(
		"""
		UPDATE `tabEmployee` e
		INNER JOIN `tabVigilante` v ON v.name = e.custom_vigilante
		SET e.custom_project = v.projecto
		WHERE v.projecto IS NOT NULL AND v.projecto != ''
		  AND (e.custom_project IS NULL OR e.custom_project = '')
		"""
	)
	frappe.db.commit()
