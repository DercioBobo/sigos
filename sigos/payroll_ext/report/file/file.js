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
};
