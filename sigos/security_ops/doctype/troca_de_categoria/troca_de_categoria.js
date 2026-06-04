frappe.ui.form.on("Troca de Categoria", {
	onload(frm) {
		frm.set_query("vigilante", () => ({
			filters: { status: "Ativo" }
		}));
	}
});
