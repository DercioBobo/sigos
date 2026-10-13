// SIGOS - Previsão de Faturação. What each customer will be billed for a month
// (same lines + pre-flight as Faturacao Mensal, via sigos.faturacao.get_previsao_faturacao),
// its automatic-billing schedule and status, with per-customer actions. "Operations
// Daylight" design system — same tokens as Ajuste de Salários / Painel CCO.
frappe.provide("sigos");

frappe.pages["previsao-de-faturacao"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Previsão de Faturação"),
		single_column: true,
	});
	wrapper.previsao_faturacao = new sigos.PrevisaoFaturacao(page, wrapper);
};
frappe.pages["previsao-de-faturacao"].on_page_show = function (wrapper) {
	if (wrapper.previsao_faturacao) wrapper.previsao_faturacao.refresh();
};

const PF_MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
	"Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const PF_MESES_CURTOS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

const PF_ESTADOS = {
	faturado:   { label: "Facturado",          tone: "good" },
	agendado:   { label: "Agendado",           tone: "info" },
	pendente:   { label: "Na próxima execução", tone: "amber" },
	em_falta:   { label: "Não facturado",      tone: "bad" },
	problemas:  { label: "Com problemas",      tone: "bad" },
	cancelado:  { label: "Factura cancelada",  tone: "muted" },
	sem_linhas: { label: "Sem linhas",         tone: "muted" },
	manual:     { label: "Manual",             tone: "neu" },
};

sigos.PrevisaoFaturacao = class PrevisaoFaturacao {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		const hoje = frappe.datetime.str_to_obj(frappe.datetime.get_today());
		this.mes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
		this.state = { search: "", estado: null };
		this.data = null;
		this.abertos = new Set();
		this.pode_executar = frappe.user.has_role("System Manager") || frappe.user.has_role("SIGOS Manager");

		this._inject_fonts();
		this._inject_css();
		this._build_shell();
		this._wire();
	}

	refresh() {
		this._load();
	}

	// ───────────────────────────────────────────────────────── shell + controls
	_build_shell() {
		this.page.main.addClass("sigos-pf");
		this.$body = $(`
			<div class="pf-root">
				<div class="pf-mast">
					<div class="pf-mast-l">
						<div class="pf-mark">${_pf_icon_invoice()}</div>
						<div>
							<div class="pf-up">${__("Faturação")}</div>
							<h1 class="pf-h1">${__("Previsão de Faturação")}</h1>
						</div>
					</div>
					<div class="pf-mast-r">
						<span class="pf-pill" data-auto></span>
						<div class="pf-month">
							<button type="button" class="pf-icon-btn" data-mes="-1" title="${__("Mês anterior")}">&lsaquo;</button>
							<span class="pf-month-lbl" data-mes-lbl></span>
							<button type="button" class="pf-icon-btn" data-mes="1" title="${__("Mês seguinte")}">&rsaquo;</button>
						</div>
						<button type="button" class="pf-btn pf-btn-ghost" data-executar hidden>${__("Executar Agora")}</button>
					</div>
				</div>

				<div data-banners></div>
				<div class="pf-kpis" data-kpis></div>

				<div class="pf-toolbar">
					<div class="pf-search">
						${_pf_icon_search()}
						<input type="text" data-search placeholder="${__("Pesquisar cliente…")}" />
					</div>
					<div class="pf-chips" data-chips></div>
				</div>

				<div class="pf-table-wrap" data-table></div>
			</div>
		`).appendTo(this.page.main);

		this.$banners = this.$body.find("[data-banners]");
		this.$kpis = this.$body.find("[data-kpis]");
		this.$chips = this.$body.find("[data-chips]");
		this.$table = this.$body.find("[data-table]");
	}

	_wire() {
		let debounce;
		this.$body.find("[data-search]").on("input", (e) => {
			const v = e.target.value;
			clearTimeout(debounce);
			debounce = setTimeout(() => { this.state.search = v.trim().toLowerCase(); this._render_table(); }, 200);
		});
		this.$body.find("[data-mes]").on("click", (e) => {
			const passo = parseInt($(e.currentTarget).attr("data-mes"), 10);
			this.mes = new Date(this.mes.getFullYear(), this.mes.getMonth() + passo, 1);
			this.abertos.clear();
			this._load();
		});
		this.$body.find("[data-executar]").on("click", () => this._executar());

		// Delegated: the table is re-rendered on every filter change.
		this.$table.on("click", "[data-toggle-row]", (e) => {
			if ($(e.target).closest("a, button").length) return;
			const c = $(e.currentTarget).attr("data-toggle-row");
			if (this.abertos.has(c)) this.abertos.delete(c); else this.abertos.add(c);
			this._render_table();
		});
		this.$table.on("click", "[data-agenda]", (e) => {
			e.stopPropagation();
			this._editar_agenda($(e.currentTarget).attr("data-agenda"));
		});
		this.$table.on("click", "[data-extra]", (e) => {
			e.stopPropagation();
			this._fatura_extra($(e.currentTarget).attr("data-extra"));
		});
		this.$table.on("click", "[data-faturar]", (e) => {
			e.stopPropagation();
			this._faturar($(e.currentTarget).attr("data-faturar"));
		});
	}

	// ───────────────────────────────────────────────────────────────── data
	_mes_str() {
		const m = this.mes;
		return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-01`;
	}

	_load() {
		this.$body.find("[data-mes-lbl]").text(`${__(PF_MESES[this.mes.getMonth()])} ${this.mes.getFullYear()}`);
		this.$table.html(`<div class="pf-msg">${__("A calcular a facturação…")}</div>`);
		frappe.xcall("sigos.faturacao.get_previsao_faturacao", { mes_referencia: this._mes_str() }).then((r) => {
			this.data = r || { clientes: [] };
			this._render_mast();
			this._render_banners();
			this._render_kpis();
			this._render_chips();
			this._render_table();
		});
	}

	// ─────────────────────────────────────────────────────────────── render
	_render_mast() {
		const d = this.data;
		const $p = this.$body.find("[data-auto]");
		if (d.automatica_geral) {
			$p.attr("class", "pf-pill tone-good").html(
				`<i></i>${__("Automática activa")} · ${d.submeter ? __("submete") : __("rascunhos")}`);
		} else {
			$p.attr("class", "pf-pill tone-muted").html(`<i></i>${__("Automática desligada")}`);
		}
		$p.attr("title", __("Configurar em Definições SIGOS → Faturação"));
		$p.off("click").on("click", () => frappe.set_route("Form", "SIGOS Settings"));
		this.$body.find("[data-executar]").prop("hidden", !(d.automatica_geral && this.pode_executar));
	}

	_render_banners() {
		const d = this.data;
		const out = [];
		if ((d.erros || []).length) {
			out.push(`<div class="pf-banner tone-bad"><b>${__("A facturação deste mês está bloqueada:")}</b>
				<ul>${d.erros.map((e) => `<li>${e}</li>`).join("")}</ul></div>`);
		}
		if ((d.avisos || []).length) {
			out.push(`<details class="pf-banner tone-amber"><summary><b>${__("{0} aviso(s)", [d.avisos.length])}</b>
				— ${__("não impedem o rascunho, mas podem impedir a submissão")}</summary>
				<ul>${d.avisos.map((e) => `<li>${e}</li>`).join("")}</ul></details>`);
		}
		const corrente = this._mes_str() === `${d.hoje.slice(0, 7)}-01`;
		if (d.snapshot_activos && !corrente) {
			out.push(`<div class="pf-banner tone-info">${__(
				"Contratos em <b>Vigilantes Activos</b> mostram o efectivo <b>de hoje</b> — para outro mês é uma estimativa.")}</div>`);
		}
		this.$banners.html(out.join(""));
	}

	_render_kpis() {
		const cs = this.data.clientes || [];
		const soma = (arr, f) => arr.reduce((a, c) => a + (f(c) || 0), 0);
		const faturados = cs.filter((c) => c.estado === "faturado");
		const por_faturar = cs.filter((c) => !["faturado", "cancelado", "sem_linhas"].includes(c.estado));
		const agendados = cs.filter((c) => ["agendado", "pendente"].includes(c.estado));
		const atencao = cs.filter((c) => ["problemas", "em_falta"].includes(c.estado) || c.sem_tarifa.length);
		const vig = soma(cs, (c) => c.vigilantes);
		const extras_total = soma(cs, (c) => soma(c.extras || [], (f) => f.net_total));

		const tile = (key, label, value, sub, tone) => `
			<div class="pf-kpi tone-${tone} ${key && this.state.estado === key ? "is-active" : ""}" ${key ? `data-kpi="${key}"` : ""}>
				<div class="pf-kpi-lbl">${label}</div>
				<div class="pf-kpi-val">${value}</div>
				<div class="pf-kpi-sub">${sub}</div>
			</div>`;
		this.$kpis.html([
			tile(null, __("Total Previsto"), _pf_money(soma(cs, (c) => c.total)),
				__("{0} cliente(s) · {1} vigilante(s)", [cs.filter((c) => c.total).length, vig]), "neu"),
			tile("_faturados", __("Já Facturado"), _pf_money(soma(faturados, (c) => soma(c.faturas, (f) => f.net_total))),
				extras_total
					? __("{0} cliente(s) · + {1} em extras", [faturados.length, _pf_money(extras_total)])
					: __("{0} cliente(s) · sem IVA", [faturados.length]), "good"),
			tile("_por_faturar", __("Por Facturar"), _pf_money(soma(por_faturar, (c) => c.total)),
				__("{0} cliente(s)", [por_faturar.length]), "accent"),
			tile("_agendados", __("Automáticos"), agendados.length,
				__("agendados para este mês"), "info"),
			tile("_atencao", __("Requer Atenção"), atencao.length,
				__("problemas, sem tarifa ou em falta"), atencao.length ? "bad" : "neu"),
		].join(""));
		this.$kpis.find("[data-kpi]").on("click", (e) => {
			const k = $(e.currentTarget).attr("data-kpi");
			this.state.estado = this.state.estado === k ? null : k;
			this._render_kpis();
			this._render_chips();
			this._render_table();
		});
	}

	_render_chips() {
		const cs = this.data.clientes || [];
		const n = {};
		cs.forEach((c) => { n[c.estado] = (n[c.estado] || 0) + 1; });
		const chips = [`<button type="button" class="pf-chip ${!this.state.estado ? "is-active" : ""}" data-chip="">${__("Todos")} <b>${cs.length}</b></button>`];
		Object.keys(PF_ESTADOS).forEach((k) => {
			if (!n[k]) return;
			chips.push(`<button type="button" class="pf-chip ${this.state.estado === k ? "is-active" : ""}" data-chip="${k}">
				<i class="pf-dot tone-${PF_ESTADOS[k].tone}"></i>${__(PF_ESTADOS[k].label)} <b>${n[k]}</b></button>`);
		});
		this.$chips.html(chips.join(""));
		this.$chips.find("[data-chip]").on("click", (e) => {
			this.state.estado = $(e.currentTarget).attr("data-chip") || null;
			this._render_kpis();
			this._render_chips();
			this._render_table();
		});
	}

	_filtrados() {
		const e = this.state.estado;
		const q = this.state.search;
		return (this.data.clientes || []).filter((c) => {
			if (q && !`${c.nome} ${c.cliente}`.toLowerCase().includes(q)) return false;
			if (!e) return true;
			if (e === "_faturados") return c.estado === "faturado";
			if (e === "_por_faturar") return !["faturado", "cancelado", "sem_linhas"].includes(c.estado);
			if (e === "_agendados") return ["agendado", "pendente"].includes(c.estado);
			if (e === "_atencao") return ["problemas", "em_falta"].includes(c.estado) || c.sem_tarifa.length;
			return c.estado === e;
		});
	}

	_render_table() {
		if (!this.data) return;
		const rows = this._filtrados();
		if (!rows.length) {
			this.$table.html(`<div class="pf-msg">${__("Nenhum cliente para mostrar.")}</div>`);
			return;
		}
		this.$table.html(`
			<table class="pf-table">
				<thead><tr>
					<th class="pf-caret-col"></th>
					<th>${__("Cliente")}</th>
					<th class="pf-num">${__("Contratos")}</th>
					<th class="pf-num">${__("Vigilantes")}</th>
					<th class="pf-num">${__("Previsto (s/ IVA)")}</th>
					<th class="pf-num">${__("vs. Mês Anterior")}</th>
					<th>${__("Agenda")}</th>
					<th>${__("Estado")}</th>
					<th class="pf-act-col"></th>
				</tr></thead>
				<tbody>${rows.map((c) => this._row_html(c)).join("")}</tbody>
			</table>
		`);
	}

	_row_html(c) {
		const esc = frappe.utils.escape_html;
		const aberto = this.abertos.has(c.cliente);
		const est = PF_ESTADOS[c.estado] || PF_ESTADOS.manual;
		const ag = c.agenda;

		let estado_txt = __(est.label);
		if (c.estado === "agendado" || c.estado === "pendente") estado_txt += ` · ${_pf_dia(ag.data)}`;
		if (c.estado === "faturado" && c.faturas.some((f) => f.docstatus === 0)) estado_txt += ` · ${__("rascunho")}`;

		const agenda_txt = ag.opt_in
			? `${__("Dia {0}", [ag.dia >= 31 ? __("último") : ag.dia])} · ${ag.mes_faturado === "Mês Anterior" ? __("vencido") : __("adiantado")}`
			: __("Manual");

		let acao = "";
		if (c.faturas.length) {
			acao = c.faturas.map((f) => `<a href="/app/sales-invoice/${encodeURIComponent(f.name)}">${esc(f.name)}</a>`).join(" ");
		} else if (c.total) {
			acao = `<button type="button" class="pf-btn pf-btn-sm" data-faturar="${esc(c.cliente)}">${__("Faturar")}</button>`;
		}

		acao += ` <button type="button" class="pf-btn pf-btn-sm pf-btn-ghost" data-extra="${esc(c.cliente)}"
			title="${__("Nova factura de serviços extra (não conta como a factura do mês)")}">+ ${__("Extra")}</button>`;

		const alerta = [];
		if ((c.extras || []).length) alerta.push(`<span class="pf-badge tone-info" title="${__("Facturas extra neste mês")}">${__("+{0} extra", [c.extras.length])}</span>`);
		if (c.sem_tarifa.length) alerta.push(`<span class="pf-badge tone-bad">${__("{0} sem tarifa", [c.sem_tarifa.length])}</span>`);
		if (c.em_falta) alerta.push(`<span class="pf-badge tone-amber" title="${__("Vigilantes contratados que não estão activos")}">${__("-{0} vs contrato", [c.em_falta])}</span>`);

		return `
			<tr class="pf-row ${aberto ? "is-open" : ""}" data-toggle-row="${esc(c.cliente)}">
				<td class="pf-caret-col"><span class="pf-caret">${_pf_icon_caret()}</span></td>
				<td>
					<a href="/app/customer/${encodeURIComponent(c.cliente)}" class="pf-name">${esc(c.nome)}</a>
					${alerta.join("")}
				</td>
				<td class="pf-num">${c.contratos}</td>
				<td class="pf-num">${c.vigilantes}</td>
				<td class="pf-num pf-strong">${c.total ? _pf_money(c.total) : "—"}</td>
				<td class="pf-num">${_pf_delta(c.total, c.anterior)}</td>
				<td><button type="button" class="pf-agenda ${ag.opt_in ? "is-auto" : ""}" data-agenda="${esc(c.cliente)}"
					title="${__("Editar agenda de faturação")}">${agenda_txt}</button></td>
				<td><span class="pf-status tone-${est.tone}"><i></i>${estado_txt}</span></td>
				<td class="pf-act-col">${acao}</td>
			</tr>
			${aberto ? `<tr class="pf-detail"><td colspan="9">${this._detalhe_html(c)}</td></tr>` : ""}`;
	}

	_detalhe_html(c) {
		const esc = frappe.utils.escape_html;
		const blocos = [];
		if (c.problemas.length) {
			blocos.push(`<div class="pf-note tone-bad"><b>${__("Problemas")}:</b> ${c.problemas.map(esc).join("; ")}</div>`);
		}
		if (c.sem_tarifa.length) {
			blocos.push(`<div class="pf-note tone-bad"><b>${__("Sem tarifa (não facturados)")}:</b> ${c.sem_tarifa.map(esc).join(", ")}
				— ${__("defina a Faturação por Regime no contrato.")}</div>`);
		}
		if (c.estado === "cancelado") {
			blocos.push(`<div class="pf-note tone-muted">${__(
				"A factura automática deste mês foi cancelada e não será recriada automaticamente. Use <b>Faturar</b> para refacturar à mão.")}</div>`);
		}
		if (c.estado === "em_falta") {
			blocos.push(`<div class="pf-note tone-bad">${__(
				"O mês de execução automática já passou sem factura — facture manualmente.")}</div>`);
		}
		if ((c.extras || []).length) {
			blocos.push(`<div class="pf-note"><b>${__("Facturas extra do mês")}</b>
				<span class="pf-muted">(${__("não contam como a factura do mês")})</span>:
				${c.extras.map((f) => `<a href="/app/sales-invoice/${encodeURIComponent(f.name)}">${esc(f.name)}</a>
					${_pf_money(f.net_total)}${f.docstatus === 0 ? ` <span class="pf-muted">(${__("rascunho")})</span>` : ""}`).join(" · ")}</div>`);
		}
		if (c.run && c.run.registo) {
			blocos.push(`<div class="pf-note tone-muted"><b>${__("Execução automática")}</b>
				(<a href="/app/faturacao-mensal/${encodeURIComponent(c.run.name)}">${esc(c.run.name)}</a>):
				<pre>${esc(c.run.registo)}</pre></div>`);
		}

		const linhas = c.linhas.length ? `
			<table class="pf-lines">
				<thead><tr>
					<th>${__("Descrição")}</th><th>${__("Contrato")}</th><th>${__("Método")}</th>
					<th class="pf-num">${__("Qtd")}</th><th class="pf-num">${__("Contratado")}</th>
					<th class="pf-num">${__("Tarifa")}</th><th class="pf-num">${__("Total")}</th>
				</tr></thead>
				<tbody>${c.linhas.map((l) => `
					<tr class="${!l.quantidade || !l.valor_unitario ? "is-muted" : ""}">
						<td>${esc(l.descricao || l.regime)}</td>
						<td><a href="/app/project/${encodeURIComponent(l.project)}">${esc(l.project)}</a></td>
						<td>${esc(l.metodo)}</td>
						<td class="pf-num">${l.quantidade}</td>
						<td class="pf-num">${l.quantidade_contratada || "—"}</td>
						<td class="pf-num">${l.valor_unitario ? _pf_money(l.valor_unitario) : `<span class="pf-tone-bad">${__("sem tarifa")}</span>`}</td>
						<td class="pf-num">${_pf_money(l.total)}</td>
					</tr>`).join("")}
				</tbody>
			</table>` : `<div class="pf-msg pf-msg-sm">${__("Sem contratos com vigilantes e tarifa.")}</div>`;
		return `<div class="pf-detail-in">${blocos.join("")}${linhas}</div>`;
	}

	// ─────────────────────────────────────────────────────────────── actions
	_editar_agenda(cliente) {
		const c = (this.data.clientes || []).find((x) => x.cliente === cliente);
		if (!c) return;
		const ag = c.agenda;
		const d = new frappe.ui.Dialog({
			title: __("Agenda de Faturação — {0}", [c.nome]),
			fields: [
				{ fieldname: "automatica", fieldtype: "Check", label: __("Faturação Automática"), default: ag.opt_in ? 1 : 0,
					description: this.data.automatica_geral ? "" :
						__("A Faturação Automática está desligada nas Definições SIGOS — a agenda fica guardada mas não corre.") },
				{ fieldname: "dia", fieldtype: "Int", label: __("Dia de Faturação"), default: ag.dia_proprio ? ag.dia : 0,
					depends_on: "eval:doc.automatica",
					description: __("1–31; 0 = padrão das Definições SIGOS. Num mês mais curto usa-se o último dia.") },
				{ fieldname: "mes_faturado", fieldtype: "Select", label: __("Mês Facturado"),
					options: ["Predefinido", "Mês Corrente", "Mês Anterior"].join("\n"),
					default: ag.mes_proprio ? ag.mes_faturado : "Predefinido", depends_on: "eval:doc.automatica",
					description: __("Mês Corrente = adiantado; Mês Anterior = vencido.") },
			],
			primary_action_label: __("Guardar"),
			primary_action: (vals) => {
				frappe.xcall("sigos.faturacao.definir_agenda_cliente", {
					cliente, automatica: vals.automatica ? 1 : 0, dia: vals.dia || 0,
					mes_faturado: vals.mes_faturado || "Predefinido",
				}).then(() => {
					d.hide();
					frappe.show_alert({ message: __("Agenda guardada."), indicator: "green" }, 4);
					this._load();
				});
			},
		});
		d.show();
	}

	_fatura_extra(cliente) {
		// A plain invoice: no SIGOS stamp, so the double-billing guard ignores it.
		frappe.new_doc("Sales Invoice", { customer: cliente, company: this.data.company || undefined });
	}

	_faturar(cliente) {
		const c = (this.data.clientes || []).find((x) => x.cliente === cliente);
		frappe.confirm(
			__("Preparar a facturação de <b>{0}</b> para {1}? Abre a Faturação Mensal pré-visualizada para revisão antes de gerar.",
				[frappe.utils.escape_html(c ? c.nome : cliente), `${__(PF_MESES[this.mes.getMonth()])} ${this.mes.getFullYear()}`]),
			() => {
				frappe.call({
					method: "sigos.sigos_setup.doctype.faturacao_mensal.faturacao_mensal.faturar_cliente",
					args: { cliente, mes_referencia: this._mes_str() },
					freeze: true,
					freeze_message: __("A calcular a facturação…"),
				}).then((r) => { if (r.message) frappe.set_route("Form", "Faturacao Mensal", r.message); });
			},
		);
	}

	_executar() {
		frappe.confirm(
			__("Executar agora a faturação automática de hoje? Factura os clientes cujo dia já chegou e ainda não têm factura; corre em segundo plano e notifica no fim."),
			() => frappe.xcall("sigos.faturacao.executar_faturacao_automatica_agora").then(() => {
				frappe.show_alert({ message: __("Faturação automática em execução — recebe uma notificação no fim."), indicator: "blue" }, 6);
			}),
		);
	}

	// ─────────────────────────────────────────────────────────── fonts/css
	_inject_fonts() {
		if (document.getElementById("as-fonts")) return;
		const l = document.createElement("link");
		l.id = "as-fonts"; l.rel = "stylesheet";
		l.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";
		document.head.appendChild(l);
	}

	_inject_css() {
		if (document.getElementById("pf-css")) return;
		const css = `
/* SIGOS Previsao de Faturacao - Operations Daylight. ASCII-only. */
.sigos-pf { background:#F4F6FA; }
.layout-main-section-wrapper:has(.sigos-pf), .page-body:has(.sigos-pf) { background:#F4F6FA; }
.sigos-pf .page-head, .sigos-pf + .page-head { display:none; }
.pf-root {
  --paper:#F4F6FA; --paper2:#FFFFFF; --paper3:#EEF1F6; --ink:#0E1726; --ink2:#5B6B82;
  --ink3:#93A1B5; --line:#E6EAF2; --line2:#D5DCE8; --accent:#4F46E5; --accentInk:#4338CA;
  --wash:rgba(79,70,229,.07); --good:#16A34A; --bad:#E5484D; --amber:#B7791F; --amberDot:#F59E0B; --info:#2F6FED;
  --graphite:#64748B; --goodWash:rgba(22,163,74,.10); --badWash:rgba(229,72,77,.09);
  --amberWash:rgba(245,158,11,.13); --infoWash:rgba(47,111,237,.09);
  --display:'Space Grotesk',system-ui,sans-serif; --body:'Inter',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
  --shadow:0 1px 2px rgba(16,23,38,.04), 0 14px 34px -20px rgba(16,23,38,.22);
  --r:14px;
  position:relative; max-width:1360px; margin:0 auto; padding:8px 14px 80px;
  color:var(--ink); font-family:var(--body); font-size:13px; font-feature-settings:"tnum" 1; -webkit-font-smoothing:antialiased;
}
.pf-root * { box-sizing:border-box; }

.pf-mast { display:flex; justify-content:space-between; align-items:center; padding:18px 4px 16px; gap:16px; flex-wrap:wrap; }
.pf-mast-l { display:flex; align-items:center; gap:14px; }
.pf-mast-r { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.pf-mark { width:40px; height:40px; border-radius:12px; display:grid; place-items:center; flex:none; color:#fff;
  background:linear-gradient(150deg,var(--accent),var(--accentInk)); box-shadow:0 6px 16px -6px rgba(79,70,229,.6); }
.pf-mark svg { width:19px; height:19px; }
.pf-up { text-transform:uppercase; letter-spacing:.12em; font-size:10px; color:var(--ink3); font-weight:600; margin-bottom:2px; }
.pf-h1 { font-family:var(--display); font-weight:600; font-size:24px; line-height:1.1; letter-spacing:-.02em; margin:0; color:var(--ink); }

.pf-month { display:flex; align-items:center; gap:2px; background:var(--paper2); border:1px solid var(--line2); border-radius:10px; padding:2px; }
.pf-month-lbl { font-family:var(--display); font-weight:600; font-size:13.5px; min-width:132px; text-align:center; }
.pf-icon-btn { border:0; background:transparent; width:30px; height:30px; border-radius:8px; font-size:18px; line-height:1; color:var(--ink2); cursor:pointer; }
.pf-icon-btn:hover { background:var(--wash); color:var(--accent); }

.pf-pill { display:inline-flex; align-items:center; gap:7px; font-size:11.5px; font-weight:600; padding:6px 11px; border-radius:999px; cursor:pointer; border:1px solid var(--line2); background:var(--paper2); color:var(--ink2); }
.pf-pill i { width:7px; height:7px; border-radius:50%; background:var(--ink3); }
.pf-pill.tone-good { color:var(--good); border-color:rgba(22,163,74,.3); background:var(--goodWash); }
.pf-pill.tone-good i { background:var(--good); }

.pf-banner { border-radius:12px; padding:11px 14px; margin-bottom:12px; font-size:12.5px; border:1px solid var(--line); background:var(--paper2); }
.pf-banner ul { margin:6px 0 0; padding-left:18px; }
.pf-banner summary { cursor:pointer; }
.pf-banner.tone-bad { border-color:rgba(229,72,77,.35); background:var(--badWash); }
.pf-banner.tone-amber { border-color:rgba(245,158,11,.4); background:var(--amberWash); }
.pf-banner.tone-info { border-color:rgba(47,111,237,.3); background:var(--infoWash); }

.pf-kpis { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; margin-bottom:16px; }
.pf-kpi { background:var(--paper2); border:1px solid var(--line); border-radius:12px; padding:13px 15px; display:flex; flex-direction:column; gap:4px; min-width:0; box-shadow:var(--shadow); }
.pf-kpi[data-kpi] { cursor:pointer; }
.pf-kpi[data-kpi]:hover, .pf-kpi.is-active { border-color:var(--accent); }
.pf-kpi.is-active { background:var(--wash); }
.pf-kpi-lbl { font-size:9.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink3); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pf-kpi-val { font-family:var(--display); font-weight:600; font-size:22px; line-height:1.15; letter-spacing:-.02em; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pf-kpi-sub { font-size:11px; color:var(--ink3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pf-kpi.tone-good .pf-kpi-val { color:var(--good); }
.pf-kpi.tone-accent .pf-kpi-val { color:var(--accentInk); }
.pf-kpi.tone-info .pf-kpi-val { color:var(--info); }
.pf-kpi.tone-bad .pf-kpi-val { color:var(--bad); }

.pf-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:10px; background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); padding:10px 12px; margin-bottom:16px; }
.pf-search { display:flex; align-items:center; gap:8px; background:var(--paper3); border:1px solid var(--line2); border-radius:10px; padding:0 12px; height:34px; min-width:220px; flex:0 1 300px; }
.pf-search svg { width:14px; height:14px; color:var(--ink3); flex:none; }
.pf-search input { border:0; background:transparent; outline:0; font-family:var(--body); font-size:12.5px; color:var(--ink); width:100%; }
.pf-chips { display:flex; flex-wrap:wrap; gap:6px; }
.pf-chip { display:inline-flex; align-items:center; gap:6px; height:30px; padding:0 11px; border-radius:999px; border:1px solid var(--line2); background:var(--paper2); color:var(--ink2); font-family:var(--body); font-size:12px; font-weight:500; cursor:pointer; }
.pf-chip b { font-weight:700; color:var(--ink); font-family:var(--mono); font-size:11px; }
.pf-chip:hover { border-color:var(--accent); }
.pf-chip.is-active { border-color:var(--accent); background:var(--wash); color:var(--accentInk); }
.pf-dot { width:7px; height:7px; border-radius:50%; background:var(--ink3); display:inline-block; }

.pf-table-wrap { background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); overflow-x:auto; }
.pf-msg { padding:40px 12px; text-align:center; color:var(--ink3); font-size:12.5px; font-style:italic; }
.pf-msg-sm { padding:14px; }
.pf-table { width:100%; border-collapse:collapse; font-size:12.5px; min-width:980px; }
.pf-table > thead th { text-align:left; font-size:9.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink3); font-weight:700; padding:10px; border-bottom:1px solid var(--line); white-space:nowrap; }
.pf-table > tbody > tr.pf-row > td { padding:10px; border-bottom:1px solid var(--line); color:var(--ink); white-space:nowrap; vertical-align:middle; }
.pf-row { cursor:pointer; }
.pf-row:hover > td, .pf-row.is-open > td { background:var(--paper3); }
.pf-table a { color:var(--accent); text-decoration:none; font-weight:600; }
.pf-table a:hover { text-decoration:underline; }
.pf-name { margin-right:6px; }
.pf-num { font-family:var(--mono); font-feature-settings:"tnum" 1; text-align:right; }
.pf-table th.pf-num, .pf-lines th.pf-num { text-align:right; }
.pf-strong { font-weight:500; color:var(--ink); }
.pf-caret-col { width:28px; padding-right:0 !important; }
.pf-caret { display:inline-grid; place-items:center; width:18px; height:18px; color:var(--ink3); transition:transform .15s; }
.pf-caret svg { width:12px; height:12px; }
.pf-row.is-open .pf-caret { transform:rotate(90deg); color:var(--accent); }
.pf-act-col { text-align:right; }

.pf-status { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:600; padding:3px 9px; border-radius:999px; background:var(--paper3); color:var(--graphite); }
.pf-status i, .pf-dot { width:7px; height:7px; border-radius:50%; background:var(--ink3); }
.tone-good.pf-status { background:var(--goodWash); color:var(--good); }
.tone-info.pf-status { background:var(--infoWash); color:var(--info); }
.tone-amber.pf-status { background:var(--amberWash); color:var(--amber); }
.tone-bad.pf-status { background:var(--badWash); color:var(--bad); }
.tone-neu.pf-status { background:var(--paper3); color:var(--ink2); }
.pf-status.tone-good i, .pf-dot.tone-good { background:var(--good); }
.pf-status.tone-info i, .pf-dot.tone-info { background:var(--info); }
.pf-status.tone-amber i, .pf-dot.tone-amber { background:var(--amberDot); }
.pf-status.tone-bad i, .pf-dot.tone-bad { background:var(--bad); }
.pf-status.tone-neu i, .pf-dot.tone-neu { background:var(--ink2); }

.pf-badge { font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; border-radius:6px; padding:2px 6px; margin-left:2px; }
.pf-badge.tone-bad { color:var(--bad); background:var(--badWash); }
.pf-badge.tone-amber { color:var(--amber); background:var(--amberWash); }
.pf-badge.tone-info { color:var(--info); background:var(--infoWash); }
.pf-muted { color:var(--ink3); }

.pf-agenda { border:1px dashed var(--line2); background:transparent; border-radius:8px; padding:3px 9px; font-family:var(--body); font-size:11.5px; color:var(--ink3); cursor:pointer; }
.pf-agenda.is-auto { border-style:solid; color:var(--accentInk); background:var(--wash); border-color:rgba(79,70,229,.25); }
.pf-agenda:hover { border-color:var(--accent); color:var(--accent); }

.pf-delta { font-size:11px; font-weight:600; padding:2px 7px; border-radius:6px; }
.pf-delta.up { color:var(--good); background:var(--goodWash); }
.pf-delta.down { color:var(--bad); background:var(--badWash); }
.pf-delta.flat { color:var(--ink3); background:var(--paper3); }
.pf-tone-bad { color:var(--bad); }

.pf-detail > td { padding:0 !important; border-bottom:1px solid var(--line); background:var(--paper); }
.pf-detail-in { padding:12px 16px 16px 40px; display:flex; flex-direction:column; gap:10px; }
.pf-note { font-size:12px; padding:8px 12px; border-radius:9px; background:var(--paper2); border:1px solid var(--line); white-space:normal; }
.pf-note.tone-bad { border-color:rgba(229,72,77,.3); background:var(--badWash); }
.pf-note pre { margin:6px 0 0; font-family:var(--mono); font-size:11px; white-space:pre-wrap; background:transparent; border:0; padding:0; color:var(--ink2); }
.pf-lines { width:100%; border-collapse:collapse; font-size:12px; background:var(--paper2); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
.pf-lines th { text-align:left; font-size:9px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink3); font-weight:700; padding:8px 10px; border-bottom:1px solid var(--line); }
.pf-lines td { padding:7px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
.pf-lines tr:last-child td { border-bottom:0; }
.pf-lines tr.is-muted td { color:var(--ink3); }

.pf-btn { font-family:var(--body); font-size:12px; font-weight:600; border:1px solid var(--accent); background:var(--accent); color:#fff; padding:8px 14px; border-radius:9px; cursor:pointer; }
.pf-btn:hover { background:var(--accentInk); border-color:var(--accentInk); }
.pf-btn-sm { padding:5px 11px; font-size:11.5px; }
.pf-btn-ghost { background:var(--paper2); color:var(--accentInk); border-color:var(--line2); }
.pf-btn-ghost:hover { background:var(--wash); border-color:var(--accent); color:var(--accentInk); }

@media (max-width: 1180px) { .pf-kpis { grid-template-columns:repeat(3,1fr); } }
@media (max-width: 760px) {
  .pf-kpis { grid-template-columns:repeat(2,1fr); }
  .pf-root { padding:8px 4px 60px; }
  .pf-search { flex:1 1 100%; }
}
`;
		const s = document.createElement("style");
		s.id = "pf-css";
		s.textContent = css;
		document.head.appendChild(s);
	}
};

// ─────────────────────────────────────────────────────────────── helpers
function _pf_money(v) {
	return format_currency(v || 0, frappe.defaults.get_default("currency"));
}
function _pf_dia(d) {
	if (!d) return "";
	const o = frappe.datetime.str_to_obj(d);
	return `${o.getDate()} ${__(PF_MESES_CURTOS[o.getMonth()])}`;
}
function _pf_delta(atual, anterior) {
	if (!anterior) return `<span class="pf-delta flat">—</span>`;
	const p = ((atual - anterior) / anterior) * 100;
	if (Math.abs(p) < 0.5) return `<span class="pf-delta flat">=</span>`;
	const cls = p > 0 ? "up" : "down";
	return `<span class="pf-delta ${cls}" title="${__("Mês anterior")}: ${_pf_money(anterior)}">${p > 0 ? "+" : ""}${p.toFixed(1)}%</span>`;
}
function _pf_icon_search() {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;
}
function _pf_icon_caret() {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 6 15 12 9 18"></polyline></svg>`;
}
function _pf_icon_invoice() {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"></path><line x1="9" y1="8" x2="15" y2="8"></line><line x1="9" y1="12" x2="15" y2="12"></line><line x1="9" y1="16" x2="12" y2="16"></line></svg>`;
}
