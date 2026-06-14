// SIGOS — contract (Project) helpers.
// "Aplicar Salário Base" pushes the per-regime base salary defined in this
// contract onto every active vigilante's Salary Structure Assignment. Vigilantes
// with a manual override keep it (the resolver prefers the override), so re-running
// is always safe.
frappe.ui.form.on("Project", {
	refresh(frm) {
		if (frm.is_new()) return;

		frm.add_custom_button(__("Aplicar Salário Base"), () => {
			frappe.warn(
				__("Aplicar Salário Base"),
				__(
					"Isto vai atribuir o salário base (por regime, definido neste contrato) " +
					"a todos os vigilantes <b>Activos</b> deste contrato, criando/actualizando " +
					"a respectiva Salary Structure Assignment.<br><br>" +
					"Vigilantes com <b>Salário Base (manual)</b> mantêm o valor manual. Continuar?"
				),
				() => {
					frappe.call({
						method: "sigos.api.aplicar_salario_base",
						args: { project: frm.doc.name },
						freeze: true,
						freeze_message: __("A atribuir salário base…"),
					});
				},
				__("Aplicar"),
				true
			);
		}, __("SIGOS"));
	},
});
