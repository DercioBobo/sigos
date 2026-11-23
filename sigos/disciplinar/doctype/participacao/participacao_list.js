// Submitted participações: has the Jurista opened the Processo Disciplinar yet?
frappe.listview_settings["Participacao"] = {
	add_fields: ["processo_disciplinar", "repreensao", "termo_responsabilidade", "denuncia", "recusada", "docstatus", "gravidade"],
	get_indicator(doc) {
		if (doc.docstatus === 2) return [__("Cancelada"), "red", "docstatus,=,2"];
		if (doc.docstatus === 0) return [__("Rascunho"), "gray", "docstatus,=,0"];
		if (doc.recusada) return [__("Recusada"), "darkgrey", "recusada,=,1"];
		if (doc.denuncia) return [__("Denúncia"), "red", "denuncia,is,set"];
		if (doc.processo_disciplinar) return [__("Processo Aberto"), "blue", "processo_disciplinar,is,set"];
		if (doc.repreensao) return [__("Repreendida"), "green", "repreensao,is,set"];
		if (doc.termo_responsabilidade) return [__("Com Termo"), "green", "termo_responsabilidade,is,set"];
		return [__("Aguarda Jurista"), "orange",
			"docstatus,=,1|processo_disciplinar,is,not set|repreensao,is,not set|termo_responsabilidade,is,not set|denuncia,is,not set|recusada,=,0"];
	},
};
