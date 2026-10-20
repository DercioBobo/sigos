frappe.listview_settings["Repreensao"] = {
	add_fields: ["numero", "processo_disciplinar", "docstatus"],
	get_indicator(doc) {
		if (doc.docstatus === 2) return [__("Cancelada"), "red", "docstatus,=,2"];
		if (doc.docstatus === 0) return [__("Rascunho"), "gray", "docstatus,=,0"];
		if (doc.processo_disciplinar) return [__("Com Processo"), "blue", "processo_disciplinar,is,set"];
		return [__("{0}.ª Repreensão", [doc.numero || "?"]), "orange", "docstatus,=,1"];
	},
};
