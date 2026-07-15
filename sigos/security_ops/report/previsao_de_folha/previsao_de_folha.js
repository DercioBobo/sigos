frappe.query_reports["Previsao de Folha"] = {
	filters: [
		{ fieldname: "start_date", label: __("Início do Período"), fieldtype: "Date", reqd: 1 },
		{ fieldname: "end_date", label: __("Fim do Período"), fieldtype: "Date", reqd: 1 },
		{ fieldname: "delegacao", label: __("Delegação"), fieldtype: "Link", options: "Delegacao" },
		{ fieldname: "cliente", label: __("Cliente"), fieldtype: "Link", options: "Customer" },
		{ fieldname: "posto", label: __("Posto"), fieldtype: "Link", options: "Posto De Vigilancia" },
		{ fieldname: "project", label: __("Projecto"), fieldtype: "Link", options: "Project" },
		{
			fieldname: "situacao", label: __("Situação"), fieldtype: "Select",
			options: "Activos\nDemitidos\nTodos", default: "Activos",
		},
	],

	// Default the period to the current month, honouring the configured
	// cutoff day (SIGOS Settings.dia_corte_folha) — same suggestion the
	// Payroll Entry button uses, so the forecast lines up with what a real
	// run would use.
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
