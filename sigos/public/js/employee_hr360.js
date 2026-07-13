// EMPLOYEE — "Painel RH 360". Default-on for every customer (SIGOS Settings.
// painel_rh_360_activo, default 1 — still a real toggle, e.g. for a customer who
// prefers to only use the Diretório de Colaboradores). Single-pane HR view:
// faltas, saldo de férias, salário/SSA e folhas recentes, e deduções/empréstimos/
// proventos/reclamações — com atalhos para criar esses documentos e para "Definir
// Salário", tudo sem sair do Employee. Reuses the existing sigos.api endpoints
// (get_employee_hr360, resolver_salario_base, definir_salario_base) and the
// sigos.quick_docs dialogs (sigos_quick_docs.js) — no duplicate calculation or
// dialog logic here.

let _rh360_activo = null;   // null = not fetched yet this session, else bool
let _rh360_data = {};       // employee name -> last fetched payload
let _rh360_tab = {};        // employee name -> active tab key

frappe.ui.form.on("Employee", {
	refresh(frm) {
		_rh360_setup(frm);
	},
});

// ─── Gate: default-on, still togglable per SIGOS Settings (fetched once per session) ──
function _rh360_setup(frm) {
	if (frm.is_new()) return;
	if (_rh360_activo === null) {
		frappe.db.get_single_value("SIGOS Settings", "painel_rh_360_activo").then((v) => {
			_rh360_activo = !!v;
			_rh360_toggle(frm);
		});
	} else {
		_rh360_toggle(frm);
	}
}

function _rh360_toggle(frm) {
	frm.set_df_property("custom_rh360_tab", "hidden", _rh360_activo ? 0 : 1);
	frm.set_df_property("custom_rh360_panel", "hidden", _rh360_activo ? 0 : 1);
	if (_rh360_activo) _rh360_render(frm);
}

// ─── Fetch + build ──────────────────────────────────────────────────────────────
function _rh360_render(frm) {
	_rh360_inject_css();
	const w = frm.fields_dict.custom_rh360_panel?.$wrapper;
	if (!w) return;
	w.html(`<div id="sigos-emp360" class="emp360-loading">${__("A carregar…")}</div>`);
	frappe.xcall("sigos.api.get_employee_hr360", { employee: frm.doc.name }).then((data) => {
		_rh360_data[frm.doc.name] = data;
		if (!_rh360_tab[frm.doc.name]) _rh360_tab[frm.doc.name] = "faltas";
		_rh360_build(frm, w, data);
	});
}

function _rh360_build(frm, w, data) {
	const tabs = [
		["faltas", __("Faltas")],
		["ferias", __("Férias")],
		["salario", __("Salário")],
		["deducoes", __("Deduções & Proventos")],
		["acoes", __("Ações Rápidas")],
	];
	const activeTab = _rh360_tab[frm.doc.name] || "faltas";

	w.html(`
		<div id="sigos-emp360" data-doc="${frm.doc.name}">
			<div class="emp360-head">
				<div class="emp360-title">${__("Painel RH 360")}</div>
				${!data.vigilante ? `<span class="emp360-note">${__("Sem Vigilante (SIGOS) associado — faltas e Definir Salário indisponíveis.")}</span>` : ""}
			</div>
			<div class="emp360-tiles">
				${_rh360_tile("t-aus", data.vigilante ? data.faltas.mes_atual : "—", __("Faltas Este Mês"))}
				${_rh360_tile("t-fer", _rh360_ferias_resumo(data.ferias), __("Saldo de Férias"))}
				${_rh360_tile("t-sal", format_currency(data.salario.base_resolvida), __("Salário Base"))}
				${_rh360_tile("t-ded", _rh360_deducoes_resumo(data), __("Deduções/Empréstimos Activos"))}
			</div>
			<div class="emp360-tabs" data-tabs>
				${tabs.map(([k, l]) => `<button type="button" class="emp360-tab ${k === activeTab ? "is-active" : ""}" data-tab="${k}">${l}</button>`).join("")}
			</div>
			<div class="emp360-body" data-body></div>
		</div>`);

	w.find("[data-tab]").on("click", function () {
		const k = $(this).attr("data-tab");
		_rh360_tab[frm.doc.name] = k;
		w.find("[data-tab]").removeClass("is-active");
		$(this).addClass("is-active");
		_rh360_render_body(frm, w, data, k);
	});

	_rh360_render_body(frm, w, data, activeTab);
}

function _rh360_tile(cls, value, label) {
	return `<div class="emp360-tile ${cls}"><div class="n">${value}</div><div class="lbl">${label}</div></div>`;
}

function _rh360_ferias_resumo(ferias) {
	if (!ferias || !ferias.length) return "—";
	if (ferias.length === 1) return flt(ferias[0].saldo, 1);
	return `${ferias.length} ${__("tipos")}`;
}

function _rh360_deducoes_resumo(data) {
	const linhas = (data.deducoes || []).concat(data.emprestimos || []);
	if (!linhas.length) return "0";
	const valor = linhas.reduce((s, d) => s + flt(d.valor_mensal), 0);
	return `${linhas.length} · ${format_currency(valor)}/${__("mês")}`;
}

function _rh360_render_body(frm, w, data, tab) {
	const $b = w.find("[data-body]");
	if (tab === "faltas") return $b.html(_rh360_tab_faltas(data));
	if (tab === "ferias") return $b.html(_rh360_tab_ferias(data));
	if (tab === "salario") return $b.html(_rh360_tab_salario(data));
	if (tab === "deducoes") return $b.html(_rh360_tab_deducoes(data));
	if (tab === "acoes") return _rh360_tab_acoes(frm, w, data, $b);
}

// ─── Tab content builders (read-only display) ──────────────────────────────────
function _rh360_tab_faltas(data) {
	const rows = data.faltas.recentes || [];
	if (!rows.length) return `<p class="emp360-empty">${__("Sem faltas registadas nos últimos 3 meses.")}</p>`;
	return `<table class="emp360-table">
		<thead><tr>
			<th>${__("Data")}</th><th>${__("Turno")}</th><th>${__("Tipo")}</th>
			<th>${__("Peso")}</th><th>${__("Justificação")}</th>
		</tr></thead>
		<tbody>${rows.map((r) => `
			<tr>
				<td>${frappe.datetime.str_to_user(r.data)}</td>
				<td>${frappe.utils.escape_html(r.turno || "—")}</td>
				<td>${frappe.utils.escape_html(r.subtipo_falta || r.tipo_de_ausencia || "—")}</td>
				<td>${r.n_de_faltas}</td>
				<td>${frappe.utils.escape_html(r.tipo_justificacao || "—")}</td>
			</tr>`).join("")}
		</tbody>
	</table>`;
}

function _rh360_tab_ferias(data) {
	const rows = data.ferias || [];
	if (!rows.length) return `<p class="emp360-empty">${__("Sem alocação de férias activa.")}</p>`;
	return `<table class="emp360-table">
		<thead><tr><th>${__("Tipo de Licença")}</th><th>${__("Saldo (dias)")}</th></tr></thead>
		<tbody>${rows.map((r) => `<tr><td>${frappe.utils.escape_html(r.leave_type)}</td><td>${flt(r.saldo, 1)}</td></tr>`).join("")}</tbody>
	</table>`;
}

function _rh360_tab_salario(data) {
	const ssa = data.salario.ssa_atual;
	const slips = data.salario.slips_recentes || [];
	let html = `<div class="emp360-block">
		<div class="emp360-block-title">${__("Estrutura Salarial Actual")}</div>
		${ssa
			? `<p>${_rh360_link("Salary Structure Assignment", ssa.name, ssa.salary_structure)} — <b>${format_currency(ssa.base)}</b> <span class="emp360-muted">(${__("desde")} ${frappe.datetime.str_to_user(ssa.from_date)})</span></p>`
			: `<p class="emp360-empty">${__("Sem Salary Structure Assignment submetida.")}</p>`}
	</div>`;
	html += `<div class="emp360-block">
		<div class="emp360-block-title">${__("Folhas de Salário Recentes")}</div>
		${slips.length
			? `<table class="emp360-table">
				<thead><tr><th>${__("Período")}</th><th>${__("Bruto")}</th><th>${__("Deduções")}</th><th>${__("Líquido")}</th></tr></thead>
				<tbody>${slips.map((s) => `<tr>
					<td>${_rh360_link("Salary Slip", s.name, `${frappe.datetime.str_to_user(s.start_date)} – ${frappe.datetime.str_to_user(s.end_date)}`)}</td>
					<td>${format_currency(s.gross_pay)}</td>
					<td>${format_currency(s.total_deduction)}</td>
					<td>${format_currency(s.net_pay)}</td>
				</tr>`).join("")}</tbody>
			</table>`
			: `<p class="emp360-empty">${__("Sem folhas de salário submetidas.")}</p>`}
	</div>`;
	return html;
}

function _rh360_tab_deducoes(data) {
	const secao = (titulo, rows, cols) => `
		<div class="emp360-block">
			<div class="emp360-block-title">${titulo}</div>
			${rows.length
				? `<table class="emp360-table">
					<thead><tr>${cols.map((c) => `<th>${c.label}</th>`).join("")}</tr></thead>
					<tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${c.render ? c.render(r) : frappe.utils.escape_html(r[c.field] ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody>
				</table>`
				: `<p class="emp360-empty">${__("Nenhum(a).")}</p>`}
		</div>`;

	return secao(__("Deduções Activas"), data.deducoes || [], [
		{ label: __("Nome"), render: (r) => _rh360_link("Outras Deducoes", r.name, r.name) },
		{ label: __("Tipo"), field: "tipo" },
		{ label: __("Valor Mensal"), render: (r) => format_currency(r.valor_mensal) },
		{ label: __("Até"), render: (r) => (r.data_de_fim ? frappe.datetime.str_to_user(r.data_de_fim) : "—") },
	]) + secao(__("Empréstimos Activos"), data.emprestimos || [], [
		{ label: __("Nome"), render: (r) => _rh360_link("Emprestimo", r.name, r.name) },
		{ label: __("Prestação Mensal"), render: (r) => format_currency(r.valor_mensal) },
		{ label: __("Até"), render: (r) => (r.data_de_fim ? frappe.datetime.str_to_user(r.data_de_fim) : "—") },
	]) + secao(__("Proventos (recentes)"), data.remuneracoes || [], [
		{ label: __("Nome"), render: (r) => _rh360_link("Outras Remuneracoes", r.name, r.name) },
		{ label: __("Tipo"), field: "tipo_de_subsidios" },
		{ label: __("Valor"), render: (r) => format_currency(r.valor_a_pagar) },
		{ label: __("Estado"), field: "workflow_state" },
	]) + secao(__("Reclamações de Salário (recentes)"), data.reclamacoes || [], [
		{ label: __("Nome"), render: (r) => _rh360_link("Reclamacao De Salario", r.name, r.name) },
		{ label: __("Mês a Pagar"), field: "mes_a_ser_pago" },
		{ label: __("Valor"), render: (r) => format_currency(r.valor_a_reclamar) },
		{ label: __("Estado"), field: "workflow_state" },
	]);
}

function _rh360_link(doctype, name, texto) {
	return `<a href="${frappe.utils.get_form_link(doctype, name)}" target="_blank">${frappe.utils.escape_html(texto || name)}</a>`;
}

// ─── Ações Rápidas: quick-create dialogs (insert as Rascunho, no auto-submit) ──
function _rh360_tab_acoes(frm, w, data, $b) {
	$b.html(`
		<div class="emp360-actions">
			<button type="button" class="emp360-action-btn" data-act="salario">${__("Definir Salário")}</button>
			<button type="button" class="emp360-action-btn" data-act="deducao">${__("Nova Dedução")}</button>
			<button type="button" class="emp360-action-btn" data-act="emprestimo">${__("Novo Empréstimo")}</button>
			<button type="button" class="emp360-action-btn" data-act="remuneracao">${__("Novo Provento")}</button>
			<button type="button" class="emp360-action-btn" data-act="reclamacao">${__("Nova Reclamação de Salário")}</button>
		</div>
		<p class="emp360-muted" style="margin-top:10px">${__("As deduções, empréstimos, proventos e reclamações são criados como Rascunho — seguem o fluxo de aprovação normal (Pendente → Aprovado).")}</p>`);

	$b.find("[data-act]").on("click", function () {
		const act = $(this).attr("data-act");
		if (act === "salario") return _rh360_definir_salario(frm);
		if (act === "deducao") return _rh360_novo_deducao(frm);
		if (act === "emprestimo") return _rh360_novo_emprestimo(frm);
		if (act === "remuneracao") return _rh360_novo_remuneracao(frm);
		if (act === "reclamacao") return _rh360_novo_reclamacao(frm);
	});
}

// Thin wrappers: the actual dialogs live in sigos.quick_docs (sigos_quick_docs.js),
// shared with Vigilante's "Definir Salário" and the Diretório de Colaboradores page.
function _rh360_novo_deducao(frm) {
	sigos.quick_docs.novo_deducao(frm.doc.name, frm.doc.employee_name, () => _rh360_render(frm));
}

function _rh360_novo_emprestimo(frm) {
	sigos.quick_docs.novo_emprestimo(frm.doc.name, frm.doc.employee_name, () => _rh360_render(frm));
}

function _rh360_novo_remuneracao(frm) {
	sigos.quick_docs.novo_remuneracao(frm.doc.name, frm.doc.employee_name, () => _rh360_render(frm));
}

function _rh360_novo_reclamacao(frm) {
	sigos.quick_docs.nova_reclamacao(frm.doc.name, frm.doc.employee_name, () => _rh360_render(frm));
}

// ─── Definir Salário — same server calls/flow as Vigilante's button, resolved
// through the Employee's linked Vigilante (custom_vigilante). ─────────────────
function _rh360_definir_salario(frm) {
	const vigilante = frm.doc.custom_vigilante;
	if (!vigilante) {
		frappe.msgprint(__("Este Employee não tem um Vigilante (SIGOS) associado — não é possível definir o salário por aqui."));
		return;
	}
	sigos.quick_docs.definir_salario(vigilante, () => _rh360_render(frm));
}

// ─── Self-injected CSS (ASCII only) — same dark-deck language as the Ausências
// board, for visual consistency across SIGOS form decks. ───────────────────────
function _rh360_inject_css() {
	if (document.getElementById("sigos-emp360-css")) return;
	const css = `
#sigos-emp360 {
	margin: 0 0 14px; padding: 16px 18px; border-radius: 14px; color: #fff;
	background: linear-gradient(135deg, #234a73 0%, #1a3a5c 60%, #14304c 100%);
	box-shadow: 0 8px 24px rgba(20,48,76,.28), inset 0 1px 0 rgba(255,255,255,.08);
	border: 1px solid rgba(255,255,255,.06);
}
#sigos-emp360.emp360-loading { padding: 24px; text-align: center; color: rgba(255,255,255,.75); font-style: italic; }
.emp360-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.emp360-title { font-family: var(--sigos-display, system-ui); font-weight: 700; font-size: 1.18em; letter-spacing: .03em; text-transform: uppercase; line-height: 1; }
.emp360-note { font-size: .78em; font-weight: 600; color: #f4cd84; }
.emp360-tiles { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
.emp360-tile { min-width: 130px; flex: 1; padding: 10px 14px; border-radius: 10px; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.1); display: flex; flex-direction: column; gap: 2px; }
.emp360-tile .n { font-family: var(--sigos-display, system-ui); font-weight: 700; font-size: 1.5em; line-height: 1.1; font-variant-numeric: tabular-nums; }
.emp360-tile .lbl { font-size: .68em; text-transform: uppercase; letter-spacing: .05em; color: rgba(255,255,255,.65); }
.emp360-tile.t-aus .n { color: #ff9d9d; }
.emp360-tile.t-fer .n { color: #8fe6b8; }
.emp360-tile.t-sal .n { color: #8fd0ff; }
.emp360-tile.t-ded .n { color: #f4cd84; }
.emp360-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 16px; border-bottom: 1px solid rgba(255,255,255,.14); padding-bottom: 8px; }
.emp360-tab { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.12); color: rgba(255,255,255,.78); border-radius: 999px; padding: 6px 14px; font-size: .82em; font-weight: 600; cursor: pointer; }
.emp360-tab:hover { background: rgba(255,255,255,.14); }
.emp360-tab.is-active { background: #e8a020; border-color: #e8a020; color: #14304c; font-weight: 700; }
.emp360-body { margin-top: 14px; }
.emp360-block + .emp360-block { margin-top: 16px; }
.emp360-block-title { font-size: .78em; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #8fd0ff; margin-bottom: 6px; }
.emp360-empty { color: rgba(255,255,255,.6); font-style: italic; font-size: .86em; margin: 4px 0; }
.emp360-muted { color: rgba(255,255,255,.6); font-size: .88em; }
.emp360-table { width: 100%; border-collapse: collapse; font-size: .86em; }
.emp360-table th { text-align: left; font-size: .7em; text-transform: uppercase; letter-spacing: .04em; color: rgba(255,255,255,.6); padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,.14); }
.emp360-table td { padding: 7px 8px; border-bottom: 1px solid rgba(255,255,255,.08); }
.emp360-table tr:hover td { background: rgba(255,255,255,.05); }
.emp360-table a { color: #8fd0ff; }
.emp360-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.emp360-action-btn { background: #e8a020; color: #14304c; border: none; border-radius: 9px; padding: 10px 18px; font-weight: 700; font-size: .9em; letter-spacing: .01em; cursor: pointer; box-shadow: 0 3px 10px rgba(0,0,0,.25); }
.emp360-action-btn:hover { background: #f2b542; }
@media (max-width: 640px) {
	#sigos-emp360 { padding: 12px 13px; }
	.emp360-tile { min-width: calc(50% - 8px); }
	.emp360-action-btn { flex: 1 1 calc(50% - 10px); }
}
`;
	const s = document.createElement("style");
	s.id = "sigos-emp360-css";
	s.textContent = css;
	document.head.appendChild(s);
}
