frappe.ui.form.on("Demissao", {

	after_submit(frm) {
		sigos.wizard_actualizar_escalas({
			vigilante: frm.doc.vigilante,
			tipo: "demissao",
		});
	},

	onload(frm) {
		frm.set_query("vigilante", () => ({
			filters: { status: "Ativo" },
		}));
	},
});
