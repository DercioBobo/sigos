frappe.ui.form.on("Justificacao De Faltas", {

	onload(frm) {
		frm.set_query("vigilante", () => ({
			filters: { status: "Activo" }
		}));
	},

	validate(frm) {
		if (frm.doc.dia_de_fim && frm.doc.data_do_justificativo) {
			const data_fim = frappe.datetime.str_to_obj(frm.doc.dia_de_fim);
			const data_just = frappe.datetime.str_to_obj(frm.doc.data_do_justificativo);
			const diff_ms = data_just - data_fim;
			const diff_dias = diff_ms / (1000 * 60 * 60 * 24);

			if (diff_dias > 3) {
				frappe.msgprint({
					title: __("Prazo Expirado"),
					message: __("Só é permitido justificar faltas em um período de 3 dias depois da falta."),
					indicator: "red"
				});
				frappe.validated = false;
			}
		}
	},

	dia_de_inicio(frm) {
		_jf_calcular_fim(frm);
		_jf_buscar_faltas(frm);
	},

	dias_a_justificar(frm) {
		_jf_calcular_fim(frm);
		_jf_buscar_faltas(frm);
	},

	dia_de_fim(frm) {
		_jf_buscar_faltas(frm);
	},

	vigilante(frm) {
		_jf_buscar_faltas(frm);
	},

	data_do_justificativo(frm) {
		_jf_buscar_faltas(frm);
	}
});


function _jf_calcular_fim(frm) {
	if (!frm.doc.dia_de_inicio || !frm.doc.dias_a_justificar) return;

	const inicio = frappe.datetime.str_to_obj(frm.doc.dia_de_inicio);
	const dias = frm.doc.dias_a_justificar;

	let fim = new Date(inicio);
	fim.setDate(fim.getDate() + (dias - 1));

	frm.set_value("dia_de_fim", frappe.datetime.obj_to_str(fim));
}


function _jf_buscar_faltas(frm) {
	if (!frm.doc.dia_de_inicio || !frm.doc.dia_de_fim || !frm.doc.vigilante) return;

	// Set month boundaries based on data_do_justificativo
	if (frm.doc.data_do_justificativo) {
		const data = frappe.datetime.str_to_obj(frm.doc.data_do_justificativo);
		const primeiro_dia = new Date(data.getFullYear(), data.getMonth(), 1);
		const ultimo_dia = new Date(data.getFullYear(), data.getMonth() + 1, 0);

		frm.set_value("data_de_inicio", frappe.datetime.obj_to_str(primeiro_dia));
		frm.set_value("data_de_fim", frappe.datetime.obj_to_str(ultimo_dia));
	}

	// numero is the SAME escala-aware count the server stamps on save
	// (preview_numero → calcular_faltas_vigilante), so what is shown matches
	// what is stored — no raw-sum drift.
	frappe.call({
		method: "sigos.payroll_ext.doctype.justificacao_de_faltas.justificacao_de_faltas.preview_numero",
		args: {
			vigilante: frm.doc.vigilante,
			dia_de_inicio: frm.doc.dia_de_inicio,
			dia_de_fim: frm.doc.dia_de_fim,
		},
		callback(res) {
			frm.set_value("numero", res.message || 0);
			frm.refresh_field("numero");
		},
	});
}
