// SIGOS — contract (Project) helpers.
// "Aplicar Salário Base" pushes the per-regime base salary defined in this
// contract onto every active vigilante's Salary Structure Assignment. Vigilantes
// with a manual override keep it (the resolver prefers the override), so re-running
// is always safe.
frappe.ui.form.on("Project", {
	refresh(frm) {
		if (frm.is_new()) return;

		// Grid-level button, always visible above the Subsídios table (not tucked
		// into the form's own button bar) — the subsídios table only defines the
		// component + valor now; WHO on the project actually receives each one is
		// managed here, in the matrix modal (sigos.project_subsidios). Grid.
		// add_custom_button is itself idempotent (re-shows the same button by
		// label instead of duplicating it), so this is safe to call on every refresh.
		const grid = frm.fields_dict.custom_subsidios && frm.fields_dict.custom_subsidios.grid;
		if (grid) {
			grid.add_custom_button(__("Gerir Subsídios..."), () => {
				sigos.project_subsidios.abrir_matriz(frm);
			}, "top");
		}

		frm.add_custom_button(__("Aplicar Salário Base"), () => {
			const d = new frappe.ui.Dialog({
				title: __("Aplicar Salário Base"),
				fields: [
					{
						fieldname: "aviso",
						fieldtype: "HTML",
						options: `<p>${__(
							"Isto vai atribuir o salário base (por regime, definido neste contrato) " +
							"a todos os vigilantes <b>Activos</b> deste contrato, criando/actualizando " +
							"a respectiva Salary Structure Assignment.<br><br>" +
							"Vigilantes com <b>Salário Base (manual)</b> mantêm o valor manual."
						)}</p>`,
					},
					{
						fieldname: "from_date",
						label: __("Data de Efeito"),
						fieldtype: "Date",
						reqd: 1,
						default: frappe.datetime.month_start(),
						description: __(
							"Para quem já tem Salary Structure Assignment (ajuste, não 1ª atribuição). " +
							"Use o 1º dia do mês para que a folha do mês inteiro reflicta o novo valor " +
							"— uma data a meio do mês só se aplica a partir desse dia em diante."
						),
					},
				],
				primary_action_label: __("Aplicar"),
				primary_action(vals) {
					d.hide();
					frappe.call({
						method: "sigos.api.aplicar_salario_base",
						args: { project: frm.doc.name, from_date: vals.from_date },
						freeze: true,
						freeze_message: __("A atribuir salário base…"),
					});
				},
			});
			d.show();
		}, __("SIGOS"));
	},
});
