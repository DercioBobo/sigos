frappe.listview_settings["Rotatividade"] = {
	onload(listview) {
		listview.page.add_inner_button(__("Nova Rotatividade (Assistente)"), () => {
			sigos.rotatividade_wizard();
		}).addClass("btn-primary");
	},
};
