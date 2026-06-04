frappe.ui.form.on("Troca De Regime", {

	after_submit(frm) {
		if (frm.doc.workflow_state !== "Aprovado") return;
		sigos.wizard_actualizar_escalas({
			vigilante:       frm.doc.vigilante,
			tipo:            "troca_regime",
			novo_regime:     frm.doc.novo_regime,
			regime_anterior: frm.doc.regime_atual,
		});
	},

	onload(frm) {
		frm.set_query("vigilante", () => ({
			filters: { status: "Ativo" },
		}));
	},
});
