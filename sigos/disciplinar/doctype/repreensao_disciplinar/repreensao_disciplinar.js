frappe.ui.form.on("Repreensao Disciplinar", {
	onload(frm) {
		frm.set_query("vigilante", () => ({
			filters: { status: "Ativo" }
		}));

		frm.set_query("funcionario", () => ({
			filters: { status: "Active" }
		}));
	}
});
