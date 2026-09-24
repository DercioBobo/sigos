frappe.query_reports["Demissoes"] = {
	filters: [
		{ fieldname: "de_data", label: __("De"), fieldtype: "Date" },
		{ fieldname: "ate_data", label: __("Até"), fieldtype: "Date" },
		{ fieldname: "delegacao", label: __("Delegação"), fieldtype: "Link", options: "Delegacao" },
		{ fieldname: "vigilante", label: __("Vigilante"), fieldtype: "Link", options: "Vigilante" },
		{ fieldname: "posto", label: __("Último Posto"), fieldtype: "Link", options: "Posto De Vigilancia" },
		{
			fieldname: "motivo", label: __("Motivo"), fieldtype: "Select",
			options: "\nAbandono\nRescisão\nDisciplinar\nFim de Contrato\nOutro Motivo",
		},
		{
			fieldname: "origem", label: __("Origem"), fieldtype: "Select",
			options: "\nRotatividade\nProcesso Disciplinar\nManual",
		},
		{
			fieldname: "uniforme", label: __("Uniforme"), fieldtype: "Select",
			options: "\nEntregue\nNão Entregue",
		},
		{
			fieldname: "status", label: __("Estado"), fieldtype: "Select",
			options: "Todos\nRascunho\nAprovado\nCancelado", default: "Aprovado",
		},
	],
};
