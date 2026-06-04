import json
import os
import frappe


def after_install():
	_load_custom_fields()
	_load_default_data()
	_fix_tab_vigilante_do_posto()


def after_migrate():
	# "Tab Vigilante Do Posto" is a child table that links to Turno (SIGOS Setup).
	# Frappe syncs modules alphabetically (security_ops before sigos_setup), so
	# Turno may not exist when this doctype is first synced — leaving app=NULL.
	# Orphan detection then deletes it every migrate. We restore it immediately after.
	_fix_tab_vigilante_do_posto()


def _fix_tab_vigilante_do_posto():
	try:
		frappe.reload_doc("security_ops", "doctype", "tab_vigilante_do_posto", force=True)
	except Exception as e:
		frappe.log_error(f"SIGOS: reload Tab Vigilante Do Posto failed: {e}", "SIGOS Install")


def _load_custom_fields():
	path = os.path.join(os.path.dirname(__file__), "sigos_setup", "custom_fields.json")
	with open(path, encoding="utf-8") as f:
		fields = json.load(f)

	for field in fields:
		fieldname = field.get("fieldname")
		dt = field.get("dt")
		if not fieldname or not dt:
			continue
		if frappe.db.exists("Custom Field", {"dt": dt, "fieldname": fieldname}):
			continue
		doc = frappe.get_doc(field)
		doc.insert(ignore_permissions=True)

	frappe.db.commit()


def _load_default_data():
	path = os.path.join(os.path.dirname(__file__), "sigos_setup", "default_data.json")
	with open(path, encoding="utf-8") as f:
		records = json.load(f)

	for record in records:
		doctype = record.get("doctype")
		if not doctype:
			continue

		name_field = {
			"Categoria Vigilante": "nome",
			"Turno":               "turno_nome",
			"Regime":              "nome",
		}.get(doctype)

		if name_field:
			name_val = record.get(name_field)
			if name_val and frappe.db.exists(doctype, name_val):
				continue

		try:
			doc = frappe.get_doc(record)
			doc.insert(ignore_permissions=True)
		except Exception as e:
			frappe.log_error(
				f"SIGOS install: erro ao inserir {doctype} — {e}",
				"SIGOS After Install",
			)

	frappe.db.commit()
