frappe.ui.form.on("Troca De Categoria", {
	onload(frm) {
		frm.set_query("vigilante", () => ({
			filters: { status: "Activo" }
		}));
	}
});
