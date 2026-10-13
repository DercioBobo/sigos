// SIGOS — Sales Invoice helpers.
// "Get Items From → Contratos SIGOS": fill a draft invoice straight from the customer's
// contracts (same lines as Faturação Mensal), without going through a billing run.
frappe.ui.form.on("Sales Invoice", {
	refresh(frm) {
		if (frm.doc.docstatus !== 0 || frm.doc.is_return) return;
		frm.add_custom_button(__("Contratos SIGOS"), () => _sigos_obter_contratos(frm), __("Get Items From"));
	},
});

function _sigos_obter_contratos(frm) {
	if (!frm.doc.customer) {
		frappe.msgprint(__("Defina primeiro o Cliente."));
		return;
	}
	const temItens = (frm.doc.items || []).some(r => r.item_code);
	const d = new frappe.ui.Dialog({
		title: __("Facturar Contratos SIGOS — {0}", [frm.doc.customer]),
		fields: [
			{
				fieldname: "mes_referencia",
				fieldtype: "Date",
				label: __("Mês de Referência"),
				reqd: 1,
				default: frm.doc.custom_mes_referencia || frm.doc.posting_date || frappe.datetime.get_today(),
				description: __("Qualquer dia do mês a facturar. Inclui todos os contratos deste cliente."),
			},
			{
				fieldname: "substituir",
				fieldtype: "Check",
				label: __("Substituir os artigos actuais"),
				default: 1,
				hidden: temItens ? 0 : 1,
			},
		],
		primary_action_label: __("Obter Linhas"),
		primary_action(vals) {
			d.hide();
			frappe.call({
				method: "sigos.faturacao.obter_linhas_contrato",
				args: { doc: frm.doc, mes_referencia: vals.mes_referencia, substituir: vals.substituir ? 1 : 0 },
				freeze: true,
				freeze_message: __("A obter as linhas dos contratos…"),
			}).then(r => {
				if (!r.message) return;
				frappe.model.sync(r.message);
				frm.dirty();
				frm.refresh();
			});
		},
	});
	d.show();
}
