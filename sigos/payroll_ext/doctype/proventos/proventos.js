// =========================
// MAPA DE MESES
// =========================
const _PROV_MESES = {
	"Janeiro": 0, "Fevereiro": 1, "Março": 2, "Abril": 3,
	"Maio": 4, "Junho": 5, "Julho": 6, "Agosto": 7,
	"Setembro": 8, "Outubro": 9, "Novembro": 10, "Dezembro": 11
};

function _prov_ultimo_dia_do_mes(ano, mes) {
	return new Date(ano, mes + 1, 0);
}

function _prov_calcular_valor_mensal(frm) {
	const total = frm.doc.valor_a_pagar || 0;
	const meses = frm.doc.meses_a_pagar || 0;
	frm.set_value("valor_mensal", meses > 0 ? total / meses : 0);
}

function _prov_aplicar_tipo_pagamento(frm) {
	if (!frm.doc.tipo_de_pagamento) return;

	if (frm.doc.tipo_de_pagamento === "Determinado") {
		frm.set_value("meses_a_pagar", 1);
		frm.set_df_property("meses_a_pagar", "read_only", 1);
		_prov_calcular_datas_determinado(frm);
	} else if (frm.doc.tipo_de_pagamento === "Em Prestações") {
		frm.set_df_property("meses_a_pagar", "read_only", 0);
		if (frm.doc.meses_a_pagar) {
			_prov_calcular_datas_prestacoes(frm);
		}
	}
	_prov_calcular_valor_mensal(frm);
}

function _prov_calcular_datas_determinado(frm) {
	if (!frm.doc.mes_referencia) return;

	const hoje = frappe.datetime.str_to_obj(frappe.datetime.get_today());
	const ano = hoje.getFullYear();
	const mes = _PROV_MESES[frm.doc.mes_referencia];

	const data_inicio = new Date(ano, mes, 1);
	const data_fim = _prov_ultimo_dia_do_mes(ano, mes);

	frm.set_value("data_de_inicio", frappe.datetime.obj_to_str(data_inicio));
	frm.set_value("data_de_fim", frappe.datetime.obj_to_str(data_fim));
}

function _prov_calcular_datas_prestacoes(frm) {
	if (!frm.doc.mes_referencia || !frm.doc.meses_a_pagar) return;

	const hoje = frappe.datetime.str_to_obj(frappe.datetime.get_today());
	const ano = hoje.getFullYear();
	const mes = _PROV_MESES[frm.doc.mes_referencia];

	const data_inicio = new Date(ano, mes, 1);
	const data_fim_temp = new Date(ano, mes + frm.doc.meses_a_pagar - 1, 1);
	const data_fim = _prov_ultimo_dia_do_mes(data_fim_temp.getFullYear(), data_fim_temp.getMonth());

	frm.set_value("data_de_inicio", frappe.datetime.obj_to_str(data_inicio));
	frm.set_value("data_de_fim", frappe.datetime.obj_to_str(data_fim));
}

function _prov_aplicar_regras(frm) {
	if (!frm.doc.tipo_de_pagamento || !frm.doc.mes_referencia) return;
	_prov_aplicar_tipo_pagamento(frm);
}

frappe.ui.form.on("Proventos", {

	onload(frm) {
		frm.set_query("tipo_de_subsidios", () => ({
			filters: {
				type: "Earning",
				name: ["not in", ["Base", "Basic", "Salario Base"]]
			}
		}));

		frm.set_query("funcionario", () => ({
			filters: { status: "Active" }
		}));

		_prov_aplicar_regras(frm);
	},

	refresh(frm) {
		_prov_aplicar_regras(frm);
	},

	tipo_de_pagamento(frm) {
		_prov_aplicar_tipo_pagamento(frm);
	},

	mes_referencia(frm) {
		_prov_aplicar_regras(frm);
	},

	meses_a_pagar(frm) {
		_prov_aplicar_tipo_pagamento(frm);
	},

	valor_a_pagar(frm) {
		_prov_calcular_valor_mensal(frm);
	}
});
