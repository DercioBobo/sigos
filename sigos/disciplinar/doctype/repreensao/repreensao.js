frappe.ui.form.on("Repreensao", {
	refresh(frm) {
		if (frm.is_new()) return;
		if (frm.doc.participacao) {
			frm.add_custom_button(__("Ver Participação"), () => frappe.set_route("Form", "Participacao", frm.doc.participacao));
		}
		if (frm.doc.processo_disciplinar) {
			frm.add_custom_button(__("Ver Processo Disciplinar"),
				() => frappe.set_route("Form", "Processo Disciplinar", frm.doc.processo_disciplinar));
			return;
		}
		if (frm.doc.docstatus !== 1 || !frappe.model.can_create("Processo Disciplinar")) return;
		frappe.xcall("sigos.disciplinar.doctype.repreensao.repreensao.limite").then((lim) => {
			if ((frm.doc.numero || 0) >= lim) {
				frm.dashboard.set_headline_alert(
					__("{0}.ª repreensão deste vigilante (limite: {1}) — pode abrir um Processo Disciplinar.", [frm.doc.numero, lim]),
					"orange");
			}
			frm.add_custom_button(__("Abrir Processo Disciplinar"), () => frappe.confirm(
				__("Abrir um Processo Disciplinar a partir desta repreensão?"),
				() => frm.call("abrir_processo").then((r) => {
					if (r.message) frappe.set_route("Form", "Processo Disciplinar", r.message);
				}),
			)).addClass((frm.doc.numero || 0) >= lim ? "btn-primary" : "btn-default");
		});
	},
});
