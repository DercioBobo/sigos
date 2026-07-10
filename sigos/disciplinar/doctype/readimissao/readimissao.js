frappe.ui.form.on("Readimissao", {
	onload(frm) {
		frm.set_query("vigilante", () => ({
			filters: { status: "Demitido" }
		}));
	},

	vigilante(frm) {
		_mostrar_ultima_demissao(frm);
	},
});

// Show why the guard left last time (their most recent submitted Demissao) as
// soon as they're picked — helps RH decide on the readmission. The same data is
// also snapshotted server-side on save (validate()) so it isn't lost either way.
function _mostrar_ultima_demissao(frm) {
	if (!frm.doc.vigilante) {
		frm.set_value("motivo_ultima_demissao", "");
		frm.set_value("data_ultima_demissao", "");
		frm.set_value("observacoes_ultima_demissao", "");
		return;
	}
	frappe.call({
		method: "sigos.disciplinar.doctype.readimissao.readimissao.ultima_demissao",
		args: { vigilante: frm.doc.vigilante },
		callback(r) {
			const d = r.message || {};
			frm.set_value("motivo_ultima_demissao", d.motivo || "");
			frm.set_value("data_ultima_demissao", d.data_de_demissao || "");
			frm.set_value("observacoes_ultima_demissao", d.observacoes || "");
		},
	});
}
