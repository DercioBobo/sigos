frappe.query_reports["File"] = {
	filters: [
		{
			fieldname: "de_data",
			label: __("De"),
			fieldtype: "Date",
			default: frappe.datetime.month_start(),
		},
		{
			fieldname: "ate_data",
			label: __("Até"),
			fieldtype: "Date",
			default: frappe.datetime.month_end(),
		},
		{
			fieldname: "company",
			label: __("Empresa"),
			fieldtype: "Link",
			options: "Company",
		},
		{
			fieldname: "customer",
			label: __("Cliente"),
			fieldtype: "Link",
			options: "Customer",
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
};
