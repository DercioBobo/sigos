import frappe

from sigos.install import _load_custom_fields


def execute():
	"""
	sigos.install._load_custom_fields only CREATES custom fields that don't
	exist yet — it deliberately never touches ones already present, so it
	doesn't clobber manual Customize Form tweaks made in prod. That's normally
	right, but it means the fetch_from added to Salary Structure Assignment's
	custom_cliente/custom_project (2026-07-20) never applied: both fields were
	already created on an earlier migrate, before fetch_from existed on them.
	Patch it in directly instead of widening the loader's blast radius.
	"""
	_load_custom_fields()

	updates = {
		"custom_cliente": "employee.custom_cliente",
		"custom_project": "employee.custom_project",
	}
	for fieldname, fetch_from in updates.items():
		name = frappe.db.get_value(
			"Custom Field", {"dt": "Salary Structure Assignment", "fieldname": fieldname}
		)
		if name and frappe.db.get_value("Custom Field", name, "fetch_from") != fetch_from:
			frappe.db.set_value("Custom Field", name, "fetch_from", fetch_from)

	frappe.clear_cache(doctype="Salary Structure Assignment")
	frappe.db.commit()
