frappe.ui.form.on("Alocacao de Material", {
	refresh(frm) {
		frm.set_query("material", "material_a_alocar", function (doc, cdt, cdn) {
			return {
				filters: [
					["categoria", "=", frm.doc.categoria]
				]
			};
		});
	},

	categoria(frm) {
		frm.set_query("material", "material_a_alocar", function (doc, cdt, cdn) {
			return {
				filters: [
					["categoria", "=", frm.doc.categoria]
				]
			};
		});
	}
});
