// =========================
// MAPA DE MESES
// =========================
const _DED_MESES = {
	"Janeiro": "01", "Fevereiro": "02", "Março": "03", "Abril": "04",
	"Maio": "05", "Junho": "06", "Julho": "07", "Agosto": "08",
	"Setembro": "09", "Outubro": "10", "Novembro": "11", "Dezembro": "12"
};

// =========================
// Verificar empréstimo ativo
// =========================
async function _ded_verificar_emprestimo_ativo(frm) {
	if (frm.doc.tipo !== "Emprestimo" || !frm.doc.funcionario) return false;

	const result = await frappe.call({
		method: "frappe.client.get_list",
		args: {
			doctype: "Deducoes",
			filters: {
				funcionario: frm.doc.funcionario,
				tipo: "Emprestimo",
				docstatus: 1,
				estado: "Activo",
				data_de_fim: [">", frappe.datetime.get_today()]
			},
			fields: ["name", "data_de_fim"]
		}
	});

	if (result.message && result.message.length > 0) {
		const ativo = result.message[0];
		frappe.msgprint({
			title: __("Empréstimo Ativo Encontrado"),
			message: __(
				`Este funcionário já possui um empréstimo em andamento.<br><br>` +
				`<b>Dedução:</b> ${ativo.name}<br>` +
				`<b>Termina em:</b> ${ativo.data_de_fim}<br><br>` +
				`Não é possível criar um novo empréstimo até o atual terminar.`
			),
			indicator: "red"
		});
		return true;
	}
	return false;
}

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

function _ded_aplicar_valores_emprestimo(frm) {
	Promise.all([
		frappe.db.get_single_value("SIGOS Settings", "meses_maximos_emprestimo"),
		frappe.db.get_single_value("SIGOS Settings", "percentagem_maxima_emprestimo"),
	]).then(([max_meses, max_pct]) => {
		max_meses = max_meses || 3;
		max_pct   = max_pct   || 30;
		const meses = Math.min(frm.doc.meses_a_pagar || max_meses, max_meses);
		frm.set_value("meses_a_pagar", meses);
		if (frm.doc.salario_base) {
			frm.set_value("valor_a_pagar", frm.doc.salario_base * (max_pct / 100));
		}
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
	frm.set_value("valor_mensal", (total && meses && meses > 0) ? total / meses : 0);
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

// =========================
// Calcular data_de_inicio por mês
// =========================
function _ded_calcular_data_inicio_por_mes(frm) {
	if (!frm.doc.mes_referencia) return;

	const mes = _DED_MESES[frm.doc.mes_referencia];
	const ano = frappe.datetime.get_today().split("-")[0];
	frm.set_value("data_de_inicio", `${ano}-${mes}-01`);
	_ded_calcular_data_fim(frm);
}

// =========================
// Validações UX de empréstimo (server enforces, these auto-correct the form)
// =========================
function _ded_validar_valor_emprestimo(frm) {
	if (frm.doc.tipo !== "Emprestimo" || !frm.doc.salario_base) return;
	frappe.db.get_single_value("SIGOS Settings", "percentagem_maxima_emprestimo").then(pct => {
		const max_pct = pct || 30;
		const maximo = frm.doc.salario_base * (max_pct / 100);
		if (frm.doc.valor_a_pagar > maximo) {
			frappe.show_alert({ message: __(`Valor ajustado para ${max_pct}% do salário base.`), indicator: "orange" });
			frm.set_value("valor_a_pagar", maximo);
		}
	});
}

function _ded_validar_meses_emprestimo(frm) {
	if (frm.doc.tipo !== "Emprestimo") return;
	frappe.db.get_single_value("SIGOS Settings", "meses_maximos_emprestimo").then(max => {
		const max_meses = max || 3;
		if (frm.doc.meses_a_pagar > max_meses) {
			frappe.show_alert({ message: __(`Meses ajustados para o máximo de ${max_meses}.`), indicator: "orange" });
			frm.set_value("meses_a_pagar", max_meses);
		}
	});
}

// =========================
// Aplicar todas as regras
// =========================
function _ded_aplicar_regras(frm) {
	if (frm.doc.tipo === "Uniforme") {
		_ded_aplicar_valores_uniforme(frm);
	} else if (frm.doc.tipo === "Emprestimo") {
		_ded_aplicar_valores_emprestimo(frm);
	}
	_ded_aplicar_tipo_pagamento(frm);
	_ded_calcular_valor_mensal(frm);
	_ded_calcular_data_fim(frm);
}

// =========================
// Eventos do formulário
// =========================
frappe.ui.form.on("Deducoes", {

	onload(frm) {
		_ded_aplicar_regras(frm);
		if (!frm.doc.data_de_inicio && frm.doc.mes_referencia) {
			_ded_calcular_data_inicio_por_mes(frm);
		}
	},

	refresh(frm) {
		_ded_aplicar_regras(frm);
		if (!frm.doc.data_de_inicio && frm.doc.mes_referencia) {
			_ded_calcular_data_inicio_por_mes(frm);
		}
	},

	tipo: async function (frm) {
		frm.set_value("valor_a_pagar", null);
		frm.set_value("meses_a_pagar", null);
		frm.set_value("valor_mensal", 0);
		frm.set_value("data_de_fim", null);

		// Early UX warning — server enforces on save
		const ativo = await _ded_verificar_emprestimo_ativo(frm);
		if (ativo) {
			frm.set_value("tipo", "");
			return;
		}
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
		const ano = frappe.datetime.get_today().split("-")[0];
		frm.set_value("data_de_inicio", `${ano}-${mes}-01`);
		_ded_calcular_data_fim(frm);
	},

	valor_a_pagar(frm) {
		_ded_validar_valor_emprestimo(frm);
		_ded_calcular_valor_mensal(frm);
	},

	meses_a_pagar(frm) {
		_ded_validar_meses_emprestimo(frm);
		_ded_calcular_valor_mensal(frm);
		_ded_calcular_data_fim(frm);
	},

	data_de_inicio(frm) {
		_ded_calcular_data_fim(frm);
	}
});
