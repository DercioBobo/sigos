// Submitted participações: has the Jurista opened the Processo Disciplinar yet?
frappe.listview_settings["Participacao"] = {
	add_fields: ["processo_disciplinar", "repreensao", "docstatus", "gravidade"],
	get_indicator(doc) {
		if (doc.docstatus === 2) return [__("Cancelada"), "red", "docstatus,=,2"];
		if (doc.docstatus === 0) return [__("Rascunho"), "gray", "docstatus,=,0"];
		if (doc.processo_disciplinar) return [__("Processo Aberto"), "blue", "processo_disciplinar,is,set"];
		if (doc.repreensao) return [__("Repreendida"), "green", "repreensao,is,set"];
		return [__("Aguarda Jurista"), "orange", "docstatus,=,1|processo_disciplinar,is,not set|repreensao,is,not set"];
	},
};
