app_name = "sigos"
app_title = "SIGOS"
app_publisher = "Dércio Bobo"
app_description = "Sistema Integrado de Gestão Operacional de Segurança"
app_email = "derciobob@gmail.com"
app_license = "MIT"
app_version = "0.0.1"

required_apps = ["frappe", "erpnext", "hrms"]

after_install = "sigos.install.after_install"
after_migrate = "sigos.install.after_migrate"

# ─── Assets ───────────────────────────────────────────────────────────────────
app_include_css = ["/assets/sigos/css/sigos.css"]
app_include_js = [
	"/assets/sigos/js/sigos.js",
	"/assets/sigos/js/escala_wizard.js",
]

# ─── Fixtures ─────────────────────────────────────────────────────────────────
fixtures = [
	{
		"dt": "Role",
		"filters": [["name", "in", [
			"Aprovador RH",
			"Aprovador Operações",
			"Operações SIGOS",
			"Supervisor SIGOS",
			"SIGOS Manager",
		]]],
	},
	{
		"dt": "Categoria Vigilante",
		"filters": [["nome", "in", [
			"Vigilante Normal", "Vigilante Armado", "Reserva", "Administrativo", "Supervisor",
		]]],
	},
	{
		"dt": "Operacao De Rotatividade",
		"filters": [["abreviatura", "in", ["RVP", "APV", "TPV", "DEM"]]],
	},
	{
		"dt": "Turno",
		"filters": [["turno_nome", "in", [
			"1a Manhã", "2a Manhã", "1a Noite", "2a Noite",
			"1a Folga", "2a Folga", "Normal", "Manhã", "Tarde", "24", "Folga",
		]]],
	},
	{
		"dt": "Regime",
		"filters": [["nome", "in", ["H24", "TDN", "TDU", "TDU-MT", "24h"]]],
	},
	{"dt": "Custom Field", "filters": [["module", "=", "SIGOS Setup"]]},
	{"dt": "Property Setter", "filters": [["module", "=", "SIGOS Setup"]]},
	{"dt": "Workflow", "filters": [["document_type", "in", [
		"Vigilante", "Rotatividade", "Ausencias",
		"Repreensao Disciplinar", "Processo Disciplinar",
		"Demissao", "Readimissao", "Troca De Categoria", "Troca De Regime",
		"Deducoes", "Proventos", "Justificacao De Faltas", "Reclamacao De Salario",
	]]]},
	{"dt": "Workflow State", "filters": [["workflow_state_name", "in", [
		"Rascunho", "Pendente De Aprovação", "Aprovado", "Rejeitado", "Cancelado",
	]]]},
]

# ─── Document Events ──────────────────────────────────────────────────────────
# NOTE: A doctype's OWN lifecycle handlers (on_submit, before_save, etc.) live as
# class methods on its controller and are auto-called by Frappe — they must NOT be
# duplicated here (pointing a doc_event at a module-level function that doesn't exist
# raises AttributeError on the event). Only cross-cutting hooks on OTHER apps'
# doctypes belong below.
doc_events = {
	"Vigilante": {
		"on_update": "sigos.sync.vigilante_to_employee",
	},
	"Employee": {
		"on_update": "sigos.sync.employee_to_vigilante",
	},
	"Salary Slip": {
		"before_insert": "sigos.payroll_ext.salary_slip_hooks.before_insert",
		"before_validate": "sigos.payroll_ext.salary_slip_hooks.before_validate",
		"before_submit": "sigos.payroll_ext.salary_slip_hooks.before_submit",
	},
}

# ─── Jinja (print formats) ────────────────────────────────────────────────────
jinja = {
	"methods": [
		"sigos.escala_print.render_escala_print",
	],
}

# ─── Scheduled Tasks ──────────────────────────────────────────────────────────
scheduler_events = {
	"daily": [
		"sigos.tasks.daily",
	],
}
