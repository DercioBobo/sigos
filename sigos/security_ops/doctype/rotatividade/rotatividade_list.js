frappe.listview_settings["Rotatividade"] = {
	onload(listview) {
		// The Rotatividade form itself is the wizard, so "new" just opens it.
		listview.page.add_inner_button(__("Nova Rotatividade"), () => {
			frappe.new_doc("Rotatividade");
		}).addClass("btn-primary");
	},
};
