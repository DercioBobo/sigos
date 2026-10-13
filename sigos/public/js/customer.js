// SIGOS — Customer helpers.
frappe.ui.form.on("Customer", {
	refresh(frm) {
		if (frm.is_new()) return;
		frm.add_custom_button(__("Faturar Mês"), () => sigos.faturar_mes(frm.doc.name), __("SIGOS"));
		frm.add_custom_button(__("Previsão de Faturação"), () => frappe.set_route("previsao-de-faturacao"), __("SIGOS"));
	},
});
