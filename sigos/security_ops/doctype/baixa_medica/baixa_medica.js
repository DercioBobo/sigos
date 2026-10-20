frappe.ui.form.on("Baixa Medica", {
	refresh(frm) {
		if (frm.is_new()) return;
		frm.page.set_indicator(__(frm.doc.estado), frm.doc.estado === "Em Curso" ? "orange" : "green");
		frm.add_custom_button(__("Ver Vigilante"), () => frappe.set_route("Form", "Vigilante", frm.doc.vigilante));
		if (frm.doc.estado === "Em Curso") {
			frm.dashboard.set_headline_alert(
				__("Doente desde {0}. O regresso regista-se no Vigilante (Acções → Registar Regresso).",
					[frappe.datetime.str_to_user(frm.doc.data_inicio)]),
				"orange",
			);
		}
	},
});
