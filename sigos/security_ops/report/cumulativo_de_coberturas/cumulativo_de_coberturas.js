frappe.query_reports["Cumulativo de Coberturas"] = {
	filters: [
		{
			fieldname: "de_data", label: __("De"), fieldtype: "Date",
			default: frappe.datetime.year_start(), reqd: 1,
		},
		{
			fieldname: "ate_data", label: __("Até"), fieldtype: "Date",
			default: frappe.datetime.month_end(), reqd: 1,
		},
		{ fieldname: "delegacao", label: __("Delegação"), fieldtype: "Link", options: "Delegacao" },
		{ fieldname: "vigilante", label: __("Vigilante (que cobriu)"), fieldtype: "Link", options: "Vigilante" },
		{
			fieldname: "accao", label: __("Acção"), fieldtype: "Select",
			options: ["", "Substituto", "Dobra de Turno", "Meia Dobra", "Adiantamento de Turno", "Horas Extras"].join("\n"),
		},
	],
};
