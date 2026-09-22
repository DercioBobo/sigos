frappe.query_reports["Rotatividades"] = {
	filters: [
		{ fieldname: "de_data", label: __("De"), fieldtype: "Date" },
		{ fieldname: "ate_data", label: __("Até"), fieldtype: "Date" },
		{ fieldname: "delegacao", label: __("Delegação"), fieldtype: "Link", options: "Delegacao" },
		{ fieldname: "vigilante", label: __("Vigilante"), fieldtype: "Link", options: "Vigilante" },
		{
			fieldname: "posto", label: __("Posto (Antigo ou Novo)"), fieldtype: "Link",
			options: "Posto De Vigilancia",
		},
		{
			fieldname: "abreviatura_op", label: __("Operação"), fieldtype: "Link",
			options: "Operacao De Rotatividade",
		},
		{
			fieldname: "motivo", label: __("Tipo de Rotatividade"), fieldtype: "Select",
			options: "\nTransferência\nReserva\nDemissão\nDisciplinar\nOutro",
		},
		{
			fieldname: "status", label: __("Estado"), fieldtype: "Select",
			options: "Todos\nRascunho\nAprovado\nCancelado", default: "Todos",
		},
	],
};
