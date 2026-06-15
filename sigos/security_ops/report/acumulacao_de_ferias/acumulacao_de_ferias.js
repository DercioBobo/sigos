frappe.query_reports["Acumulacao de Ferias"] = {
	filters: [
		{
			fieldname: "employee",
			label: __("Colaborador"),
			fieldtype: "Link",
			options: "Employee",
			description: __("Seleccione um colaborador para ver o histórico de movimentos. Vazio = resumo de todos."),
		},
		{
			fieldname: "delegacao",
			label: __("Delegação"),
			fieldtype: "Link",
			options: "Delegacao",
		},
		{
			fieldname: "leave_type",
			label: __("Tipo de Licença"),
			fieldtype: "Link",
			options: "Leave Type",
		},
	],
};
