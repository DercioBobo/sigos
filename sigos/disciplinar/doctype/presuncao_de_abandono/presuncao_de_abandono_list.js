frappe.listview_settings["Presuncao De Abandono"] = {
	add_fields: ["estado"],
	get_indicator(doc) {
		const cor = {
			"Aberta": "red", "Em Análise": "orange", "Encaminhada para Processo": "purple",
			"Regressou": "green", "Concluída": "gray", "Arquivada": "gray",
		}[doc.estado] || "gray";
		return [__(doc.estado), cor, `estado,=,${doc.estado}`];
	},
};
