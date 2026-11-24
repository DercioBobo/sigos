frappe.ui.form.on("Denuncia", {
	refresh(frm) {
		if (frm.doc.participacao) {
			frm.add_custom_button(__("Ver Participação"), () => frappe.set_route("Form", "Participacao", frm.doc.participacao));
		}
		if (frm.doc.demissao) {
			frm.add_custom_button(__("Ver Demissão"), () => frappe.set_route("Form", "Demissao", frm.doc.demissao));
		}
		if (!frm.is_new() && frm.doc.docstatus !== 2) {
			frm.add_custom_button(__("Imprimir Carta"), () => frm.print_doc(), __("Carta"));
			frm.add_custom_button(__("Regenerar Texto"), () => frappe.confirm(
				__("Substituir o texto da carta pelo texto gerado?"),
				() => frm.call("regenerar_carta").then(() => frm.reload_doc())), __("Carta"));
		}
		_den_periodo(frm);
	},
	vigilante: (frm) => _den_periodo(frm),
});

// Only a red banner when the guard is outside the 3 months (submit is refused).
function _den_periodo(frm) {
	if (frm.doc.docstatus !== 0 || !frm.doc.vigilante) return;
	frappe.xcall("sigos.disciplinar.doctype.denuncia.denuncia.elegibilidade",
		{ vigilante: frm.doc.vigilante, data_infracao: (frm.doc.participacao && frm.doc.data_infracao) || null })
		.then((e) => {
			if (!e || !e.fim) frm.dashboard.set_headline_alert(__("O vigilante não tem Data de Admissão."), "red");
			else if (!e.elegivel) frm.dashboard.set_headline_alert(__("Fora dos 3 meses."), "red");
		});
}
