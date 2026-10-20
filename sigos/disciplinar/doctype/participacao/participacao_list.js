// Submitted participações: has the Jurista opened the Processo Disciplinar yet?
frappe.listview_settings["Participacao"] = {
	add_fields: ["processo_disciplinar", "docstatus", "gravidade"],
	get_indicator(doc) {
		if (doc.docstatus === 2) return [__("Cancelada"), "red", "docstatus,=,2"];
		if (doc.docstatus === 0) return [__("Rascunho"), "gray", "docstatus,=,0"];
		if (doc.processo_disciplinar) return [__("Processo Aberto"), "blue", "processo_disciplinar,is,set"];
		return [__("Sem Processo"), "orange", "docstatus,=,1|processo_disciplinar,is,not set"];
	},
};
