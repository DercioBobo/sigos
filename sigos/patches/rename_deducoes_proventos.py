import frappe

# Rename the two payroll doctypes to their clearer names. Runs in [pre_model_sync]
# so the DB tables/links are renamed BEFORE the model sync imports the new JSON
# (otherwise sync would create empty "Outras *" doctypes alongside the old ones).
RENAMES = (
	("Deducoes", "Outras Deducoes"),
	("Proventos", "Outras Remuneracoes"),
)


def execute():
	for old, new in RENAMES:
		if frappe.db.exists("DocType", old) and not frappe.db.exists("DocType", new):
			frappe.rename_doc("DocType", old, new, force=True)
	frappe.db.commit()
