// SIGOS - Painel Geral. Port of the old SIXS "Central de Operacoes" page onto the
// SIGOS backend (sigos.painel_geral). "Operations Daylight" look, light-only.
// Charts via ApexCharts (loaded on demand from jsDelivr), like the original page.
frappe.provide("sigos");

frappe.pages["painel-geral"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({ parent: wrapper, title: __("Painel Geral"), single_column: true });
	wrapper.painel_geral = new sigos.PainelGeral(page);
};
frappe.pages["painel-geral"].on_page_show = function (wrapper) {
	if (wrapper.painel_geral) wrapper.painel_geral.on_show();
};

// Period presets - shared across chart configs
const PG_P = {
	weekly:  [{ l: "12 sem", a: { n: 12 } }, { l: "26 sem", a: { n: 26 } }, { l: "1 ano", a: { n: 52 } }],
	monthly: [{ l: "6m", a: { n: 6 } }, { l: "12m", a: { n: 12 } }, { l: "2 anos", a: { n: 24 } }],
	faltas:  [{ l: "1m", a: { n: 1 } }, { l: "3m", a: { n: 3 } }, { l: "6m", a: { n: 6 } }, { l: "1 ano", a: { n: 12 } }],
};

sigos.PainelGeral = class PainelGeral {
	constructor(page) {
		this.page = page;
		this.$b = $(page.body);
		this.charts = {};
		this.PAGE_SIZE = 20;
		this.MIN_FALTAS = 8;
		this._ready = false;
		this.C = {
			accent: "#4F46E5", info: "#2F6FED", good: "#16A34A", bad: "#E5484D", amber: "#F59E0B",
			teal: "#0EA5A3", violet: "#8B5CF6", graphite: "#64748B", ink: "#0E1726", ink3: "#93A1B5", line: "#E6EAF2",
			palette: ["#4F46E5", "#2F6FED", "#0EA5A3", "#F59E0B", "#8B5CF6", "#E5484D", "#16A34A", "#64748B", "#EC4899", "#0891B2"],
		};
		this._fmt = (n) => (Number(n) || 0).toLocaleString("pt-PT");

		// Searchable drawers under the "por cliente" / faltas charts
		this._ob = {
			"vig-cliente": { open: false, offset: 0, search: "", total: 0, debounce: null },
			"rot-cliente": { open: false, offset: 0, search: "", total: 0, debounce: null },
			"faltas":      { open: false, page: 0, search: "", all_data: [] },
		};
		// Period filter state (n = days / weeks / months depending on the chart)
		this._pf = {
			"pg-ch-dem-sem":   { n: 12 },
			"pg-ch-rot-sem":   { n: 12 },
			"pg-ch-rot-mes":   { n: 12 },
			"rot-cliente":     { n: 6 },
			"pg-ch-aus-sem":   { n: 12 },
			"pg-ch-aus-mes":   { n: 12 },
			"pg-ch-admitidos": { n: 12 },
			"faltas":          { n: 6 },
		};
		// Daily charts: a 90-day buffer browsed through a sliding window
		this._nav = {
			"pg-ch-dem-dia": { all_data: null, window: 7, offset: 0, color: this.C.bad },
			"pg-ch-rot-dia": { all_data: null, window: 7, offset: 0, color: this.C.accent },
		};
		// Status filter state
		this._sf = { "vig-cliente": "Activo", "faltas": "Activo", "pg-ch-superv": "Activo" };

		this._inject_fonts();
		this._inject_css();
		this._render();
		this._build_loaders();
		this._bind_events();
		this._load_apexcharts().then(() => {
			this._ready = true;
			this.refresh();
		}).catch(() => frappe.msgprint(__("Não foi possível carregar a biblioteca de gráficos (ApexCharts).")));
	}

	_load_apexcharts() {
		if (window.ApexCharts) return Promise.resolve();
		return new Promise((res, rej) => {
			const s = document.createElement("script");
			s.src = "https://cdn.jsdelivr.net/npm/apexcharts@3.46.0/dist/apexcharts.min.js";
			s.onload = res; s.onerror = rej;
			document.head.appendChild(s);
		});
	}

	on_show() {
		if (!this._ready) return;
		Object.keys(this.charts).forEach((k) => this._destroy(k));
		this.refresh();
	}

	// ============================================================ DATA
	_call(method, args) {
		return frappe.call({ method: `sigos.painel_geral.${method}`, args: args || {} }).then((r) => r.message || {});
	}

	_serie(fonte, granularidade, n) {
		return this._call("get_serie", { fonte, granularidade, n });
	}

	_build_loaders() {
		const nav_load = (id, fonte) => () => this._serie(fonte, "diaria", 90).then((d) => {
			this._nav[id].all_data = d;
			this._nav[id].offset = 0;
			this._nav_render(id);
		});
		this._loaders = {
			"pg-ch-dem-dia": nav_load("pg-ch-dem-dia", "demissoes"),
			"pg-ch-dem-sem": () => this._serie("demissoes", "semanal", this._pf["pg-ch-dem-sem"].n)
				.then((d) => this._bar("pg-ch-dem-sem", d, this.C.bad)),

			"pg-ch-rot-dia": nav_load("pg-ch-rot-dia", "rotatividades"),
			"pg-ch-rot-sem": () => this._serie("rotatividades", "semanal", this._pf["pg-ch-rot-sem"].n)
				.then((d) => this._line("pg-ch-rot-sem", d, this.C.accent)),
			"pg-ch-rot-mes": () => this._serie("rotatividades", "mensal", this._pf["pg-ch-rot-mes"].n)
				.then((d) => this._bar("pg-ch-rot-mes", d, this.C.accent, 300)),

			"rot-cliente": () => this._call("get_rotatividades_por_cliente", { months: this._pf["rot-cliente"].n }).then((d) => {
				this._stacked_bar("pg-ch-rot-cliente", d, 320);
				this._ob_set_badge("rot-cliente", d.total_clients, "clientes");
				if (this._ob["rot-cliente"].open) this._ob_load_server("rot-cliente", true);
			}),

			"pg-ch-aus-sem": () => this._serie("ausencias", "semanal", this._pf["pg-ch-aus-sem"].n)
				.then((d) => this._bar("pg-ch-aus-sem", d, this.C.info, 280)),
			"pg-ch-aus-mes": () => this._serie("ausencias", "mensal", this._pf["pg-ch-aus-mes"].n)
				.then((d) => this._bar("pg-ch-aus-mes", d, this.C.info, 280)),

			"pg-ch-admitidos": () => this._call("get_admitidos_demitidos", { months: this._pf["pg-ch-admitidos"].n })
				.then((d) => this._dual_bar("pg-ch-admitidos", d, 300)),

			"vig-cliente": () => this._call("get_vigilantes_por_cliente", { status: this._sf["vig-cliente"], limit: 10 }).then((d) => {
				this._hbar("pg-ch-vig-cliente", {
					labels: (d.rows || []).map((r) => r.nome),
					values: (d.rows || []).map((r) => r.total),
				}, this.C.accent, 280);
				this._ob_set_badge("vig-cliente", d.total_clients, "clientes");
				if (this._ob["vig-cliente"].open) this._ob_load_server("vig-cliente", true);
			}),

			"pg-ch-armas": () => this._call("get_armas_por_delegacao").then((d) => this._hbar("pg-ch-armas", d, this.C.graphite)),
			"pg-ch-reservas": () => this._call("get_reservas_por_delegacao").then((d) => this._hbar("pg-ch-reservas", d, this.C.teal)),
			"pg-ch-superv": () => this._call("get_supervisores_por_delegacao", { status: this._sf["pg-ch-superv"] })
				.then((d) => this._hbar("pg-ch-superv", d, this.C.info)),
			"pg-ch-feriadores": () => this._call("get_feriadores_por_delegacao").then((d) => this._hbar("pg-ch-feriadores", d, this.C.violet)),

			"faltas": () => this._call("get_vigilantes_muitas_faltas", {
				min_faltas: this.MIN_FALTAS, status: this._sf["faltas"], months: this._pf["faltas"].n,
			}).then((d) => this._ob_init_faltas(Array.isArray(d) ? d : [])),
		};
	}

	refresh() {
		if (!this._ready) return;
		this.$b.find(".pg-stamp").text(__("A actualizar..."));
		const jobs = [
			this._call("get_cards_summary").then((d) => this._render_cards(d)),
			this._call("get_users_ativos").then((d) => this._render_users(d)),
			...Object.values(this._loaders).map((fn) => fn().catch(() => {})),
		];
		Promise.all(jobs).finally(() => {
			const t = frappe.datetime.now_datetime().split(" ")[1].slice(0, 5);
			this.$b.find(".pg-stamp").text(__("Actualizado") + " " + t);
		});
	}

	// ============================================================ LAYOUT
	_render() {
		this.page.main.addClass("sigos-pg");
		const d = new Date();
		const dias = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
		const meses = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
		const hoje = `${dias[d.getDay()]}, ${d.getDate()} ${meses[d.getMonth()]} ${d.getFullYear()}`;

		this.$b.html(`
<div class="pg-root">
  <header class="pg-mast">
    <div class="pg-mast-l">
      <div class="pg-mark">S</div>
      <div>
        <div class="pg-up">${__("Central de Operações")}</div>
        <h1 class="pg-h1">${__("Painel Geral")}</h1>
        <div class="pg-date">${hoje}</div>
      </div>
    </div>
    <div class="pg-mast-r">
      <span class="pg-pulse"><i></i><span class="pg-stamp">${__("A carregar...")}</span></span>
      <button class="pg-btn pg-refresh">${__("Actualizar")}</button>
    </div>
  </header>

  ${this._sec("Resumo Operacional", "Efectivo e postos")}
  <div class="pg-kpi-grid" id="pg-kpis">
    ${this._kpi("clientes", "Clientes", "accent")}
    ${this._kpi("activos", "Vigilantes Activos", "accent")}
    ${this._kpi("mulheres", "Mulheres", "violet")}
    ${this._kpi("homens", "Homens", "info")}
    ${this._kpi("armados", "Armados", "graphite")}
    ${this._kpi("simples", "Não Armados", "graphite")}
    ${this._kpi("reservas", "Em Reserva", "teal")}
    ${this._kpi("supervisores", "Supervisores", "info")}
    ${this._kpi("administrativos", "Administrativos", "graphite")}
    ${this._kpi("postos", "Postos de Vigilância", "accent")}
    ${this._kpi("postos_activos", "Postos Activos", "good")}
  </div>

  ${this._sec("Demissões", "Saídas submetidas")}
  <div class="pg-row2">
    ${this._chart_card("pg-ch-dem-dia", "Demissões Diárias", "Navegar pelos últimos 90 dias", 260, { navigable: true })}
    ${this._chart_card("pg-ch-dem-sem", "Demissões Semanais", "Período seleccionado", 260, { periods: PG_P.weekly })}
  </div>

  ${this._sec("Rotatividades", "Movimentos submetidos")}
  <div class="pg-row2">
    ${this._chart_card("pg-ch-rot-dia", "Rotatividades Diárias", "Navegar pelos últimos 90 dias", 260, { navigable: true })}
    ${this._chart_card("pg-ch-rot-sem", "Rotatividades Semanais", "Período seleccionado", 260, { periods: PG_P.weekly })}
  </div>
  <div class="pg-row1">
    ${this._chart_card("pg-ch-rot-mes", "Rotatividades Mensais", "Período seleccionado", 300, { periods: PG_P.monthly })}
  </div>
  <div class="pg-row1">${this._ob_card("rot-cliente", "Rotatividades por Cliente", "Top 10 clientes, por mês", "clientes",
		["#", "Cliente", { l: "Rotatividades", r: true }, "Última Data"], 320, { periods: PG_P.monthly })}</div>

  ${this._sec("Ausências", "Faltas registadas")}
  <div class="pg-row2">
    ${this._chart_card("pg-ch-aus-sem", "Ausências Semanais", "Período seleccionado", 280, { periods: PG_P.weekly })}
    ${this._chart_card("pg-ch-aus-mes", "Ausências Mensais", "Período seleccionado", 280, { periods: PG_P.monthly })}
  </div>

  ${this._sec("Distribuição", "Clientes e delegações")}
  <div class="pg-row1">${this._ob_card("vig-cliente", "Vigilantes por Cliente", "Top 10", "clientes",
		["#", "Cliente", { l: "Vigilantes", r: true }, { l: "% do Total", r: true }], 280, { status: true })}</div>
  <div class="pg-row2">
    ${this._chart_card("pg-ch-armas", "Armas por Delegação", "Total registado")}
    ${this._chart_card("pg-ch-reservas", "Reservas por Delegação", "Vigilantes em reserva")}
  </div>
  <div class="pg-row1">
    ${this._chart_card("pg-ch-admitidos", "Admitidos vs Demitidos", "Período seleccionado", 300, { periods: PG_P.monthly })}
  </div>
  <div class="pg-row2">
    ${this._chart_card("pg-ch-superv", "Supervisores por Delegação", "Estado seleccionado", 260, { status: true })}
    ${this._chart_card("pg-ch-feriadores", "De Férias / Licença Hoje", "Licenças aprovadas, por delegação")}
  </div>

  ${this._sec("Alertas & Relatórios", "Requer atenção", true)}
  <div class="pg-row1">${this._ob_card("faltas", `Vigilantes com ${this.MIN_FALTAS} ou mais Faltas`, "Período seleccionado", "vigilantes",
		["#", "Vigilante", "Nome", "Posto", "Delegação", { l: "Faltas", r: true }], 260, { status: true, periods: PG_P.faltas, csv: true })}</div>

  <div class="pg-card pg-users" id="pg-users-card">
    <div class="pg-card-head">
      <div><h3 class="pg-card-title">${__("Utilizadores Activos no Sistema")}</h3><p class="pg-card-sub">${__("Último acesso em dias")}</p></div>
      <span class="pg-badge" id="pg-count-users">-</span>
    </div>
    <div class="pg-table-scroll">
      <table class="pg-table">
        <thead><tr><th>${__("Utilizador")}</th><th>${__("Nome")}</th><th>${__("Último Acesso")}</th><th class="pg-r">${__("Dias")}</th></tr></thead>
        <tbody id="pg-tbody-users">${this._skeleton(4)}</tbody>
      </table>
    </div>
  </div>
</div>`);
	}

	_sec(title, sub, alert) {
		return `<div class="pg-sec${alert ? " pg-sec--alert" : ""}"><span class="pg-sec-bar"></span>
			<h2>${__(title)}</h2><span class="pg-sec-sub">${__(sub)}</span><span class="pg-sec-line"></span></div>`;
	}

	_kpi(id, label, tone) {
		return `<div class="pg-kpi pg-tone-${tone}" data-kpi="${id}">
  <div class="pg-kpi-label">${__(label)}</div>
  <div class="pg-kpi-value pg-num" id="pg-kpi-${id}">-</div>
  <div class="pg-kpi-bar"><i id="pg-kpi-${id}-bar"></i></div>
</div>`;
	}

	_skeleton(cols) {
		return `<tr><td colspan="${cols}" class="pg-skel-cell"><div class="pg-skel"></div></td></tr>`;
	}

	_chart_card(id, title, sub, height = 260, opts = {}) {
		let right = "";
		if (opts.navigable) right = this._nav_window_pills(id);
		else right = (opts.status ? this._status_pills(id) : "") + (opts.periods ? this._period_pills(id, opts.periods) : "");
		return `
<div class="pg-card">
  <div class="pg-card-head">
    <div><h3 class="pg-card-title">${__(title)}</h3><p class="pg-card-sub">${__(sub)}</p></div>
    ${right ? `<div class="pg-filters">${right}</div>` : ""}
  </div>
  ${opts.navigable ? this._nav_bar(id) : ""}
  <div id="${id}" class="pg-chart" style="min-height:${height}px"></div>
</div>`;
	}

	_period_pills(target, options) {
		const cur = this._pf[target] || {};
		return `<div class="pg-seg">${options.map((o) =>
			`<button class="pg-pf-btn${o.a.n === cur.n ? " is-on" : ""}" data-target="${target}" data-n="${o.a.n}">${o.l}</button>`
		).join("")}</div>`;
	}

	_status_pills(target) {
		const cur = this._sf[target];
		const opts = [{ l: "Activos", v: "Activo" }, { l: "Inactivos", v: "Inactivo" }, { l: "Todos", v: "Todos" }];
		return `<div class="pg-seg">${opts.map((o) =>
			`<button class="pg-sf-btn${o.v === cur ? " is-on" : ""}" data-target="${target}" data-status="${o.v}">${__(o.l)}</button>`
		).join("")}</div>`;
	}

	_nav_window_pills(id) {
		const cur = this._nav[id].window;
		return `<div class="pg-seg">${[7, 14, 30].map((w) =>
			`<button class="pg-nw-btn${w === cur ? " is-on" : ""}" data-chart="${id}" data-window="${w}">${w}d</button>`
		).join("")}</div>`;
	}

	_nav_bar(id) {
		const chev = (pts) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="${pts}"/></svg>`;
		return `<div class="pg-nav">
  <button class="pg-nav-btn pg-nav-prev" data-chart="${id}" disabled title="${__("Período anterior")}">${chev("15 18 9 12 15 6")}</button>
  <span class="pg-nav-range pg-num" id="pg-nav-range-${id}">-</span>
  <button class="pg-nav-btn pg-nav-next" data-chart="${id}" disabled title="${__("Período seguinte")}">${chev("9 18 15 12 9 6")}</button>
</div>`;
	}

	_ob_card(id, title, sub, unit, headers, height, opts = {}) {
		const th = headers.map((h) => typeof h === "string"
			? `<th>${__(h)}</th>` : `<th class="pg-r">${__(h.l)}</th>`).join("");
		const filters = (opts.status ? this._status_pills(id) : "") + (opts.periods ? this._period_pills(id, opts.periods) : "");
		return `
<div class="pg-card pg-ob" data-unit="${unit}">
  <div class="pg-card-head">
    <div><h3 class="pg-card-title">${__(title)}</h3><p class="pg-card-sub">${__(sub)}</p></div>
    <div class="pg-ob-head-r">
      ${filters ? `<div class="pg-filters">${filters}</div>` : ""}
      <span class="pg-badge" id="pg-ob-${id}-badge">-</span>
      ${opts.csv ? `<button class="pg-btn pg-btn-sm" id="pg-ob-${id}-export">CSV</button>` : ""}
    </div>
  </div>
  <div id="pg-ch-${id}" class="pg-chart" style="min-height:${height}px"></div>
  <button class="pg-ob-toggle" data-ob="${id}">
    <span class="pg-ob-toggle-label">${__("Ver todos os")} ${__(unit)}</span>
    <svg class="pg-ob-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
  </button>
  <div class="pg-ob-drawer" id="pg-ob-${id}-drawer">
    <div class="pg-ob-search">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input type="text" class="pg-ob-input" data-ob="${id}" placeholder="${__("Filtrar")} ${__(unit)}...">
    </div>
    <div class="pg-table-scroll">
      <table class="pg-table"><thead><tr>${th}</tr></thead>
        <tbody id="pg-ob-${id}-tbody">${this._skeleton(headers.length)}</tbody></table>
    </div>
    <div class="pg-ob-foot">
      <span class="pg-count" id="pg-ob-${id}-count">-</span>
      <button class="pg-btn pg-btn-sm" id="pg-ob-${id}-more" style="display:none">${__("Carregar mais")}</button>
    </div>
  </div>
</div>`;
	}

	// ============================================================ EVENTS
	_bind_events() {
		const $b = this.$b;
		$b.on("click", ".pg-refresh", () => this.refresh());

		$b.on("click", ".pg-nw-btn", (e) => {
			const btn = $(e.currentTarget), id = btn.data("chart");
			btn.siblings().removeClass("is-on"); btn.addClass("is-on");
			this._nav[id].window = parseInt(btn.data("window"));
			this._nav[id].offset = 0;
			this._nav_render(id);
		});
		$b.on("click", ".pg-nav-prev", (e) => {
			const nav = this._nav[$(e.currentTarget).data("chart")];
			if (!nav || !nav.all_data) return;
			const max = Math.ceil(nav.all_data.labels.length / nav.window) - 1;
			if (nav.offset < max) { nav.offset++; this._nav_render($(e.currentTarget).data("chart")); }
		});
		$b.on("click", ".pg-nav-next", (e) => {
			const id = $(e.currentTarget).data("chart"), nav = this._nav[id];
			if (nav && nav.offset > 0) { nav.offset--; this._nav_render(id); }
		});

		$b.on("click", ".pg-pf-btn", (e) => {
			const btn = $(e.currentTarget), target = btn.data("target");
			btn.siblings().removeClass("is-on"); btn.addClass("is-on");
			this._pf[target] = { n: parseInt(btn.data("n")) };
			this._loaders[target] && this._loaders[target]();
		});
		$b.on("click", ".pg-sf-btn", (e) => {
			const btn = $(e.currentTarget), target = btn.data("target");
			btn.siblings().removeClass("is-on"); btn.addClass("is-on");
			this._sf[target] = btn.data("status");
			this._loaders[target] && this._loaders[target]();
		});

		$b.on("click", ".pg-ob-toggle", (e) => this._ob_toggle($(e.currentTarget).data("ob")));
		$b.on("input", ".pg-ob-input", (e) => {
			const id = $(e.currentTarget).data("ob"), st = this._ob[id];
			st.search = e.currentTarget.value;
			if (id === "faltas") { this._ob_render_faltas(true); return; }
			clearTimeout(st.debounce);
			st.debounce = setTimeout(() => this._ob_load_server(id, true), 320);
		});
		$b.on("click", "#pg-ob-vig-cliente-more", () => this._ob_load_server("vig-cliente", false));
		$b.on("click", "#pg-ob-rot-cliente-more", () => this._ob_load_server("rot-cliente", false));
		$b.on("click", "#pg-ob-faltas-more", () => { this._ob.faltas.page++; this._ob_render_faltas(false); });
		$b.on("click", "#pg-ob-faltas-export", () => this._export_faltas());
	}

	// ============================================================ CARDS
	_render_cards(d) {
		if (!d) return;
		// Regime KPIs are dynamic (one card per active regime) - rebuild them each refresh.
		this.$b.find(".pg-kpi[data-regime]").remove();
		const $grid = this.$b.find("#pg-kpis");
		(d.regimes || []).forEach((r) => {
			const id = "regime-" + frappe.scrub(r.k);
			$grid.append($(this._kpi(id, `${__("Regime")} ${frappe.utils.escape_html(r.k)}`, "amber")).attr("data-regime", r.k));
			d[id] = r.n;
		});
		const max = Math.max(1, d.activos || 0);
		Object.keys(d).forEach((k) => {
			if (k === "regimes") return;
			const ratio = ["clientes", "postos", "postos_activos", "administrativos"].includes(k)
				? 1 : Math.min(1, (d[k] || 0) / max);
			this._set_kpi(k, d[k], k === "activos" ? 1 : ratio);
		});
		if (d.postos) this._set_kpi("postos_activos", d.postos_activos, d.postos_activos / d.postos);
	}

	_set_kpi(id, value, ratio) {
		const el = this.$b.find(`#pg-kpi-${id}`)[0];
		if (!el) return;
		const target = parseInt(value) || 0, dur = 700, start = Date.now();
		const tick = () => {
			const p = Math.min((Date.now() - start) / dur, 1);
			el.textContent = this._fmt(Math.round(target * (1 - Math.pow(1 - p, 3))));
			if (p < 1) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
		const bar = this.$b.find(`#pg-kpi-${id}-bar`)[0];
		if (bar) setTimeout(() => { bar.style.width = `${Math.round((ratio || 0) * 100)}%`; }, 80);
	}

	// ============================================================ DRAWERS
	_ob_toggle(id) {
		const st = this._ob[id];
		st.open = !st.open;
		const $card = this.$b.find(`#pg-ob-${id}-drawer`).closest(".pg-ob");
		$card.toggleClass("is-open", st.open);
		$card.find(".pg-ob-toggle-label").text(st.open ? __("Fechar") : `${__("Ver todos os")} ${__($card.data("unit"))}`);
		if (!st.open) return;
		if (id === "faltas") this._ob_render_faltas(true);
		else this._ob_load_server(id, true);
	}

	_ob_set_badge(id, count, unit) {
		this.$b.find(`#pg-ob-${id}-badge`).text(`${this._fmt(count)} ${__(unit)}`);
	}

	_ob_update_footer(id, loaded, total) {
		this.$b.find(`#pg-ob-${id}-count`).text(`${this._fmt(loaded)} ${__("de")} ${this._fmt(total)}`);
		const more = this.$b.find(`#pg-ob-${id}-more`);
		const rest = total - loaded;
		more.toggle(rest > 0).text(`${__("Carregar mais")} (${rest} ${__("restantes")})`);
	}

	_ob_load_server(id, reset) {
		const st = this._ob[id];
		if (reset) st.offset = 0;
		const esc = frappe.utils.escape_html;
		const method = id === "vig-cliente" ? "get_vigilantes_por_cliente" : "get_rot_por_cliente_table";
		const args = { limit: this.PAGE_SIZE, offset: st.offset, search: st.search };
		if (id === "vig-cliente") args.status = this._sf["vig-cliente"];
		else args.months = this._pf["rot-cliente"].n;
		const $tb = this.$b.find(`#pg-ob-${id}-tbody`);
		if (reset) $tb.html(this._skeleton(4));

		this._call(method, args).then((d) => {
			const rows = d.rows || [];
			const html = rows.map((r, i) => {
				const num = st.offset + i + 1;
				const cli = encodeURIComponent(r.cliente);
				if (id === "vig-cliente") {
					const st_q = this._sf["vig-cliente"] === "Todos" ? "" : `&status=${encodeURIComponent(this._sf["vig-cliente"])}`;
					return `<tr><td class="pg-muted">${num}</td>
						<td><a class="pg-link" href="/app/vigilante?cliente=${cli}${st_q}">${esc(r.nome)}</a></td>
						<td class="pg-r pg-num">${this._fmt(r.total)}</td><td class="pg-r pg-num">${r.pct}%</td></tr>`;
				}
				return `<tr><td class="pg-muted">${num}</td>
					<td><a class="pg-link" href="/app/rotatividade?cliente_antigo_posto=${cli}">${esc(r.nome)}</a></td>
					<td class="pg-r pg-num">${this._fmt(r.total)}</td>
					<td class="pg-muted">${r.ultima_data ? frappe.datetime.str_to_user(r.ultima_data) : "-"}</td></tr>`;
			}).join("");
			if (reset) $tb.html(html || `<tr><td colspan="4" class="pg-empty">${__("Sem resultados.")}</td></tr>`);
			else $tb.append(html);
			st.offset += rows.length;
			st.total = d.total || 0;
			this._ob_update_footer(id, st.offset, st.total);
		});
	}

	_ob_init_faltas(rows) {
		this._ob.faltas.all_data = rows;
		const top = rows.slice(0, 10);
		if (top.length) {
			this._hbar("pg-ch-faltas", {
				labels: top.map((r) => r.nome_completo || r.vigilante),
				values: top.map((r) => r.total_faltas),
			}, this.C.bad, 260);
		} else {
			this._empty("pg-ch-faltas", __("Nenhum vigilante acima do limite no período."));
		}
		this._ob_set_badge("faltas", rows.length, rows.length === 1 ? "vigilante" : "vigilantes");
		if (this._ob.faltas.open) this._ob_render_faltas(true);
	}

	_ob_render_faltas(reset) {
		const st = this._ob.faltas, esc = frappe.utils.escape_html;
		if (reset) st.page = 0;
		const q = (st.search || "").toLowerCase();
		const filtered = q ? st.all_data.filter((r) =>
			["nome_completo", "vigilante", "posto", "delegacao"].some((k) => (r[k] || "").toLowerCase().includes(q))
		) : st.all_data;
		const rows = filtered.slice(0, (st.page + 1) * this.PAGE_SIZE);
		this.$b.find("#pg-ob-faltas-tbody").html(rows.length ? rows.map((r, i) => `
<tr><td class="pg-muted">${i + 1}</td>
  <td><a class="pg-link pg-mono" href="/app/vigilante/${encodeURIComponent(r.vigilante)}">${esc(r.vigilante)}</a></td>
  <td>${esc(r.nome_completo || "-")}</td>
  <td>${r.posto ? `<a class="pg-link pg-mono" href="/app/posto-de-vigilancia/${encodeURIComponent(r.posto)}">${esc(r.posto)}</a>` : "-"}</td>
  <td>${esc(r.delegacao || "-")}</td>
  <td class="pg-r pg-num pg-bad">${r.total_faltas}</td></tr>`).join("")
			: `<tr><td colspan="6" class="pg-empty">${__("Nenhum vigilante encontrado.")}</td></tr>`);
		this._ob_update_footer("faltas", rows.length, filtered.length);
	}

	_export_faltas() {
		const data = this._ob.faltas.all_data || [];
		if (!data.length) return;
		const hdr = ["Vigilante", "Nome", "Posto", "Delegação", "Total Faltas"];
		const rows = data.map((r) => [r.vigilante, r.nome_completo, r.posto, r.delegacao, r.total_faltas]);
		const csv = "﻿" + [hdr, ...rows].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
		const a = Object.assign(document.createElement("a"), {
			href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })),
			download: `sigos_faltas_${frappe.datetime.get_today()}.csv`,
		});
		document.body.appendChild(a); a.click(); document.body.removeChild(a);
	}

	// ============================================================ USERS
	_render_users(d) {
		const $card = this.$b.find("#pg-users-card");
		if (!d || d.allowed === false) { $card.hide(); return; }
		$card.show();
		const rows = d.rows || [], esc = frappe.utils.escape_html;
		this.$b.find("#pg-count-users").text(`${rows.length} ${rows.length === 1 ? __("utilizador") : __("utilizadores")}`);
		if (!rows.length) {
			this.$b.find("#pg-tbody-users").html(`<tr><td colspan="4" class="pg-empty">${__("Sem utilizadores activos.")}</td></tr>`);
			return;
		}
		this.$b.find("#pg-tbody-users").html(rows.map((r) => {
			const n = r.dias_desde_acesso;
			const pill = n === null || n === undefined ? `<span class="pg-pill pg-pill--mute">${__("Nunca")}</span>`
				: n === 0 ? `<span class="pg-pill pg-pill--good">${__("Hoje")}</span>`
				: n <= 3 ? `<span class="pg-pill pg-pill--good">${n}d</span>`
				: n <= 14 ? `<span class="pg-pill pg-pill--amber">${n}d</span>`
				: `<span class="pg-pill pg-pill--bad">${n}d</span>`;
			return `<tr><td><a class="pg-link" href="/app/user/${encodeURIComponent(r.user)}">${esc(r.user)}</a></td>
				<td>${esc(r.full_name || "-")}</td>
				<td class="pg-muted">${r.last_active ? frappe.datetime.str_to_user(r.last_active) : "-"}</td>
				<td class="pg-r">${pill}</td></tr>`;
		}).join(""));
	}

	// ============================================================ CHARTS
	_nav_render(id) {
		const nav = this._nav[id];
		if (!nav || !nav.all_data || !nav.all_data.labels || !nav.all_data.labels.length) return;
		const total = nav.all_data.labels.length;
		const end = total - nav.offset * nav.window;
		const start = Math.max(0, end - nav.window);
		const slice = { labels: nav.all_data.labels.slice(start, end), values: nav.all_data.values.slice(start, end) };
		this.$b.find(`#pg-nav-range-${id}`).text(`${slice.labels[0]}  ->  ${slice.labels[slice.labels.length - 1]}`);
		const max = Math.ceil(total / nav.window) - 1;
		this.$b.find(`.pg-nav-prev[data-chart="${id}"]`).prop("disabled", nav.offset >= max);
		this.$b.find(`.pg-nav-next[data-chart="${id}"]`).prop("disabled", nav.offset === 0);
		this._bar(id, slice, nav.color);
	}

	_base(height) {
		return {
			chart: {
				height, toolbar: { show: false }, fontFamily: "Inter, system-ui, sans-serif",
				animations: { enabled: true, easing: "easeinout", speed: 450 }, background: "transparent",
			},
			grid: { borderColor: this.C.line, strokeDashArray: 3, padding: { left: 4, right: 10 }, xaxis: { lines: { show: false } } },
			dataLabels: { enabled: false },
			tooltip: { style: { fontSize: "12px" }, y: { formatter: (v) => this._fmt(v) } },
			states: { hover: { filter: { type: "darken", value: 0.9 } } },
		};
	}

	_axis() {
		return { colors: this.C.ink3, fontFamily: "Inter, system-ui, sans-serif", fontSize: "11px", fontWeight: 500 };
	}

	_destroy(id) {
		if (this.charts[id]) { try { this.charts[id].destroy(); } catch (e) { /* ignore */ } delete this.charts[id]; }
	}

	_empty(id, msg) {
		this._destroy(id);
		this.$b.find(`#${id}`).html(`<div class="pg-chart-empty">${msg || __("Sem dados no período.")}</div>`);
	}

	_make(id, opts) {
		this._destroy(id);
		const el = this.$b.find(`#${id}`)[0];
		if (!el || !window.ApexCharts) return;
		el.innerHTML = "";
		this.charts[id] = new ApexCharts(el, opts);
		this.charts[id].render();
	}

	_has_data(d, key = "values") {
		return d && d.labels && d.labels.length && (d[key] || []).some((v) => v > 0);
	}

	_bar(id, d, color, height = 260) {
		if (!this._has_data(d)) return this._empty(id);
		const b = this._base(height);
		this._make(id, {
			...b,
			series: [{ name: __("Total"), data: d.values }],
			chart: { ...b.chart, type: "bar" },
			colors: [color],
			plotOptions: { bar: { borderRadius: 5, borderRadiusApplication: "end", columnWidth: "55%" } },
			dataLabels: {
				enabled: d.labels.length <= 31, formatter: (v) => (v > 0 ? this._fmt(v) : ""),
				style: { fontSize: "10px", fontWeight: 700, colors: ["#FFFFFF"] }, dropShadow: { enabled: false },
			},
			xaxis: { categories: d.labels, labels: { style: this._axis(), rotate: -35, hideOverlappingLabels: true }, axisBorder: { show: false }, axisTicks: { show: false } },
			yaxis: { labels: { style: this._axis(), formatter: (v) => Math.round(v) } },
		});
	}

	_line(id, d, color, height = 260) {
		if (!this._has_data(d)) return this._empty(id);
		const b = this._base(height);
		this._make(id, {
			...b,
			series: [{ name: __("Total"), data: d.values }],
			chart: { ...b.chart, type: "area" },
			colors: [color],
			fill: { type: "gradient", gradient: { opacityFrom: 0.24, opacityTo: 0.02, stops: [0, 90] } },
			stroke: { curve: "smooth", width: 2.5 },
			markers: { size: 0, hover: { size: 5 } },
			xaxis: { categories: d.labels, labels: { style: this._axis(), rotate: -35, hideOverlappingLabels: true }, axisBorder: { show: false }, axisTicks: { show: false } },
			yaxis: { labels: { style: this._axis(), formatter: (v) => Math.round(v) } },
		});
	}

	_hbar(id, d, color, height = 260) {
		if (!this._has_data(d)) return this._empty(id);
		const b = this._base(Math.max(height, d.labels.length * 34 + 50));
		this._make(id, {
			...b,
			series: [{ name: __("Total"), data: d.values }],
			chart: { ...b.chart, type: "bar" },
			colors: [color],
			plotOptions: { bar: { horizontal: true, borderRadius: 5, borderRadiusApplication: "end", barHeight: "56%", dataLabels: { position: "top" } } },
			dataLabels: {
				enabled: true, textAnchor: "start", offsetX: 8, formatter: (v) => (v > 0 ? this._fmt(v) : ""),
				style: { fontSize: "11px", fontWeight: 700, colors: [this.C.ink] }, dropShadow: { enabled: false },
			},
			xaxis: { categories: d.labels, labels: { style: this._axis() }, axisBorder: { show: false }, axisTicks: { show: false } },
			yaxis: { labels: { style: { ...this._axis(), colors: this.C.ink }, maxWidth: 220 } },
		});
	}

	_dual_bar(id, d, height = 300) {
		if (!d || !d.labels || !d.labels.length || ![...d.admitidos, ...d.demitidos].some((v) => v > 0)) return this._empty(id);
		const b = this._base(height);
		this._make(id, {
			...b,
			series: [{ name: __("Admitidos"), data: d.admitidos }, { name: __("Demitidos"), data: d.demitidos }],
			chart: { ...b.chart, type: "bar" },
			colors: [this.C.good, this.C.bad],
			plotOptions: { bar: { borderRadius: 4, borderRadiusApplication: "end", columnWidth: "58%" } },
			dataLabels: {
				enabled: d.labels.length <= 12, formatter: (v) => (v > 0 ? this._fmt(v) : ""),
				style: { fontSize: "10px", fontWeight: 700, colors: ["#FFFFFF"] }, dropShadow: { enabled: false },
			},
			xaxis: { categories: d.labels, labels: { style: this._axis(), rotate: -35 }, axisBorder: { show: false }, axisTicks: { show: false } },
			yaxis: { labels: { style: this._axis(), formatter: (v) => Math.round(v) } },
			legend: { position: "top", horizontalAlign: "right", fontSize: "12px", fontWeight: 600, markers: { width: 8, height: 8, radius: 4 } },
		});
	}

	_stacked_bar(id, d, height = 320) {
		if (!d || !d.labels || !d.series || !d.series.length) return this._empty(id);
		const b = this._base(height);
		this._make(id, {
			...b,
			series: d.series,
			chart: { ...b.chart, type: "bar", stacked: true },
			colors: d.series.map((_, i) => this.C.palette[i % this.C.palette.length]),
			plotOptions: { bar: { columnWidth: "58%", borderRadius: 3, borderRadiusApplication: "end", borderRadiusWhenStacked: "last" } },
			xaxis: { categories: d.labels, labels: { style: this._axis(), rotate: -35 }, axisBorder: { show: false }, axisTicks: { show: false } },
			yaxis: { labels: { style: this._axis(), formatter: (v) => Math.round(v) } },
			legend: { position: "bottom", fontSize: "11px", fontWeight: 600, markers: { width: 8, height: 8, radius: 4 }, itemMargin: { horizontal: 8 } },
		});
	}

	// ============================================================ STYLE
	_inject_fonts() {
		if (document.getElementById("pg-fonts")) return;
		const l = document.createElement("link");
		l.id = "pg-fonts"; l.rel = "stylesheet";
		l.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";
		document.head.appendChild(l);
	}

	_inject_css() {
		if (document.getElementById("pg-css")) return;
		const css = `
/* SIGOS Painel Geral - Operations Daylight. ASCII-only. */
.sigos-pg { background:#F4F6FA; }
.layout-main-section-wrapper:has(.sigos-pg), .page-body:has(.sigos-pg) { background:#F4F6FA; }
.sigos-pg .page-head, .sigos-pg + .page-head { display:none; }
.pg-root {
  --paper:#F4F6FA; --paper2:#FFFFFF; --paper3:#EEF1F6; --ink:#0E1726; --ink2:#5B6B82;
  --ink3:#93A1B5; --line:#E6EAF2; --line2:#D5DCE8; --accent:#4F46E5; --accentInk:#4338CA;
  --wash:rgba(79,70,229,.07); --good:#16A34A; --bad:#E5484D; --amber:#F59E0B; --info:#2F6FED;
  --teal:#0EA5A3; --violet:#8B5CF6; --graphite:#64748B;
  --goodWash:rgba(22,163,74,.12); --badWash:rgba(229,72,77,.12); --amberWash:rgba(245,158,11,.14);
  --display:'Space Grotesk',system-ui,sans-serif; --body:'Inter',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
  --shadow:0 1px 2px rgba(16,23,38,.04), 0 14px 34px -20px rgba(16,23,38,.22);
  --r:16px;
  max-width:1280px; margin:0 auto; padding:8px 14px 80px;
  color:var(--ink); font-family:var(--body); font-size:13px; -webkit-font-smoothing:antialiased;
}
.pg-num { font-family:var(--display); font-feature-settings:"tnum" 1; letter-spacing:-.01em; }
.pg-mono { font-family:var(--mono); font-size:12px; }
.pg-up { text-transform:uppercase; letter-spacing:.12em; font-size:10px; color:var(--ink3); font-weight:600; margin-bottom:4px; }

/* masthead */
.pg-mast { display:flex; justify-content:space-between; align-items:flex-start; padding:20px 4px 6px; gap:16px; flex-wrap:wrap; }
.pg-mast-l { display:flex; align-items:flex-start; gap:15px; }
.pg-mark { width:42px; height:42px; border-radius:13px; display:grid; place-items:center; flex:none;
  background:linear-gradient(150deg,var(--accent),var(--accentInk)); color:#fff; font-family:var(--display); font-size:21px; font-weight:600;
  box-shadow:0 6px 16px -6px rgba(79,70,229,.6); }
.pg-h1 { font-family:var(--display); font-weight:600; font-size:27px; line-height:1; letter-spacing:-.02em; margin:0; color:var(--ink); }
.pg-date { font-size:13px; color:var(--ink2); margin-top:7px; font-weight:500; }
.pg-mast-r { display:flex; gap:10px; align-items:center; }
.pg-pulse { display:inline-flex; align-items:center; gap:7px; color:var(--ink3); font-size:10px; text-transform:uppercase; letter-spacing:.08em; font-weight:600; }
.pg-pulse i { width:7px; height:7px; border-radius:50%; background:var(--good); box-shadow:0 0 0 3px var(--goodWash); animation:pg-blip 2.4s ease-in-out infinite; }
@keyframes pg-blip { 0%,100%{opacity:1} 50%{opacity:.45} }
.pg-btn { font-family:var(--body); font-size:11px; font-weight:600; border:1px solid var(--line2);
  background:var(--paper2); color:var(--ink2); padding:8px 14px; border-radius:10px; cursor:pointer; transition:.2s; box-shadow:var(--shadow); }
.pg-btn:hover { background:var(--accent); color:#fff; border-color:var(--accent); }
.pg-btn-sm { padding:5px 10px; font-size:11px; box-shadow:none; }

/* sections */
.pg-sec { display:flex; align-items:center; gap:12px; margin:36px 4px 16px; }
.pg-sec-bar { width:4px; height:18px; border-radius:3px; background:var(--accent); flex:none; }
.pg-sec--alert .pg-sec-bar { background:var(--bad); }
.pg-sec h2 { font-family:var(--display); font-size:17px; font-weight:600; margin:0; color:var(--ink); letter-spacing:-.01em; white-space:nowrap; }
.pg-sec-sub { font-size:12px; color:var(--ink3); white-space:nowrap; }
.pg-sec-line { flex:1; height:1px; background:var(--line); }

/* kpis */
.pg-kpi-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(168px,1fr)); gap:12px; }
.pg-kpi { background:var(--paper2); border:1px solid var(--line); border-radius:14px; padding:14px 16px 13px; box-shadow:var(--shadow); --tone:var(--accent); }
.pg-tone-good { --tone:var(--good); } .pg-tone-info { --tone:var(--info); } .pg-tone-teal { --tone:var(--teal); }
.pg-tone-violet { --tone:var(--violet); } .pg-tone-graphite { --tone:var(--graphite); } .pg-tone-amber { --tone:var(--amber); }
.pg-kpi-label { font-size:11px; color:var(--ink2); font-weight:600; min-height:28px; line-height:1.3; }
.pg-kpi-value { font-size:28px; font-weight:600; color:var(--ink); line-height:1.1; margin:4px 0 10px; }
.pg-kpi-bar { height:4px; border-radius:4px; background:var(--paper3); overflow:hidden; }
.pg-kpi-bar i { display:block; height:100%; width:0; border-radius:4px; background:var(--tone); transition:width 900ms cubic-bezier(.22,1,.36,1); }

/* cards */
.pg-row1, .pg-row2 { display:grid; gap:16px; margin-bottom:16px; }
.pg-row2 { grid-template-columns:repeat(2,minmax(0,1fr)); }
@media (max-width:900px) { .pg-row2 { grid-template-columns:minmax(0,1fr); } }
.pg-card { background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); padding:18px 18px 12px; box-shadow:var(--shadow); min-width:0; }
.pg-card-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
.pg-card-title { font-family:var(--display); font-size:15px; font-weight:600; margin:0; color:var(--ink); }
.pg-card-sub { font-size:11.5px; color:var(--ink3); margin:3px 0 0; }
.pg-filters { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.pg-seg { display:inline-flex; background:var(--paper3); border-radius:9px; padding:2px; gap:2px; }
.pg-seg button { border:0; background:transparent; color:var(--ink2); font-size:11px; font-weight:600; padding:4px 9px; border-radius:7px; cursor:pointer; transition:.15s; }
.pg-seg button:hover { color:var(--ink); }
.pg-seg button.is-on { background:var(--paper2); color:var(--accentInk); box-shadow:0 1px 2px rgba(16,23,38,.1); }
.pg-chart { width:100%; }
.pg-chart-empty { display:flex; align-items:center; justify-content:center; min-height:180px; color:var(--ink3); font-size:12px;
  border:1px dashed var(--line2); border-radius:12px; margin:6px 0 8px; }

/* daily navigator */
.pg-nav { display:flex; align-items:center; justify-content:center; gap:12px; margin:2px 0 4px; }
.pg-nav-btn { width:28px; height:28px; border-radius:8px; border:1px solid var(--line2); background:var(--paper2); color:var(--ink2);
  display:grid; place-items:center; cursor:pointer; transition:.15s; }
.pg-nav-btn:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
.pg-nav-btn:disabled { opacity:.35; cursor:default; }
.pg-nav-range { font-size:12px; color:var(--ink2); min-width:130px; text-align:center; }

/* drawers */
.pg-ob-head-r { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.pg-badge { font-size:11px; font-weight:600; color:var(--accentInk); background:var(--wash); padding:4px 10px; border-radius:999px; white-space:nowrap; }
.pg-ob-toggle { width:100%; display:flex; align-items:center; justify-content:center; gap:6px; border:0; border-top:1px solid var(--line);
  background:transparent; color:var(--accentInk); font-size:12px; font-weight:600; padding:10px 0 4px; margin-top:6px; cursor:pointer; }
.pg-ob-chev { transition:transform .2s; }
.pg-ob.is-open .pg-ob-chev { transform:rotate(180deg); }
.pg-ob-drawer { display:none; padding-top:10px; }
.pg-ob.is-open .pg-ob-drawer { display:block; }
.pg-ob-search { display:flex; align-items:center; gap:8px; border:1px solid var(--line2); border-radius:10px; padding:0 10px; color:var(--ink3); margin-bottom:10px; background:var(--paper); }
.pg-ob-input { border:0; outline:0; background:transparent; padding:8px 0; font-size:12.5px; width:100%; color:var(--ink); }
.pg-ob-foot { display:flex; justify-content:space-between; align-items:center; padding:10px 2px 4px; }
.pg-count { font-size:11.5px; color:var(--ink3); }

/* tables */
.pg-table-scroll { overflow-x:auto; max-height:520px; overflow-y:auto; }
.pg-table { width:100%; border-collapse:collapse; font-size:12.5px; }
.pg-table th { position:sticky; top:0; background:var(--paper2); text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.08em;
  color:var(--ink3); font-weight:600; padding:8px 10px; border-bottom:1px solid var(--line); }
.pg-table td { padding:9px 10px; border-bottom:1px solid var(--line); color:var(--ink); }
.pg-table tbody tr:hover td { background:var(--paper); }
.pg-r { text-align:right !important; }
.pg-muted { color:var(--ink3) !important; }
.pg-bad { color:var(--bad) !important; font-weight:600; }
.pg-link { color:var(--accentInk); font-weight:500; }
.pg-link:hover { text-decoration:underline; color:var(--accent); }
.pg-empty { text-align:center; color:var(--ink3); padding:22px 0 !important; }
.pg-skel-cell { padding:14px 10px !important; }
.pg-skel { height:12px; border-radius:6px; background:linear-gradient(90deg,var(--paper3),var(--paper),var(--paper3)); background-size:200% 100%; animation:pg-shim 1.2s linear infinite; }
@keyframes pg-shim { from{background-position:200% 0} to{background-position:-200% 0} }
.pg-pill { display:inline-block; font-size:11px; font-weight:600; padding:2px 9px; border-radius:999px; }
.pg-pill--good { color:var(--good); background:var(--goodWash); }
.pg-pill--amber { color:#B45309; background:var(--amberWash); }
.pg-pill--bad { color:var(--bad); background:var(--badWash); }
.pg-pill--mute { color:var(--ink3); background:var(--paper3); }
.pg-users { margin-top:16px; }

/* apexcharts */
.pg-root .apexcharts-tooltip { border-radius:10px !important; border:1px solid var(--line) !important; box-shadow:var(--shadow) !important; }
.pg-root .apexcharts-legend-text { color:var(--ink2) !important; }
`;
		const s = document.createElement("style");
		s.id = "pg-css"; s.textContent = css;
		document.head.appendChild(s);
	}
};
