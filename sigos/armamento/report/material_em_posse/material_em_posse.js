frappe.query_reports["Material em Posse"] = {
	filters: [
		{
			fieldname: "delegacao",
			label: __("Delegação"),
			fieldtype: "Link",
			options: "Delegacao",
		},
		{
			fieldname: "posto",
			label: __("Posto"),
			fieldtype: "Link",
			options: "Posto De Vigilancia",
		},
		{
			fieldname: "vigilante",
			label: __("Vigilante"),
			fieldtype: "Link",
			options: "Vigilante",
		},
		{
			fieldname: "categoria",
			label: __("Categoria"),
			fieldtype: "Select",
			options: "\nEquipamento de Protecção\nUniforme\nVeículo\nComunicações\nOutro",
		},
	],
};
