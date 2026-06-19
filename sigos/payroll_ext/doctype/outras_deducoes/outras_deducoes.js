// =========================
// MAPA DE MESES
// =========================
const _DED_MESES = {
	"Janeiro": "01", "Fevereiro": "02", "Março": "03", "Abril": "04",
	"Maio": "05", "Junho": "06", "Julho": "07", "Agosto": "08",
	"Setembro": "09", "Outubro": "10", "Novembro": "11", "Dezembro": "12"
};

// =========================
// Aplicar valores por tipo (defaults from Settings)
// =========================
function _ded_aplicar_valores_uniforme(frm) {
	frappe.db.get_single_value("SIGOS Settings", "valor_padrao_uniforme").then(val => {
		if (!frm.doc.valor_a_pagar) frm.set_value("valor_a_pagar", val || 3240);
	});
	frappe.db.get_single_value("SIGOS Settings", "meses_padrao_uniforme").then(val => {
		if (!frm.doc.meses_a_pagar) frm.set_value("meses_a_pagar", val || 6);
	});
}

// =========================
// Tipo de pagamento
// =========================
function _ded_aplicar_tipo_pagamento(frm) {
	if (!frm.doc.tipo_de_pagamento) return;

	if (frm.doc.tipo_de_pagamento === "Determinado") {
		frm.set_value("meses_a_pagar", 1);
		frm.set_df_property("meses_a_pagar", "read_only", 1);
	} else {
		frm.set_df_property("meses_a_pagar", "read_only", 0);
	}
}

// =========================
// Cálculo valor mensal
// =========================
function _ded_calcular_valor_mensal(frm) {
	const total = frm.doc.valor_a_pagar;
	const meses = frm.doc.meses_a_pagar;
	// Round to 2 like the server (round(total/meses, 2)) — otherwise refresh's
	// set_value writes an unrounded value that never matches the saved one (stale form).
	frm.set_value("valor_mensal", (total && meses && meses > 0) ? flt(total / meses, 2) : 0);
}

// =========================
// Cálculo data de fim
// =========================
function _ded_calcular_data_fim(frm) {
	const meses = frm.doc.meses_a_pagar;
	const data_inicio = frm.doc.data_de_inicio;

	if (data_inicio && meses && meses > 0) {
		const inicio = frappe.datetime.str_to_obj(data_inicio);
		const data_fim = frappe.datetime.add_months(frappe.datetime.obj_to_str(inicio), meses);
		// Subtract one day so it lands on last day of the final month
		const fim_date = frappe.datetime.add_days(data_fim, -1);
		frm.set_value("data_de_fim", fim_date);
	} else {
		frm.set_value("data_de_fim", null);
	}
}

// Year for the chosen month (1-based "01".."12"): current year if it's the current
// month or later; next year ONLY at the year-end Dez→Jan wrap (we're in December).
// Any other earlier month stays in the current year — a genuine past month that the
// server rejects (e.g. "Março" escolhido em Junho).
function _ded_ano_para_mes(mes_str) {
	const hoje = frappe.datetime.str_to_obj(frappe.datetime.get_today());
	const mes = parseInt(mes_str, 10);          // 1-based
	const mes_actual = hoje.getMonth() + 1;     // 1-based
	if (mes >= mes_actual) return hoje.getFullYear();
	if (mes_actual === 12) return hoje.getFullYear() + 1;
	return hoje.getFullYear();
}

// Aviso (não bloqueante) — mês no passado. O servidor bloqueia ao guardar.
function _ded_avisar_mes_passado(frm) {
	if (!frm.doc.data_de_inicio) return;
	const inicio_mes_actual = frappe.datetime.get_today().slice(0, 8) + "01";
	if (frm.doc.data_de_inicio < inicio_mes_actual) {
		frappe.show_alert({
			message: __("O mês seleccionado já passou — não será possível guardar. Escolha o mês actual ou um mês futuro."),
			indicator: "orange",
		}, 6);
	}
}

// =========================
// Calcular data_de_inicio por mês
// =========================
function _ded_calcular_data_inicio_por_mes(frm) {
	if (!frm.doc.mes_referencia) return;

	const mes = _DED_MESES[frm.doc.mes_referencia];
	const ano = _ded_ano_para_mes(mes);
	frm.set_value("data_de_inicio", `${ano}-${mes}-01`);
	_ded_calcular_data_fim(frm);
}

// =========================
// Restringir o tipo a componentes de Dedução
// =========================
function _ded_filtrar_componente(frm) {
	frm.set_query("tipo", () => ({ filters: { type: "Deduction" } }));
}

// =========================
// Aplicar todas as regras
// =========================
function _ded_aplicar_regras(frm) {
	// "Uniforme" é detectado pelo componente configurado em SIGOS Settings
	// (componente_uniforme, padrão "Uniforme") — preenche valores por defeito.
	if (frm.doc.tipo) {
		frappe.db.get_single_value("SIGOS Settings", "componente_uniforme").then(comp => {
			if (frm.doc.tipo === (comp || "Uniforme")) _ded_aplicar_valores_uniforme(frm);
		});
	}
	_ded_aplicar_tipo_pagamento(frm);
	_ded_calcular_valor_mensal(frm);
	_ded_calcular_data_fim(frm);
}

// =========================
// Eventos do formulário
// =========================
frappe.ui.form.on("Outras Deducoes", {

	onload(frm) {
		_ded_filtrar_componente(frm);
		_ded_aplicar_regras(frm);
		if (!frm.doc.data_de_inicio && frm.doc.mes_referencia) {
			_ded_calcular_data_inicio_por_mes(frm);
		}
	},

	refresh(frm) {
		_ded_filtrar_componente(frm);
		_ded_aplicar_regras(frm);
		if (!frm.doc.data_de_inicio && frm.doc.mes_referencia) {
			_ded_calcular_data_inicio_por_mes(frm);
		}
	},

	tipo(frm) {
		frm.set_value("valor_a_pagar", null);
		frm.set_value("meses_a_pagar", null);
		frm.set_value("valor_mensal", 0);
		frm.set_value("data_de_fim", null);
		_ded_aplicar_regras(frm);
	},

	tipo_de_pagamento(frm) {
		_ded_aplicar_tipo_pagamento(frm);
		_ded_calcular_valor_mensal(frm);
		_ded_calcular_data_fim(frm);
	},

	mes_referencia(frm) {
		if (!frm.doc.mes_referencia) return;
		const mes = _DED_MESES[frm.doc.mes_referencia];
		const ano = _ded_ano_para_mes(mes);
		frm.set_value("data_de_inicio", `${ano}-${mes}-01`);
		_ded_calcular_data_fim(frm);
		_ded_avisar_mes_passado(frm);
	},

	valor_a_pagar(frm) {
		_ded_calcular_valor_mensal(frm);
	},

	meses_a_pagar(frm) {
		_ded_calcular_valor_mensal(frm);
		_ded_calcular_data_fim(frm);
	},

	data_de_inicio(frm) {
		_ded_calcular_data_fim(frm);
	}
});
