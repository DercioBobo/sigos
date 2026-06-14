frappe.ui.form.on("Movimentacao De Arma", {
	refresh(frm) {
		frm.trigger("_filtrar_novo_posto");
	},

	referencia_da_arma(frm) {
		// A weapon stays within its delegação — scope the destination posto to it.
		if (frm.doc.novo_posto) {
			frm.set_value("novo_posto", "");
		}
		frm.trigger("_filtrar_novo_posto");
	},

	_filtrar_novo_posto(frm) {
		if (!frm.doc.referencia_da_arma) {
			frm.set_query("novo_posto", () => ({ filters: {} }));
			return;
		}
		frappe.db.get_value("Arma", frm.doc.referencia_da_arma, "delegacao").then((r) => {
			const deleg = r && r.message && r.message.delegacao;
			frm.set_query("novo_posto", () => ({
				filters: deleg ? { delegacao: deleg } : {},
			}));
		});
	},
});
