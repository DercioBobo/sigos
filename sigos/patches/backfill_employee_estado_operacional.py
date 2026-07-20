import frappe

from sigos.install import _load_custom_fields


def execute():
	"""One-time backfill for the new Employee.custom_estado_operacional
	ops-mirror field (2026-07-20, sync.py _OPS_MIRROR) — mirrors Vigilante.status
	so Employee can distinguish Activo/Reserva/Inactivo, which its own native
	status field (Active/Suspended/Left) can't. New saves are kept in sync going
	forward by vigilante_to_employee(); this just seeds existing rows from their
	linked Vigilante's status.

	Runs as a post_model_sync patch, which fires BEFORE the after_migrate hook
	that normally creates custom_fields.json fields — so custom_estado_operacional
	may not exist yet on this site. Load custom fields here first to guarantee it does.
	"""
	_load_custom_fields()

	frappe.db.sql(
		"""
		UPDATE `tabEmployee` e
		INNER JOIN `tabVigilante` v ON v.name = e.custom_vigilante
		SET e.custom_estado_operacional = v.status
		WHERE v.status IS NOT NULL AND v.status != ''
		  AND (e.custom_estado_operacional IS NULL OR e.custom_estado_operacional = '')
		"""
	)
	frappe.db.commit()
