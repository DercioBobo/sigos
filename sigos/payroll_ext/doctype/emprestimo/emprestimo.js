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
// Salário base — buscado assim que o funcionário é escolhido, para que o
// tecto/valores por omissão e os avisos de limite apareçam ao editar, e não
// só depois de gravar (quando o servidor o preenchia pela primeira vez).
// =========================
async function _emp_buscar_salario_base(frm) {
	if (!frm.doc.funcionario) return;

	const r = await frappe.call({
		method: "sigos.payroll_ext.doctype.emprestimo.emprestimo.buscar_salario_base",
		args: { funcionario: frm.doc.funcionario },
	});
	frm.set_value("salario_base", r.message || 0);
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
//
// Meses máximos e prestação mensal máxima são limites BLOQUEANTES — protegem
// o que sai do salário do funcionário todos os meses, nunca são ultrapassáveis.
// Só o valor TOTAL do empréstimo (% do salário base) pode ser excepcionado:
// esse valor é recebido de uma vez (não é descontado mensalmente), por isso as
// operações por vezes precisam de emprestar acima do salário do funcionário —
// aí perguntamos e exigimos motivo, registado em excepcao_limite/motivo_excepcao.
// =========================
function _emp_clamp_meses(frm) {
	frappe.db.get_single_value("SIGOS Settings", "meses_maximos_emprestimo").then(max => {
		const max_meses = max || 3;
		if (frm.doc.meses_a_pagar > max_meses) {
			frappe.show_alert({ message: __(`Meses ajustados para o máximo de ${max_meses}.`), indicator: "orange" });
			frm.set_value("meses_a_pagar", max_meses);
		}
	});
}

function _emp_pedir_excepcao(frm, excedencias) {
	return new Promise(resolve => {
		let resolvido = false;
		const concluir = motivo => {
			if (resolvido) return;
			resolvido = true;
			resolve(motivo);
		};

		const mensagem = `<p>${excedencias.join("<br>")}</p><p>${__("Deseja avançar mesmo assim?")}</p>`;
		const d = new frappe.ui.Dialog({
			title: __("Limite de Empréstimo Excedido"),
			fields: [
				{ fieldname: "aviso", fieldtype: "HTML", options: mensagem },
				{
					fieldname: "motivo",
					fieldtype: "Small Text",
					label: __("Motivo da Excepção"),
					reqd: 1,
					default: frm.doc.motivo_excepcao || "",
				},
			],
			primary_action_label: __("Confirmar Excepção"),
			primary_action(values) {
				d.hide();
				concluir(values.motivo);
			},
			secondary_action_label: __("Cancelar"),
			secondary_action() {
				d.hide();
				concluir(null);
			},
		});
		// Rede de segurança: ESC/clique fora/X também tem de libertar a promise.
		d.$wrapper.on("hidden.bs.modal", () => concluir(null));
		d.show();
	});
}

async function _emp_checar_limites(frm) {
	if (frm._emp_checking) return;
	if (!frm.doc.funcionario || !frm.doc.valor_a_pagar || !frm.doc.meses_a_pagar) return;

	frm._emp_checking = true;
	try {
		const r = await frappe.call({
			method: "sigos.payroll_ext.doctype.emprestimo.emprestimo.verificar_limites",
			args: {
				funcionario: frm.doc.funcionario,
				salario_base: frm.doc.salario_base,
				valor_a_pagar: frm.doc.valor_a_pagar,
				meses_a_pagar: frm.doc.meses_a_pagar,
			},
		});
		const { bloqueantes = [], excepcionaveis = [] } = r.message || {};

		// Bloqueantes (meses, prestação mensal): apenas informa — não há excepção possível.
		if (bloqueantes.length) {
			frappe.show_alert({ message: bloqueantes.join(" "), indicator: "red" }, 7);
		}

		if (!excepcionaveis.length) {
			if (frm.doc.excepcao_limite) {
				// Já não excede o limite do valor total — a excepção deixou de ser necessária.
				frm.set_value("excepcao_limite", 0);
				frm.set_value("motivo_excepcao", "");
			}
			return;
		}

		if (frm.doc.excepcao_limite && frm.doc.motivo_excepcao) return;

		const motivo = await _emp_pedir_excepcao(frm, excepcionaveis);
		if (motivo) {
			frm.set_value("excepcao_limite", 1);
			frm.set_value("motivo_excepcao", motivo);
			frappe.show_alert({ message: __("Excepção registada — o valor do empréstimo pode exceder o limite configurado."), indicator: "orange" });
		}
	} finally {
		frm._emp_checking = false;
	}
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
		if (frm.doc.funcionario && !frm.doc.salario_base) {
			_emp_buscar_salario_base(frm);
		}
	},

	async funcionario(frm) {
		const ativo = await _emp_verificar_ativo(frm);
		if (ativo) {
			frm.set_value("funcionario", null);
			return;
		}
		await _emp_buscar_salario_base(frm);
		_emp_aplicar_defaults(frm);
	},

	mes_referencia(frm) {
		_emp_calcular_data_inicio_por_mes(frm);
	},

	valor_a_pagar(frm) {
		_emp_calcular_valor_mensal(frm);
		_emp_checar_limites(frm);
	},

	meses_a_pagar(frm) {
		_emp_clamp_meses(frm);
		_emp_calcular_valor_mensal(frm);
		_emp_calcular_data_fim(frm);
		_emp_checar_limites(frm);
	},

	data_de_inicio(frm) {
		_emp_calcular_data_fim(frm);
	}
});
