frappe.ui.form.on("Termo De Responsabilidade", {
	refresh(frm) {
		if (frm.is_new()) return;
		if (frm.doc.participacao) {
			frm.add_custom_button(__("Ver Participação"), () => frappe.set_route("Form", "Participacao", frm.doc.participacao));
		}
		if (frm.doc.processo_disciplinar) {
			frm.add_custom_button(__("Ver Processo Disciplinar"),
				() => frappe.set_route("Form", "Processo Disciplinar", frm.doc.processo_disciplinar));
		}
		if (frm.doc.docstatus === 2) return;
		frm.add_custom_button(__("Imprimir Termo"), () => frm.print_doc()).addClass("btn-primary");
		if (frm.doc.docstatus === 0) {
			frm.dashboard.set_headline_alert(__("Reveja a declaração, imprima e submeta."), "blue");
		} else if (!frm.doc.documento_assinado) {
			frm.dashboard.set_headline_alert(__("Anexe o termo assinado pelo vigilante."), "orange");
		}
	},
});
