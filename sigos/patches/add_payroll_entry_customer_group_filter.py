import frappe

from sigos.install import _load_custom_fields


def execute():
	"""
	Add "Filtrar por Grupo de Cliente" (custom_customer_group) to Payroll Entry,
	positioned above "Filtrar por Cliente" (Delegação → Grupo de Cliente → Cliente
	→ Projecto → Situação). _load_custom_fields only CREATES fields that don't
	exist yet, so on a site that already had custom_customer installed from an
	earlier custom_fields.json, its insert_after needs to be re-pointed explicitly
	— same pattern as reorder_payroll_entry_filtros.
	"""
	_load_custom_fields()

	name = frappe.db.get_value(
		"Custom Field", {"dt": "Payroll Entry", "fieldname": "custom_customer"}
	)
	if name and frappe.db.get_value("Custom Field", name, "insert_after") != "custom_customer_group":
		frappe.db.set_value("Custom Field", name, "insert_after", "custom_customer_group")

	frappe.clear_cache(doctype="Payroll Entry")
	frappe.db.commit()
