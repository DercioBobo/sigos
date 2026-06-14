frappe.ui.form.on("Arma", {
	refresh(frm) {
		frm.trigger("_filtrar_posto");
	},

	delegacao(frm) {
		// Posto follows the delegação — clear a stale posto and rescope the picker.
		if (frm.doc.posto) {
			frm.set_value("posto", "");
		}
		frm.trigger("_filtrar_posto");
	},

	_filtrar_posto(frm) {
		frm.set_query("posto", () => ({
			filters: frm.doc.delegacao ? { delegacao: frm.doc.delegacao } : {},
		}));
	},
});
