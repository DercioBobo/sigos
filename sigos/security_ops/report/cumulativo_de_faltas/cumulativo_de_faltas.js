frappe.query_reports["Cumulativo de Faltas"] = {
	filters: [
		{
			fieldname: "de_data", label: __("De"), fieldtype: "Date",
			default: frappe.datetime.month_start(), reqd: 1,
		},
		{
			fieldname: "ate_data", label: __("Até"), fieldtype: "Date",
			default: frappe.datetime.month_end(), reqd: 1,
		},
		{ fieldname: "delegacao", label: __("Delegação"), fieldtype: "Link", options: "Delegacao" },
		{ fieldname: "vigilante", label: __("Vigilante"), fieldtype: "Link", options: "Vigilante" },
	],
};
