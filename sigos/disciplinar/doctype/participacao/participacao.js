frappe.ui.form.on("Participacao", {

	onload(frm) {
		frm.set_query("tipo_de_infracao", () => ({ filters: { ativo: 1 } }));
	},

	refresh(frm) {
		frm.set_query("tipo_de_infracao", () => ({ filters: { ativo: 1 } }));
		_botao_processo(frm);
	},

	tipo_de_infracao(frm) {
		_sugerir_gravidade(frm);
	},
});

// On a submitted participação, offer to open (or jump to) the Processo Disciplinar.
function _botao_processo(frm) {
	if (frm.doc.docstatus !== 1) return;

	frappe.db.get_value(
		"Processo Disciplinar", { participacao_referente: frm.doc.name }, "name"
	).then((r) => {
		const existente = r.message && r.message.name;
		if (existente) {
			frm.add_custom_button(__("Ver Processo Disciplinar"), () => {
				frappe.set_route("Form", "Processo Disciplinar", existente);
			});
		} else {
			frm.add_custom_button(__("Abrir Processo Disciplinar"), () => {
				frm.call("criar_processo_disciplinar").then((res) => {
					if (res.message) frappe.set_route("Form", "Processo Disciplinar", res.message);
				});
			}).addClass("btn-primary");
		}
	});
}

function _sugerir_gravidade(frm) {
	// Pre-fill gravidade from the infraction type's suggested severity (only if empty).
	if (!frm.doc.tipo_de_infracao || frm.doc.gravidade) return;
	frappe.db.get_value("Tipo De Infracao", frm.doc.tipo_de_infracao, "gravidade_sugerida")
		.then((r) => {
			const sugerida = r.message && r.message.gravidade_sugerida;
			if (sugerida) frm.set_value("gravidade", sugerida);
		});
}
