frappe.ui.form.on("Troca De Regime", {

	// Escala migration is handled automatically server-side (on_submit):
	// the guard is moved from the old posto+regime escala to the new one.
	after_submit(frm) {
		frm.reload_doc();
	},

	onload(frm) {
		frm.set_query("vigilante", () => ({
			filters: { status: "Ativo" },
		}));
	},
});
