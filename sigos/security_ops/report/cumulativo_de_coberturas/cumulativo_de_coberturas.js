const SIGOS_MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
	"Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

frappe.query_reports["Cumulativo de Coberturas"] = {
	filters: [
		{
			fieldname: "mes", label: __("Mês"), fieldtype: "Select", reqd: 1,
			options: SIGOS_MESES.join("\n"),
			default: SIGOS_MESES[new Date().getMonth()],
		},
		{
			fieldname: "ano", label: __("Ano"), fieldtype: "Int", reqd: 1,
			default: new Date().getFullYear(),
		},
		{ fieldname: "delegacao", label: __("Delegação"), fieldtype: "Link", options: "Delegacao" },
		{ fieldname: "vigilante", label: __("Vigilante"), fieldtype: "Link", options: "Vigilante" },
		{
			fieldname: "accao", label: __("Acção"), fieldtype: "Select",
			options: ["", "Dobra de Turno", "Meia Dobra", "Horas Extras"].join("\n"),
		},
	],
};
