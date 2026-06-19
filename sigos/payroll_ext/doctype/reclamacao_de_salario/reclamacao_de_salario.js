const _RS_MESES_NUM = {
	"01": "Janeiro", "02": "Fevereiro", "03": "Março", "04": "Abril",
	"05": "Maio", "06": "Junho", "07": "Julho", "08": "Agosto",
	"09": "Setembro", "10": "Outubro", "11": "Novembro", "12": "Dezembro"
};

const _RS_MESES_STR = {
	"Janeiro": "01", "Fevereiro": "02", "Março": "03", "Abril": "04",
	"Maio": "05", "Junho": "06", "Julho": "07", "Agosto": "08",
	"Setembro": "09", "Outubro": "10", "Novembro": "11", "Dezembro": "12"
};

frappe.ui.form.on("Reclamacao De Salario", {

	onload(frm) {
		frm.set_query("funcionario", () => ({
			filters: { status: "Active" }
		}));
		if (frm.is_new() && !frm.doc.ano_de_reclamacao) {
			frm.set_value("ano_de_reclamacao", new Date().getFullYear());
		}
	},

	mes_de_reclamacao(frm) {
		_rs_resolver_folha(frm);
	},

	ano_de_reclamacao(frm) {
		_rs_resolver_folha(frm);
	},

	data(frm) {
		if (!frm.doc.data) return;

		const partes = frm.doc.data.split("-");
		let ano = parseInt(partes[0]);
		let mes = parseInt(partes[1]) + 1; // próximo mês

		if (mes > 12) {
			mes = 1;
			ano += 1;
		}

		const mes_fmt = mes.toString().padStart(2, "0");
		const nome_mes = _RS_MESES_NUM[mes_fmt];
		frm.set_value("mes_a_ser_pago", nome_mes);
	},

	mes_a_ser_pago(frm) {
		if (!frm.doc.mes_a_ser_pago) return;

		// Mirror the server: nearest current/future occurrence of the chosen month.
		const mes = parseInt(_RS_MESES_STR[frm.doc.mes_a_ser_pago]);
		const hoje = frappe.datetime.str_to_obj(frappe.datetime.get_today());
		const mes_actual = hoje.getMonth() + 1;
		const ano = (mes >= mes_actual) ? hoje.getFullYear() : hoje.getFullYear() + 1;

		const mes_fmt = mes.toString().padStart(2, "0");
		frm.set_value("data_de_inicio", `${ano}-${mes_fmt}-01`);
		const ultimo_dia = new Date(ano, mes, 0).getDate();
		frm.set_value("data_de_fim", `${ano}-${mes_fmt}-${ultimo_dia.toString().padStart(2, "0")}`);

		_rs_verificar_slip(frm);
	},

	funcionario(frm) {
		if (!frm.doc.funcionario) return;
		_rs_resolver_folha(frm);
		_rs_verificar_slip(frm);
	},

	dia_da_falta_inicio(frm) {
		_rs_calcular_fim_falta(frm);
	},

	numero_faltas(frm) {
		_rs_calcular_fim_falta(frm);
	}
});


// Resolve the processed Salary Slip for the CLAIMED month (funcionario + mês/ano de
// reclamação) and surface what the system paid (gross + net) as read-only reference.
// Server-authoritative copy runs in validate(); this is just live feedback.
function _rs_resolver_folha(frm) {
	// Blank (not 0) when there's no slip — 0.00 would read like "paid zero".
	const clear = () => {
		frm.set_value("slip_do_funcionario", null);
		frm.set_value("valor_bruto_processado", null);
		frm.set_value("valor_liquido_processado", null);
	};
	if (!frm.doc.funcionario || !frm.doc.mes_de_reclamacao || !frm.doc.ano_de_reclamacao) {
		clear();
		frm.set_intro("");
		return;
	}
	frappe.call({
		method: "sigos.payroll_ext.doctype.reclamacao_de_salario.reclamacao_de_salario.resolver_folha_reclamacao",
		args: {
			funcionario: frm.doc.funcionario,
			mes: frm.doc.mes_de_reclamacao,
			ano: frm.doc.ano_de_reclamacao,
		},
		callback(r) {
			const d = r.message || {};
			if (d.slip) {
				frm.set_value("slip_do_funcionario", d.slip);
				frm.set_value("valor_bruto_processado", d.bruto);
				frm.set_value("valor_liquido_processado", d.liquido);
				frm.set_intro("");   // clear the no-slip banner
			} else {
				clear();
				// Persistent banner (not just a toast) — but non-blocking: a claim for a
				// genuinely-unpaid month is valid, so the save still goes through.
				frm.set_intro(
					__("Nenhuma Salary Slip processada encontrada para {0}/{1} — sem pagamento registado nesse mês. Pode prosseguir se a reclamação for mesmo de um mês não pago.",
						[frm.doc.mes_de_reclamacao, frm.doc.ano_de_reclamacao]),
					"orange"
				);
			}
		},
	});
}


// Early hint: warn if the chosen month's slip was already submitted for this
// employee (the server will reject it on save). Non-blocking — just instant feedback.
function _rs_verificar_slip(frm) {
	if (!frm.doc.funcionario || !frm.doc.data_de_inicio || !frm.doc.data_de_fim) return;

	frappe.db.get_list("Salary Slip", {
		filters: [
			["employee", "=", frm.doc.funcionario],
			["docstatus", "=", 1],
			["start_date", "<=", frm.doc.data_de_fim],
			["end_date", ">=", frm.doc.data_de_inicio],
		],
		fields: ["name"],
		limit: 1,
	}).then(rows => {
		if (rows && rows.length) {
			frappe.msgprint({
				title: __("Mês já processado"),
				message: __(
					"Já existe uma Salary Slip submetida ({0}) para este funcionário no mês seleccionado. " +
					"A reclamação será rejeitada ao guardar — escolha o mês actual ou um mês futuro ainda não processado.",
					[rows[0].name]
				),
				indicator: "orange",
			});
		}
	});
}


function _rs_calcular_fim_falta(frm) {
	if (!frm.doc.dia_da_falta_inicio || !frm.doc.numero_faltas) return;

	const inicio = frappe.datetime.str_to_obj(frm.doc.dia_da_falta_inicio);
	const dias = frm.doc.numero_faltas;

	let fim = new Date(inicio);
	fim.setDate(fim.getDate() + (dias - 1));

	frm.set_value("dia_da_falta_do_fim", frappe.datetime.obj_to_str(fim));
}
