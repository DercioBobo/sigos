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
		if (frm.doc.outras_deducoes) {
			frm.add_custom_button(__("Ver Dedução"), () => frappe.set_route("Form", "Outras Deducoes", frm.doc.outras_deducoes));
		}
		if (frm.doc.docstatus === 2) return;
		frm.add_custom_button(__("Imprimir Termo"), () => frm.print_doc()).addClass("btn-primary");
		if (frm.doc.docstatus === 0) {
			frm.dashboard.set_headline_alert(__("Reveja a declaração, imprima e submeta."), "blue");
		} else if (!frm.doc.documento_assinado) {
			frm.dashboard.set_headline_alert(__("Anexe o termo assinado pelo vigilante."), "orange");
		}
	},
	com_deducao(frm) {
		if (frm.doc.com_deducao && !frm.doc.mes_inicio_deducao) {
			const M = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto",
				"Setembro", "Outubro", "Novembro", "Dezembro"];
			frm.set_value("mes_inicio_deducao", M[new Date().getMonth()]);
		}
		_tr_prestacao(frm);
	},
	valor_deducao: (frm) => _tr_prestacao(frm),
	prestacoes: (frm) => _tr_prestacao(frm),
});

function _tr_prestacao(frm) {
	const n = Math.max(cint(frm.doc.prestacoes) || 1, 1);
	frm.set_value("valor_prestacao", frm.doc.com_deducao ? flt(flt(frm.doc.valor_deducao) / n, 2) : 0);
}
