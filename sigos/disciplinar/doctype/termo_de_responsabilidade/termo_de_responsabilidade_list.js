frappe.listview_settings["Termo De Responsabilidade"] = {
	add_fields: ["documento_assinado", "docstatus"],
	get_indicator(doc) {
		if (doc.docstatus === 2) return [__("Cancelado"), "red", "docstatus,=,2"];
		if (doc.docstatus === 0) return [__("Rascunho"), "gray", "docstatus,=,0"];
		if (!doc.documento_assinado) return [__("Falta Assinado"), "orange", "docstatus,=,1|documento_assinado,is,not set"];
		return [__("Assinado"), "green", "documento_assinado,is,set"];
	},
};
