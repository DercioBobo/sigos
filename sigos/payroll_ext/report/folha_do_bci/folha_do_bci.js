frappe.query_reports["Folha do BCI"] = {
	filters: [
		{ fieldname: "start_date", label: __("Início do Período"), fieldtype: "Date", reqd: 1 },
		{ fieldname: "end_date", label: __("Fim do Período"), fieldtype: "Date", reqd: 1 },
		{
			fieldname: "company",
			label: __("Empresa"),
			fieldtype: "Link",
			options: "Company",
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
