// =========================
// MAPA DE MESES
// =========================
const _EMP_MESES = {
	"Janeiro": "01", "Fevereiro": "02", "Março": "03", "Abril": "04",
	"Maio": "05", "Junho": "06", "Julho": "07", "Agosto": "08",
	"Setembro": "09", "Outubro": "10", "Novembro": "11", "Dezembro": "12"
};

// =========================
// Verificar empréstimo ativo (UX — o servidor também valida)
// =========================
async function _emp_verificar_ativo(frm) {
	if (!frm.doc.funcionario) return false;

	const result = await frappe.call({
		method: "frappe.client.get_list",
		args: {
			doctype: "Emprestimo",
			filters: {
				funcionario: frm.doc.funcionario,
				docstatus: 1,
				estado: "Activo",
				data_de_fim: [">", frappe.datetime.get_today()],
				name: ["!=", frm.doc.name || "__new__"]
			},
			fields: ["name", "data_de_fim"]
		}
	});

	if (result.message && result.message.length > 0) {
		const ativo = result.message[0];
		frappe.msgprint({
			title: __("Empréstimo Activo Encontrado"),
			message: __(
				`Este funcionário já possui um empréstimo em andamento.<br><br>` +
				`<b>Empréstimo:</b> ${ativo.name}<br>` +
				`<b>Termina em:</b> ${ativo.data_de_fim}<br><br>` +
				`Não é possível criar um novo até o actual terminar.`
			),
			indicator: "red"
		});
		return true;
	}
	return false;
}

// =========================
// Defaults do empréstimo a partir de Settings
// =========================
function _emp_aplicar_defaults(frm) {
	Promise.all([
		frappe.db.get_single_value("SIGOS Settings", "meses_maximos_emprestimo"),
		frappe.db.get_single_value("SIGOS Settings", "percentagem_maxima_emprestimo"),
	]).then(([max_meses, max_pct]) => {
		max_meses = max_meses || 3;
		max_pct   = max_pct   || 30;
		if (!frm.doc.meses_a_pagar || frm.doc.meses_a_pagar > max_meses) {
			frm.set_value("meses_a_pagar", Math.min(frm.doc.meses_a_pagar || max_meses, max_meses));
		}
		if (!frm.doc.valor_a_pagar && frm.doc.salario_base) {
			frm.set_value("valor_a_pagar", frm.doc.salario_base * (max_pct / 100));
		}
	});
}

// =========================
// Cálculos
// =========================
function _emp_calcular_valor_mensal(frm) {
	const total = frm.doc.valor_a_pagar;
	const meses = frm.doc.meses_a_pagar;
	frm.set_value("valor_mensal", (total && meses && meses > 0) ? total / meses : 0);
}

function _emp_calcular_data_fim(frm) {
	const meses = frm.doc.meses_a_pagar;
	const data_inicio = frm.doc.data_de_inicio;

	if (data_inicio && meses && meses > 0) {
		const data_fim = frappe.datetime.add_months(data_inicio, meses);
		// Subtrai um dia para cair no último dia do mês final
		frm.set_value("data_de_fim", frappe.datetime.add_days(data_fim, -1));
	} else {
		frm.set_value("data_de_fim", null);
	}
}

function _emp_calcular_data_inicio_por_mes(frm) {
	if (!frm.doc.mes_referencia) return;
	const mes = _EMP_MESES[frm.doc.mes_referencia];
	const ano = frappe.datetime.get_today().split("-")[0];
	frm.set_value("data_de_inicio", `${ano}-${mes}-01`);
	_emp_calcular_data_fim(frm);
}

// =========================
// Validações UX (o servidor é a autoridade)
// =========================
function _emp_validar_valor(frm) {
	if (!frm.doc.salario_base) return;
	frappe.db.get_single_value("SIGOS Settings", "percentagem_maxima_emprestimo").then(pct => {
		const max_pct = pct || 30;
		const maximo = frm.doc.salario_base * (max_pct / 100);
		if (frm.doc.valor_a_pagar > maximo) {
			frappe.show_alert({ message: __(`Valor ajustado para ${max_pct}% do salário base.`), indicator: "orange" });
			frm.set_value("valor_a_pagar", maximo);
		}
	});
}

function _emp_validar_meses(frm) {
	frappe.db.get_single_value("SIGOS Settings", "meses_maximos_emprestimo").then(max => {
		const max_meses = max || 3;
		if (frm.doc.meses_a_pagar > max_meses) {
			frappe.show_alert({ message: __(`Meses ajustados para o máximo de ${max_meses}.`), indicator: "orange" });
			frm.set_value("meses_a_pagar", max_meses);
		}
	});
}

// =========================
// Eventos do formulário
// =========================
frappe.ui.form.on("Emprestimo", {

	onload(frm) {
		frm.set_query("funcionario", () => ({ filters: { status: "Active" } }));
		if (!frm.doc.data_de_inicio && frm.doc.mes_referencia) {
			_emp_calcular_data_inicio_por_mes(frm);
		}
	},

	async funcionario(frm) {
		const ativo = await _emp_verificar_ativo(frm);
		if (ativo) {
			frm.set_value("funcionario", null);
			return;
		}
		_emp_aplicar_defaults(frm);
	},

	mes_referencia(frm) {
		_emp_calcular_data_inicio_por_mes(frm);
	},

	valor_a_pagar(frm) {
		_emp_validar_valor(frm);
		_emp_calcular_valor_mensal(frm);
	},

	meses_a_pagar(frm) {
		_emp_validar_meses(frm);
		_emp_calcular_valor_mensal(frm);
		_emp_calcular_data_fim(frm);
	},

	data_de_inicio(frm) {
		_emp_calcular_data_fim(frm);
	}
});
