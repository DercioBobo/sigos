frappe.ui.form.on("Troca De Categoria", {
	onload(frm) {
		_filtro_vigilante(frm);
	},

	delegacao(frm) {
		if (frm.doc.vigilante) frm.set_value("vigilante", "");
		_filtro_vigilante(frm);
	},
});

// Scope the vigilante picker to Activo status, and to the chosen delegação if any.
function _filtro_vigilante(frm) {
	const deleg = frm.doc.delegacao;
	frm.set_query("vigilante", () => ({
		filters: deleg ? { status: "Activo", delegacao: deleg } : { status: "Activo" },
	}));
}
