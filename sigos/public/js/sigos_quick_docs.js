// sigos.quick_docs — shared quick-create dialogs for salary + payroll money docs.
// One implementation, three callers: Vigilante ("Definir Salário" button), the
// Employee "Painel RH 360" deck, and the Diretório de Colaboradores page. Money
// docs are always inserted as Rascunho (docstatus 0) — they still go through the
// normal Rascunho -> Pendente -> Aprovado workflow, this just skips the navigation.

frappe.provide("sigos.quick_docs");

const QD_MESES = [
	"Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
	"Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];
const QD_MES_OPTS = "\n" + QD_MESES.join("\n");

function _qd_insert(doctype, values, on_done) {
	frappe.call({
		method: "frappe.client.insert",
		args: { doc: Object.assign({ doctype }, values) },
		freeze: true,
		freeze_message: __("A criar…"),
	}).then((r) => {
		if (r && r.message) {
			frappe.show_alert({ message: __("{0} criado: {1}", [doctype, r.message.name]), indicator: "green" }, 6);
			if (on_done) on_done(r.message);
		}
	});
}

// ─── Definir Salário ────────────────────────────────────────────────────────
// Pre-fills the guard's CURRENT resolved base, lets the caller set a manual
// override (or revert to the contract/regime base). Server refuses a pay CUT
// unless confirmed. `on_done(result)` fires after the base is actually applied.
// `salario_base_manual` (optional): pass the guard's current manual override
// when the caller already has it (e.g. Vigilante's own field) so the "herdar do
// contrato" checkbox defaults correctly; omit it when unknown (Employee-keyed
// callers) and the dialog defaults to a manual value pre-filled with the
// resolved base.
sigos.quick_docs.definir_salario = function (vigilante, on_done, salario_base_manual) {
	frappe.xcall("sigos.api.resolver_salario_base", { vigilante }).then((atual) => {
		const tem_override = !!(salario_base_manual && salario_base_manual > 0);
		const d = new frappe.ui.Dialog({
			title: __("Definir Salário Base"),
			fields: [
				{ fieldtype: "HTML", options: `<p class="text-muted" style="margin-bottom:10px">${__(
					"Salário base actual resolvido: <b>{0}</b>. Defina um valor manual ou opte por herdar o salário do contrato (por regime).",
					[format_currency(atual)])}</p>` },
				{ fieldname: "usar_contrato", fieldtype: "Check", label: __("Herdar salário do contrato (sem override manual)"),
					default: tem_override ? 0 : 1 },
				{ fieldname: "valor", fieldtype: "Currency", label: __("Salário Base (manual)"),
					default: salario_base_manual || atual, depends_on: "eval:!doc.usar_contrato" },
			],
			primary_action_label: __("Aplicar"),
			primary_action(vals) {
				d.hide();
				_qd_aplicar_salario(vigilante, vals, 0, on_done);
			},
		});
		d.show();
	});
};

function _qd_aplicar_salario(vigilante, vals, confirmar_reducao, on_done) {
	frappe.xcall("sigos.api.definir_salario_base", {
		vigilante,
		valor: vals.valor,
		usar_contrato: vals.usar_contrato ? 1 : 0,
		confirmar_reducao,
	}).then((r) => {
		if (r && r.requires_confirm) {
			frappe.confirm(
				__("Está a <b>reduzir</b> o salário base de <b>{0}</b> para <b>{1}</b>. Confirmar a redução?",
					[format_currency(r.atual), format_currency(r.novo)]),
				() => _qd_aplicar_salario(vigilante, vals, 1, on_done),
			);
			return;
		}
		frappe.show_alert({ message: __("Salário base aplicado: {0}", [format_currency((r && r.base) || 0)]), indicator: "green" }, 6);
		if (on_done) on_done(r);
	});
}

// ─── Money docs (Outras Deducoes / Emprestimo / Outras Remuneracoes / Reclamacao) ──
sigos.quick_docs.novo_deducao = function (funcionario, funcionario_nome, on_done) {
	const d = new frappe.ui.Dialog({
		title: __("Nova Dedução"),
		fields: [
			{ fieldname: "tipo", fieldtype: "Link", options: "Salary Component", label: __("Tipo (Componente de Dedução)"), reqd: 1 },
			{ fieldname: "tipo_de_pagamento", fieldtype: "Select", options: "\nDeterminado\nEm Prestações", label: __("Tipo de Pagamento") },
			{ fieldname: "col_1", fieldtype: "Column Break" },
			{ fieldname: "valor_a_pagar", fieldtype: "Currency", label: __("Valor a Pagar"), reqd: 1 },
			{ fieldname: "meses_a_pagar", fieldtype: "Int", label: __("Meses a Pagar"), default: 1 },
			{ fieldname: "mes_referencia", fieldtype: "Select", options: QD_MES_OPTS, label: __("Mês de Referência") },
			{ fieldname: "descricao", fieldtype: "Small Text", label: __("Descrição") },
		],
		primary_action_label: __("Criar Rascunho"),
		primary_action(vals) {
			d.hide();
			_qd_insert("Outras Deducoes", { funcionario, funcionario_nome, ...vals }, on_done);
		},
	});
	d.show();
};

sigos.quick_docs.novo_emprestimo = function (funcionario, funcionario_nome, on_done) {
	const d = new frappe.ui.Dialog({
		title: __("Novo Empréstimo"),
		fields: [
			{ fieldname: "valor_a_pagar", fieldtype: "Currency", label: __("Valor do Empréstimo"), reqd: 1 },
			{ fieldname: "meses_a_pagar", fieldtype: "Int", label: __("Meses a Pagar"), default: 1 },
			{ fieldname: "col_1", fieldtype: "Column Break" },
			{ fieldname: "mes_referencia", fieldtype: "Select", options: QD_MES_OPTS, label: __("Mês de Referência") },
			{ fieldname: "descricao", fieldtype: "Small Text", label: __("Descrição") },
		],
		primary_action_label: __("Criar Rascunho"),
		primary_action(vals) {
			d.hide();
			_qd_insert("Emprestimo", { funcionario, funcionario_nome, ...vals }, on_done);
		},
	});
	d.show();
};

sigos.quick_docs.novo_remuneracao = function (funcionario, funcionario_nome, on_done) {
	const d = new frappe.ui.Dialog({
		title: __("Novo Provento"),
		fields: [
			{ fieldname: "tipo_de_subsidios", fieldtype: "Link", options: "Salary Component", label: __("Tipo de Subsídio") },
			{ fieldname: "tipo_de_pagamento", fieldtype: "Select", options: "\nDeterminado\nEm Prestações", label: __("Tipo de Pagamento"), reqd: 1 },
			{ fieldname: "col_1", fieldtype: "Column Break" },
			{ fieldname: "valor_a_pagar", fieldtype: "Currency", label: __("Valor a Pagar"), reqd: 1 },
			{ fieldname: "meses_a_pagar", fieldtype: "Int", label: __("Meses a Pagar"), default: 1 },
			{ fieldname: "mes_referencia", fieldtype: "Select", options: QD_MES_OPTS, label: __("Mês de Referência") },
		],
		primary_action_label: __("Criar Rascunho"),
		primary_action(vals) {
			d.hide();
			_qd_insert("Outras Remuneracoes", { funcionario, funcionario_nome, ...vals }, on_done);
		},
	});
	d.show();
};

sigos.quick_docs.nova_reclamacao = function (funcionario, funcionario_nome, on_done) {
	const d = new frappe.ui.Dialog({
		title: __("Nova Reclamação de Salário"),
		fields: [
			{ fieldname: "mes_a_ser_pago", fieldtype: "Select", options: QD_MES_OPTS, label: __("Mês a Ser Pago"), reqd: 1 },
			{ fieldname: "valor_a_reclamar", fieldtype: "Currency", label: __("Valor a Reclamar"), reqd: 1 },
			{ fieldname: "col_1", fieldtype: "Column Break" },
			{ fieldname: "mes_de_reclamacao", fieldtype: "Select", options: QD_MES_OPTS, label: __("Mês em Reclamação (o que foi pago)") },
			{ fieldname: "ano_de_reclamacao", fieldtype: "Int", label: __("Ano de Reclamação"), default: new Date().getFullYear() },
			{ fieldname: "motivo", fieldtype: "Small Text", label: __("Motivo"), reqd: 1 },
		],
		primary_action_label: __("Criar Rascunho"),
		primary_action(vals) {
			d.hide();
			_qd_insert("Reclamacao De Salario", { funcionario, funcionario_nome, ...vals }, on_done);
		},
	});
	d.show();
};
