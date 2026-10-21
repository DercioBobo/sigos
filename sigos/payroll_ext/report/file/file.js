frappe.query_reports["File"] = {
	filters: [
		{ fieldname: "start_date", label: __("Início do Período"), fieldtype: "Date", reqd: 1 },
		{ fieldname: "end_date", label: __("Fim do Período"), fieldtype: "Date", reqd: 1 },
		{
			fieldname: "company",
			label: __("Empresa"),
			fieldtype: "Link",
			options: "Company",
		},
		{
			fieldname: "customer_group",
			label: __("Grupo de Cliente"),
			fieldtype: "Link",
			options: "Customer Group",
			on_change: (report) => {
				const grupo = report.get_filter_value("customer_group");
				const cliente = report.get_filter_value("customer");
				if (grupo && cliente) {
					frappe.db.get_value("Customer", cliente, "customer_group").then((r) => {
						if (r.message && r.message.customer_group !== grupo) {
							report.set_filter_value("customer", "");
							report.refresh();
						}
					});
				} else {
					report.refresh();
				}
			},
		},
		{
			fieldname: "customer",
			label: __("Cliente"),
			fieldtype: "Link",
			options: "Customer",
			get_query: () => {
				const grupo = frappe.query_report.get_filter_value("customer_group");
				return grupo ? { filters: { customer_group: grupo } } : {};
			},
			on_change: (report) => {
				report.set_filter_value("project", "");
				report.refresh();
			},
		},
		{
			fieldname: "project",
			label: __("Projecto"),
			fieldtype: "Link",
			options: "Project",
			get_query: () => {
				const cliente = frappe.query_report.get_filter_value("customer");
				return cliente ? { filters: { customer: cliente } } : {};
			},
		},
	],

	// Suggest the current payroll period, honouring SIGOS Settings.dia_corte_folha.
	onload(report) {
		const hoje = frappe.datetime.get_today().split("-");
		frappe.call({
			method: "sigos.api.sugerir_periodo_folha",
			args: { ano: parseInt(hoje[0], 10), mes: parseInt(hoje[1], 10) },
			callback: (r) => {
				if (!r.message) return;
				report.set_filter_value("start_date", r.message.data_de_inicio);
				report.set_filter_value("end_date", r.message.data_de_fim);
			},
		});
	},
};
