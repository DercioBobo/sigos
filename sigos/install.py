import json
import os
import frappe


# Doctypes whose names contain lowercase prepositions (de/do) that frappe.unscrub()
# title-cases, causing a name mismatch in orphan detection. Re-synced after every migrate.
_UNSCRUB_MISMATCH = [
	("security_ops", "posto_de_vigilancia"),
	("security_ops", "troca_de_regime"),
	("security_ops", "troca_de_categoria"),
	("security_ops", "escala_do_vigilante"),
	("security_ops", "tab_vigilante_do_posto"),
	("security_ops", "tabela_de_escala_de_vigilante"),
	("sigos_setup",  "grupo_de_delegados"),
	("armamento",    "alocacao_de_material"),
]


def after_install():
	_load_custom_fields()
	_load_default_data()
	_resync_mismatched_doctypes()


def after_migrate():
	_resync_mismatched_doctypes()


def _resync_mismatched_doctypes():
	"""
	Frappe's orphan detection calls frappe.unscrub() on folder names, which
	title-cases every word. Doctype names with lowercase prepositions ('de', 'do')
	don't match, so they get deleted on every migrate. Re-sync them immediately after.
	"""
	for module, doctype in _UNSCRUB_MISMATCH:
		try:
			frappe.reload_doc(module, "doctype", doctype, force=True)
		except Exception as e:
			frappe.log_error(
				f"SIGOS resync: {module}/{doctype} — {e}",
				"SIGOS After Migrate",
			)


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
