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

		// Billing runs are per customer, so this bills ALL of the customer's contracts.
		frm.add_custom_button(__("Faturar Mês"), () => sigos.faturar_mes(frm.doc.customer), __("SIGOS"));

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

// Faturação por Regime (Finance): keep line totals + Total Mensal Contratado live.
// A row without its own price uses the customer's Tarifas por Regime (loaded once per
// customer). The server (sigos.contrato.project_validate) recomputes the same on save.
function _sigos_carregar_tarifas_cliente(frm) {
	const cliente = frm.doc.customer;
	if (!cliente) { frm._sigos_tarifas_cliente = {}; _sigos_recalcular_faturacao(frm); return; }
	if (frm._sigos_tarifas_de === cliente) return;
	frm._sigos_tarifas_de = cliente;
	frappe.xcall("sigos.contrato.get_tarifas_cliente", { customer: cliente }).then(t => {
		if (frm.doc.customer !== cliente) return;
		frm._sigos_tarifas_cliente = t || {};
		_sigos_recalcular_faturacao(frm);
	});
}

function _sigos_recalcular_faturacao(frm) {
	const do_cliente = frm._sigos_tarifas_cliente || {};
	let total = 0;
	(frm.doc.custom_faturacao_regimes || []).forEach(r => {
		// customer rates are keyed "<regime>|<categoria>"; "<regime>|" = any categoria
		const valor = flt(r.valor) || flt(do_cliente[`${r.regime}|${r.categoria || ""}`])
			|| flt(do_cliente[`${r.regime}|`]) || 0;
		const t = (cint(r.quantidade) || 0) * valor;
		if (r.total !== t) frappe.model.set_value(r.doctype, r.name, "total", t);
		total += t;
	});
	if (frm.fields_dict.custom_total_contratual) frm.set_value("custom_total_contratual", total);
}

frappe.ui.form.on("Project", {
	refresh: _sigos_carregar_tarifas_cliente,
	customer: _sigos_carregar_tarifas_cliente,
	custom_faturacao_regimes_remove: _sigos_recalcular_faturacao,
});

frappe.ui.form.on("Project Faturacao Regime", {
	regime: _sigos_recalcular_faturacao,
	categoria: _sigos_recalcular_faturacao,
	quantidade: _sigos_recalcular_faturacao,
	valor: _sigos_recalcular_faturacao,
});
