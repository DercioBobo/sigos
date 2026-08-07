frappe.ui.form.on("Cobertura De Posto", {
	refresh(frm) {
		if (frm.is_new()) return;

		if (frm.doc.estado === "Por Atribuir") {
			frm.add_custom_button(__("Atribuir Cobridor"), () => _abrir_dialog_atribuir(frm), __("Acções"));
			frm.add_custom_button(__("Cancelar Cobertura"), () => _prompt_cancelar(frm), __("Acções"));
		}

		if (frm.doc.estado === "Activa") {
			frm.add_custom_button(__("Concluir"), () => {
				frappe.confirm(
					__("Confirmar que <b>{0}</b> já regressou? O Cobridor <b>{1}</b> volta para a Reserva.")
						.format(frm.doc.vigilante_coberto, frm.doc.vigilante_cobridor),
					() => frm.call("concluir").then(() => frm.reload_doc())
				);
			}, __("Acções"));
			frm.add_custom_button(__("Efectivar"), () => {
				frappe.confirm(
					__("Confirmar que <b>{0}</b> NÃO vai regressar a este posto? <b>{1}</b> passa a titular "
					   + "efectivo. Isto <b>não</b> altera o registo de {0} — trate a situação dele "
					   + "separadamente (Demissão, Rotatividade, etc.).")
						.format(frm.doc.vigilante_coberto, frm.doc.vigilante_cobridor),
					() => frm.call("efectivar").then(() => frm.reload_doc())
				);
			}, __("Acções"));
			frm.add_custom_button(__("Cancelar Cobertura"), () => _prompt_cancelar(frm), __("Acções"));
		}
	},
});

function _abrir_dialog_atribuir(frm) {
	const d = new frappe.ui.Dialog({
		title: __("Atribuir Cobridor"),
		fields: [
			{
				fieldname: "vigilante_cobridor",
				fieldtype: "Link",
				label: __("Vigilante Cobridor"),
				options: "Vigilante",
				reqd: 1,
				description: __("Só guardas em Reserva. Segue a escala exacta de {0} até a cobertura ser concluída ou efectivada.")
					.format(frm.doc.vigilante_coberto || ""),
				get_query: () => {
					const filters = { status: "Reserva" };
					if (frm.doc.delegacao) filters.delegacao = frm.doc.delegacao;
					return { filters };
				},
			},
		],
		primary_action_label: __("Atribuir"),
		primary_action: (values) => {
			d.hide();
			frm.call("atribuir_cobridor", { vigilante_cobridor: values.vigilante_cobridor })
				.then(() => frm.reload_doc());
		},
	});
	d.show();
}

function _prompt_cancelar(frm) {
	frappe.prompt(
		[{ fieldname: "motivo", fieldtype: "Small Text", label: __("Motivo (opcional)") }],
		(values) => {
			frm.call("cancelar", { motivo: values.motivo }).then(() => frm.reload_doc());
		},
		__("Cancelar Cobertura"),
		__("Confirmar")
	);
}
