frappe.listview_settings["Baixa Medica"] = {
	add_fields: ["estado"],
	get_indicator(doc) {
		return [__(doc.estado), doc.estado === "Em Curso" ? "orange" : "green", `estado,=,${doc.estado}`];
	},
};
