frappe.ui.form.on("Denuncia", {
	refresh(frm) {
		if (frm.doc.participacao) {
			frm.add_custom_button(__("Ver Participação"), () => frappe.set_route("Form", "Participacao", frm.doc.participacao));
		}
		if (frm.doc.demissao) {
			frm.add_custom_button(__("Ver Demissão"), () => frappe.set_route("Form", "Demissao", frm.doc.demissao));
		}
		_den_periodo(frm);
	},
	vigilante: (frm) => _den_periodo(frm),
});

// Probation window banner: red when the guard is past the 3 months (submit is refused).
function _den_periodo(frm) {
	if (frm.doc.docstatus !== 0 || !frm.doc.vigilante) return;
	frappe.xcall("sigos.disciplinar.doctype.denuncia.denuncia.elegibilidade", { vigilante: frm.doc.vigilante })
		.then((e) => {
			if (!e || !e.fim) {
				frm.dashboard.set_headline_alert(__("O vigilante não tem Data de Admissão."), "red");
				return;
			}
			const ate = frappe.datetime.str_to_user(e.fim);
			frm.dashboard.set_headline_alert(e.elegivel
				? __("Período experimental até {0}. Ao submeter, cria a Demissão.", [ate])
				: __("Fora do período experimental (terminou a {0}) — siga pelo Processo Disciplinar.", [ate]),
				e.elegivel ? "orange" : "red");
		});
}
