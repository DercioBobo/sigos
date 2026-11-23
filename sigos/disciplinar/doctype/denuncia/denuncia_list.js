frappe.listview_settings["Denuncia"] = {
	add_fields: ["demissao", "docstatus"],
	get_indicator(doc) {
		if (doc.docstatus === 2) return [__("Cancelada"), "gray", "docstatus,=,2"];
		if (doc.docstatus === 0) return [__("Rascunho"), "orange", "docstatus,=,0"];
		return [__("Demitido"), "red", "docstatus,=,1"];
	},
};
