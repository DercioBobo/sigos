import json
import os
import frappe


def after_install():
	_load_custom_fields()
	_load_default_data()
	_fix_tab_vigilante_do_posto()
	_set_project_naming()
	_clean_project_fields()
	_seccionar_contrato()


def after_migrate():
	# "Tab Vigilante Do Posto" is a child table that links to Turno (SIGOS Setup).
	# Frappe syncs modules alphabetically (security_ops before sigos_setup), so
	# Turno may not exist when this doctype is first synced — leaving app=NULL.
	# Orphan detection then deletes it every migrate. We restore it immediately after.
	_fix_tab_vigilante_do_posto()
	# Idempotent — creates any custom fields newly added to custom_fields.json
	# without disturbing existing ones.
	_load_custom_fields()
	_set_project_naming()
	_clean_project_fields()
	_seccionar_contrato()


def _seccionar_contrato():
	"""
	Put the SIGOS contract fields (valor, tarifas, subsídios) in their own section.
	custom_valor_do_contrato may pre-date the custom_sec_sigos break, and
	_load_custom_fields skips fields that already exist — so re-point it explicitly.
	The other two already chain after it. Idempotent.
	"""
	try:
		if not frappe.db.exists("Custom Field", {"dt": "Project", "fieldname": "custom_sec_sigos"}):
			return
		atual = frappe.db.get_value(
			"Custom Field", {"dt": "Project", "fieldname": "custom_valor_do_contrato"}, "insert_after"
		)
		if atual and atual != "custom_sec_sigos":
			frappe.db.set_value(
				"Custom Field", {"dt": "Project", "fieldname": "custom_valor_do_contrato"},
				"insert_after", "custom_sec_sigos",
			)
		frappe.clear_cache(doctype="Project")
	except Exception as e:
		frappe.log_error(f"SIGOS: seccionar contrato failed: {e}", "SIGOS Install")


def _fix_tab_vigilante_do_posto():
	try:
		frappe.reload_doc("security_ops", "doctype", "tab_vigilante_do_posto", force=True)
	except Exception as e:
		frappe.log_error(f"SIGOS: reload Tab Vigilante Do Posto failed: {e}", "SIGOS Install")


def _set_project_naming():
	"""
	Name the contract (Project) after the customer ('Access Bank 01') instead of
	PROJ-####. autoname=field:project_name makes the doc name = project_name (which
	contract_naming auto-fills), and links show it. Also lock the premise that every
	Project IS a client contract: customer is mandatory (Cliente is derived from it
	everywhere — posto, vigilante, billing). Idempotent (make_property_setter upserts).
	"""
	try:
		frappe.make_property_setter({
			"doctype": "Project", "doctype_or_field": "DocType",
			"property": "autoname", "value": "field:project_name", "property_type": "Data",
		})
		frappe.make_property_setter({
			"doctype": "Project", "doctype_or_field": "DocType",
			"property": "show_title_field_in_link", "value": "1", "property_type": "Check",
		})
		# Customer mandatory on every contract.
		frappe.make_property_setter({
			"doctype": "Project", "doctype_or_field": "DocField", "fieldname": "customer",
			"property": "reqd", "value": "1", "property_type": "Check",
		})
		frappe.db.commit()
	except Exception as e:
		frappe.log_error(f"SIGOS: set Project naming failed: {e}", "SIGOS Install")


def _clean_project_fields():
	"""
	Hide the standard ERPNext Project fields SIGOS doesn't use — Project is only a
	client CONTRACT here. We keep project_name, customer, status, is_active, company
	and the SIGOS custom fields (valor, tarifas, subsídios) visible. Section breaks are
	hidden too so no empty section headers are left behind. Orphan setters (fields that
	don't exist on this version) are harmless. Idempotent (make_property_setter upserts).
	"""
	ocultar = [
		# Whole sections to drop — real ERPNext v15 Project Section Break fieldnames.
		# (We KEEP "customer_details", which holds customer/project_name/status/is_active.)
		"users_section",     # Users
		"section_break0",    # Notes
		"section_break_18",  # Start and End Dates
		"project_details",   # Costing and Billing
		"margin",            # Margin
		"monitor_progress",  # Monitor Progress
		# Noise leaf-fields inside the kept "Customer Details" section
		"naming_series", "project_type", "priority", "department",
		"percent_complete_method", "percent_complete", "project_template",
		"copied_from", "sales_order",
		# Belt-and-suspenders: leaves inside the hidden sections above
		"expected_start_date", "expected_end_date",
		"actual_start_date", "actual_end_date", "actual_time",
		"notes", "collect_progress", "frequency", "from_time", "to_time",
		"first_email", "second_email", "daily_time_to_send", "day_to_send",
		"weekly_time_to_send", "message", "users", "holiday_list",
		"cost_center", "estimated_costing", "total_costing_amount",
		"total_purchase_cost", "total_sales_amount", "total_billable_amount",
		"total_billed_amount", "gross_margin", "per_gross_margin",
		"total_consumed_material_cost", "total_expense_claim",
	]
	for f in ocultar:
		try:
			frappe.make_property_setter({
				"doctype": "Project", "doctype_or_field": "DocField", "fieldname": f,
				"property": "hidden", "value": "1", "property_type": "Check",
			})
		except Exception as e:
			frappe.log_error(f"SIGOS: hide Project.{f} failed: {e}", "SIGOS Install")
	frappe.db.commit()


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
			"Categoria Vigilante":     "nome",
			"Turno":                   "turno_nome",
			"Regime":                  "nome",
			"Operacao De Rotatividade": "abreviatura",
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
