frappe.ui.form.on("Readimissao", {
	onload(frm) {
		frm.set_query("vigilante", () => ({
			filters: { status: "Demitido" }
		}));
	}
});
