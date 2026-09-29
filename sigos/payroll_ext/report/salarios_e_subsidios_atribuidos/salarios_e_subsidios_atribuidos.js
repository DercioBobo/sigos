frappe.query_reports["Salarios e Subsidios Atribuidos"] = {
	filters: [
		{ fieldname: "delegacao", label: __("Delegação"), fieldtype: "Link", options: "Delegacao" },
		{ fieldname: "cliente", label: __("Cliente"), fieldtype: "Link", options: "Customer" },
		{ fieldname: "funcionario", label: __("Funcionário"), fieldtype: "Link", options: "Employee" },
		{
			fieldname: "situacao", label: __("Situação"), fieldtype: "Select",
			options: ["Activos", "Todos"].join("\n"), default: "Activos",
		},
	],
};
