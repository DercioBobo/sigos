frappe.query_reports["Folha Processada"] = {
	filters: [
		{ fieldname: "start_date", label: __("Início do Período"), fieldtype: "Date", reqd: 1 },
		{ fieldname: "end_date", label: __("Fim do Período"), fieldtype: "Date", reqd: 1 },
		{ fieldname: "delegacao", label: __("Delegação"), fieldtype: "Link", options: "Delegacao" },
		{
			fieldname: "customer_group",
			label: __("Grupo de Cliente"),
			fieldtype: "Link",
			options: "Customer Group",
			on_change: (report) => {
				const grupo = report.get_filter_value("customer_group");
				const cliente = report.get_filter_value("cliente");
				if (grupo && cliente) {
					frappe.db.get_value("Customer", cliente, "customer_group").then((r) => {
						if (r.message && r.message.customer_group !== grupo) {
							report.set_filter_value("cliente", "");
							report.refresh();
						}
					});
				} else {
					report.refresh();
				}
			},
		},
		{
			fieldname: "cliente",
			label: __("Cliente"),
			fieldtype: "Link",
			options: "Customer",
			get_query: () => {
				const grupo = frappe.query_report.get_filter_value("customer_group");
				return grupo ? { filters: { customer_group: grupo } } : {};
			},
		},
		{ fieldname: "posto", label: __("Posto"), fieldtype: "Link", options: "Posto De Vigilancia" },
		{ fieldname: "project", label: __("Projecto"), fieldtype: "Link", options: "Project" },
		{
			fieldname: "situacao", label: __("Situação"), fieldtype: "Select",
			options: "Activos\nDemitidos\nTodos", default: "Activos",
		},
	],

	// Same period suggestion as Previsão de Folha, honouring the configured
	// cutoff day (SIGOS Settings.dia_corte_folha) — so it's easy to compare the
	// forecast against what was actually processed for the same month.
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
