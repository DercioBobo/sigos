import frappe


def execute():
	"""One-time backfill for the new Employee.custom_cliente ops-mirror field
	(2026-07-13, sync.py _OPS_MIRROR) — added so Diretório de Colaboradores can
	filter by Cliente without joining through Vigilante on every request. New
	saves are kept in sync going forward by vigilante_to_employee(); this just
	seeds existing rows from their linked Vigilante's cliente.
	"""
	frappe.db.sql(
		"""
		UPDATE `tabEmployee` e
		INNER JOIN `tabVigilante` v ON v.name = e.custom_vigilante
		SET e.custom_cliente = v.cliente
		WHERE v.cliente IS NOT NULL AND v.cliente != ''
		  AND (e.custom_cliente IS NULL OR e.custom_cliente = '')
		"""
	)
	frappe.db.commit()
