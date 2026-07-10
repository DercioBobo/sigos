frappe.ui.form.on("Pedido De Licenca", {

	onload(frm) {
		if (frm.is_new() && !frm.doc.tipo_de_licenca) {
			frappe.db.get_single_value("SIGOS Settings", "leave_type_ferias").then((v) => {
				if (v) frm.set_value("tipo_de_licenca", v);
			});
		}
	},

	refresh(frm) {
		_botao_licenca(frm);
	},

	vigilante(frm) { _actualizar_saldo(frm); },
	tipo_de_licenca(frm) { _actualizar_saldo(frm); },
	data_inicio(frm) { _actualizar_saldo(frm); },
});

// Live balance preview — helps whoever is approving see whether the guard
// actually has enough days before they submit. The Leave Application itself
// still enforces the real check on approval; this is just early visibility.
function _actualizar_saldo(frm) {
	if (!frm.doc.vigilante || !frm.doc.tipo_de_licenca) {
		frm.set_value("saldo_disponivel", null);
		return;
	}
	frappe.call({
		method: "sigos.payroll_ext.doctype.pedido_de_licenca.pedido_de_licenca.consultar_saldo",
		args: {
			vigilante: frm.doc.vigilante,
			tipo_de_licenca: frm.doc.tipo_de_licenca,
			ate: frm.doc.data_inicio,
		},
		callback(r) {
			frm.set_value("saldo_disponivel", r.message);
		},
	});
}

function _botao_licenca(frm) {
	if (!frm.doc.leave_application_ref) return;
	frm.add_custom_button(__("Ver Licença"), () => {
		frappe.set_route("Form", "Leave Application", frm.doc.leave_application_ref);
	});
}
