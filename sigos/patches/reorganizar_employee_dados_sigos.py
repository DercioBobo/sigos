import frappe

from sigos.install import _load_custom_fields


def execute():
	"""
	Reorganize the SIGOS custom fields on Employee into a proper 3-column
	section instead of the old ad-hoc layout (fields chained straight off the
	native employee_name field, with two Column Breaks stacked on top of
	whatever columns the native Basic Info section already had — up to 5
	columns wide in practice).

	New layout, one Section Break ("Dados SIGOS") with exactly 3 columns:
	  1. Identificação & Documento: Vigilante, Estado Operacional, Mecanográfico,
	     Tipo/Nº de Documento, NUIT
	  2. Alocação Operacional: Categoria, Tipo de Vigilante, Regime, Delegação,
	     Posto, Cliente, Projecto
	  3. Bancário & Contacto: INSS, Banco, Conta, NIB, Contacto Alternativo,
	     Residência, Dependentes

	custom_sec_dados_sigos is a brand-new field (created below by
	_load_custom_fields); everything else already exists on installed sites and
	only needs its insert_after re-pointed — _load_custom_fields only creates
	fields that don't exist yet, so it never touches those on its own.
	"""
	_load_custom_fields()

	updates = {
		"custom_vigilante":            "custom_sec_dados_sigos",
		"custom_estado_operacional":   "custom_vigilante",
		"custom_mecanografico":        "custom_estado_operacional",
		"custom_tipo_documento":       "custom_mecanografico",
		"custom_numero_documento":     "custom_tipo_documento",
		"custom_nuit":                 "custom_numero_documento",
		"custom_col_dados_sigos":      "custom_nuit",
		"custom_categoria":            "custom_col_dados_sigos",
		"custom_tipo_de_vigilante":    "custom_categoria",
		"custom_regime":               "custom_tipo_de_vigilante",
		"custom_delegacao":            "custom_regime",
		"custom_posto":                "custom_delegacao",
		"custom_cliente":              "custom_posto",
		"custom_project":              "custom_cliente",
		"custom_col_bancario":         "custom_project",
		"custom_inss":                 "custom_col_bancario",
		"custom_banco":                "custom_inss",
		"custom_conta":                "custom_banco",
		"custom_contanib":             "custom_conta",
		"custom_contacto_alternativo": "custom_contanib",
		"custom_residencia":           "custom_contacto_alternativo",
		"custom_dependentes":          "custom_residencia",
	}
	for fieldname, insert_after in updates.items():
		name = frappe.db.get_value("Custom Field", {"dt": "Employee", "fieldname": fieldname})
		if name and frappe.db.get_value("Custom Field", name, "insert_after") != insert_after:
			frappe.db.set_value("Custom Field", name, "insert_after", insert_after)

	frappe.clear_cache(doctype="Employee")
	frappe.db.commit()
