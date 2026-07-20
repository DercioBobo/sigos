import frappe

from sigos.install import _load_custom_fields


def execute():
	"""
	Reorder the Payroll Entry filter fields to Delegação → Cliente → Projecto →
	Situação. _load_custom_fields only CREATES fields that don't exist yet, so it
	never re-points insert_after on ones already installed from an earlier
	custom_fields.json — patch the ordering in directly instead.
	"""
	_load_custom_fields()

	updates = {
		"custom_delegacao": "company",
		"custom_customer": "custom_delegacao",
		"custom_project": "custom_customer",
	}
	for fieldname, insert_after in updates.items():
		name = frappe.db.get_value(
			"Custom Field", {"dt": "Payroll Entry", "fieldname": fieldname}
		)
		if name and frappe.db.get_value("Custom Field", name, "insert_after") != insert_after:
			frappe.db.set_value("Custom Field", name, "insert_after", insert_after)

	frappe.clear_cache(doctype="Payroll Entry")
	frappe.db.commit()
