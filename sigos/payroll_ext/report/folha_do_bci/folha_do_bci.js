frappe.query_reports["Folha do BCI"] = {
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
	],
};
