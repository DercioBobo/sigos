import frappe

# Outras Deducoes.tipo changed from a Select (Deducoes Diversas / Uniforme /
# Processo Disciplinar) into a Link to Salary Component — each record now carries
# its own deduction component directly (like Outras Remuneracoes.tipo_de_subsidios),
# and the salary-slip hook reads it verbatim. Existing records still hold the old
# Select labels, so remap them to the configured Salary Component (same fallbacks the
# slip used before). Idempotent: only rows still holding an old label are touched.

OLD_LABELS = {
	"Deducoes Diversas":    ("componente_deducoes_diversas", "Deducoes diversas"),
	"Uniforme":             ("componente_uniforme", "Uniforme"),
	"Processo Disciplinar": ("componente_processo_disciplinar", "Processo Disciplinar"),
}


def execute():
	if not frappe.db.has_column("Outras Deducoes", "tipo"):
		return

	settings = frappe.get_single("SIGOS Settings")
	for label, (setting_field, fallback) in OLD_LABELS.items():
		componente = settings.get(setting_field) or fallback
		if label == componente:
			continue  # already the resolved component name
		if not frappe.db.exists("Salary Component", componente):
			frappe.log_error(
				f"remap_deducoes_tipo_componente: componente '{componente}' "
				f"(para '{label}') não existe — registos mantêm o valor antigo.",
				"SIGOS Remap Deducoes",
			)
			continue
		frappe.db.set_value(
			"Outras Deducoes", {"tipo": label}, "tipo", componente,
			update_modified=False,
		)

	frappe.db.commit()
