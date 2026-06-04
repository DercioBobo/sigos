app_name = "sigos"
app_title = "SIGOS"
app_publisher = "Dércio Bobo"
app_description = "Sistema Integrado de Gestão Operacional de Segurança"
app_email = "derciobob@gmail.com"
app_license = "MIT"
app_version = "0.0.1"

required_apps = ["frappe", "erpnext", "hrms"]

after_install = "sigos.install.after_install"

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
		"Demissao", "Readimissao", "Troca de Categoria", "Troca de Regime",
		"Deducoes", "Proventos", "Justificacao De Faltas", "Reclamacao De Salario",
	]]]},
	{"dt": "Workflow State", "filters": [["workflow_state_name", "in", [
		"Rascunho", "Pendente De Aprovação", "Aprovado", "Rejeitado", "Cancelado",
	]]]},
]

# ─── Document Events ──────────────────────────────────────────────────────────
doc_events = {
	"Vigilante": {
		"on_update": "sigos.sync.vigilante_to_employee",
	},
	"Employee": {
		"on_update": "sigos.sync.employee_to_vigilante",
	},
	"Rotatividade": {
		"on_submit": "sigos.security_ops.doctype.rotatividade.rotatividade.on_submit",
		"before_submit": "sigos.security_ops.doctype.rotatividade.rotatividade.before_submit",
	},
	"Demissao": {
		"on_submit": "sigos.security_ops.doctype.demissao.demissao.on_submit",
	},
	"Readimissao": {
		"on_submit": "sigos.disciplinar.doctype.readimissao.readimissao.on_submit",
	},
	"Troca de Categoria": {
		"on_submit": "sigos.security_ops.doctype.troca_de_categoria.troca_de_categoria.on_submit",
	},
	"Troca de Regime": {
		"on_submit": "sigos.security_ops.doctype.troca_de_regime.troca_de_regime.on_submit",
	},
	"Repreensao Disciplinar": {
		"on_update": "sigos.disciplinar.doctype.repreensao_disciplinar.repreensao_disciplinar.on_update",
	},
	"Processo Disciplinar": {
		"on_update": "sigos.disciplinar.doctype.processo_disciplinar.processo_disciplinar.on_update",
		"on_submit": "sigos.disciplinar.doctype.processo_disciplinar.processo_disciplinar.on_submit",
	},
	"Ausencias": {
		"before_save": "sigos.security_ops.doctype.ausencias.ausencias.before_save",
	},
	"Movimentacao De Arma": {
		"before_insert": "sigos.armamento.doctype.movimentacao_de_arma.movimentacao_de_arma.before_insert",
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
