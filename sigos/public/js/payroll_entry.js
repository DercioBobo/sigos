// SIGOS - Payroll Entry: suggest start_date/end_date for the configured
// payroll cutoff day (SIGOS Settings.dia_corte_folha).
//
// Payroll Entry has no month/year doctype fields of its own — start_date/
// end_date are the only real period fields, and HRMS's own auto-population
// (when it runs) assumes a plain calendar month. This button proposes the
// cutoff-aligned dates for a picked month instead — a suggestion the user can
// still freely edit before generating slips, never a forced overwrite (see
// sigos.api.sugerir_periodo_folha).

const MESES_PT = [
	"Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
	"Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

frappe.ui.form.on("Payroll Entry", {
	refresh(frm) {
		if (frm.doc.docstatus !== 0) return;
		frm.add_custom_button(__("Sugerir Período (Dia de Corte)"), () => _sugerir_periodo(frm));
		_set_project_query(frm);
	},

	// Projecto determina Cliente de forma inequívoca (1 Projecto = 1 Customer) —
	// preenche automaticamente. O inverso não vale (1 Cliente pode ter vários
	// Projectos), por isso Cliente só restringe a lista, nunca define o Projecto.
	custom_project(frm) {
		_set_project_query(frm);
		if (!frm.doc.custom_project) return;
		frappe.db.get_value("Project", frm.doc.custom_project, "customer").then((r) => {
			const cliente = r.message && r.message.customer;
			if (cliente && frm.doc.custom_customer !== cliente) {
				frm.set_value("custom_customer", cliente);
			}
		});
	},

	// Mudar o Cliente invalida um Projecto já escolhido que pertença a outro
	// customer — mantê-lo criaria uma combinação Cliente+Projecto impossível de
	// satisfazer (nenhum Employee bate as duas condições ao mesmo tempo), o que
	// antes já esvaziou silenciosamente a tabela de employees no save.
	custom_customer(frm) {
		_set_project_query(frm);
		if (!frm.doc.custom_project) return;
		frappe.db.get_value("Project", frm.doc.custom_project, "customer").then((r) => {
			const cliente = r.message && r.message.customer;
			if (cliente && cliente !== frm.doc.custom_customer) {
				frm.set_value("custom_project", "");
			}
		});
	},
});

function _set_project_query(frm) {
	frm.set_query("custom_project", () => ({
		filters: frm.doc.custom_customer ? { customer: frm.doc.custom_customer } : {},
	}));
}

function _sugerir_periodo(frm) {
	const hoje = frappe.datetime.get_today().split("-");
	const anoAtual = parseInt(hoje[0], 10);
	const mesAtual = parseInt(hoje[1], 10);

	const d = new frappe.ui.Dialog({
		title: __("Sugerir Período de Folha"),
		fields: [
			{
				fieldname: "mes", fieldtype: "Select", label: __("Mês"), reqd: 1,
				options: MESES_PT.join("\n"), default: MESES_PT[mesAtual - 1],
				description: __("O período sugerido é arquivado sob o mês em que TERMINA (ex.: dia de corte 25 → 25 Jun–24 Jul = Julho)."),
			},
			{ fieldname: "ano", fieldtype: "Int", label: __("Ano"), reqd: 1, default: anoAtual },
		],
		primary_action_label: __("Sugerir"),
		primary_action(vals) {
			const mesNum = MESES_PT.indexOf(vals.mes) + 1;
			frappe.call({
				method: "sigos.api.sugerir_periodo_folha",
				args: { ano: vals.ano, mes: mesNum },
				callback: (r) => {
					if (!r.message) return;
					frm.set_value("start_date", r.message.data_de_inicio);
					frm.set_value("end_date", r.message.data_de_fim);
					d.hide();
					frappe.show_alert({
						message: __("Período sugerido: {0} a {1}. Pode ajustar antes de gerar as folhas.", [
							frappe.datetime.str_to_user(r.message.data_de_inicio),
							frappe.datetime.str_to_user(r.message.data_de_fim),
						]),
						indicator: "blue",
					}, 6);
				},
			});
		},
	});
	d.show();
}
