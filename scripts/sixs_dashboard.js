// SIXS — Security Operations Dashboard
frappe.pages["sixs-dashboard"].on_page_load = function (wrapper) {
	frappe.sixs_dashboard = new SixsDashboard(wrapper);
};
frappe.pages["sixs-dashboard"].on_page_show = function (wrapper) {
	if (frappe.sixs_dashboard) frappe.sixs_dashboard.on_show();
};

// Period preset arrays — shared across chart configs
const _P = {
	weekly:  [{l:"12sem",a:{weeks:12}},{l:"26sem",a:{weeks:26}},{l:"1a",a:{weeks:52}}],
	monthly: [{l:"6m",a:{months:6}},{l:"12m",a:{months:12}},{l:"2a",a:{months:24}}],
	faltas:  [{l:"1m",a:{months:1}},{l:"3m",a:{months:3}},{l:"6m",a:{months:6}},{l:"1a",a:{months:12}}],
};

// ─────────────────────────────────────────────────────────────────────────────
class SixsDashboard {
	constructor(wrapper) {
		this.wrapper   = wrapper;
		this.page      = frappe.ui.make_app_page({ parent: wrapper, title: "", single_column: true });
		this.charts    = {};
		this.PAGE_SIZE = 20;
		this._ready    = false;

		// Option B state
		this._ob = {
			"vig-cliente": { open: false, offset: 0, search: "", total: 0, debounce: null },
			"rot-cliente": { open: false, offset: 0, search: "", total: 0, debounce: null },
			"faltas":      { open: false, page: 0,   search: "", all_data: [], filtered: [] },
		};

		// Period filter state — current args per chart/section id
		this._pf = {
			"sx-ch-demissoes-semanais": { weeks: 12 },
			"sx-ch-rot-semanais":       { weeks: 12 },
			"sx-ch-rot-mensais":        { months: 12 },
			"rot-cliente":              { months: 6 },
			"sx-ch-aus-semanais":       { weeks: 12 },
			"sx-ch-aus-mensais":        { months: 12 },
			"sx-ch-admitidos":          { months: 12 },
			"faltas":                   { months: 6 },
		};

		// Navigation state for daily charts — windowed view within 90-day buffer
		this._nav = {
			"sx-ch-demissoes-diarias": { all_data: null, window: 7, offset: 0 },
			"sx-ch-rot-diarias":       { all_data: null, window: 7, offset: 0 },
		};

		// Status filter state — current status per section id
		this._sf = {
			"vig-cliente":            "Ativo",
			"faltas":                 "Ativo",
			"sx-ch-reservas-deleg":   "Ativo",
			"sx-ch-feriadores-deleg": "Ativo",
		};

		this._init();
	}

	_init() {
		this._load_apexcharts().then(() => {
			this._ready = true;
			this._render();
			this._build_loaders();
			this._bind_events();
			this.refresh();
		}).catch(() => frappe.msgprint(__("Não foi possível carregar ApexCharts.")));
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
		Object.values(this.charts).forEach(c => { try { c.destroy(); } catch (_) {} });
		this.charts = {};
		this.refresh();
	}

	// Build loader functions after render (so DOM IDs exist)
	_build_loaders() {
		this._loaders = {
			"sx-ch-demissoes-diarias":  () => this._call("get_demissoes_diarias", { days: 90 }).then(d => {
				if (d?.labels?.length) {
					this._nav["sx-ch-demissoes-diarias"].all_data = d;
					this._nav["sx-ch-demissoes-diarias"].offset   = 0;
					this._nav_render("sx-ch-demissoes-diarias");
				}
			}),

			"sx-ch-demissoes-semanais": () => this._call("get_demissoes_semanais", this._pf["sx-ch-demissoes-semanais"])
				.then(d => this._bar("sx-ch-demissoes-semanais", d, "#DC2626")),

			"sx-ch-rot-diarias":        () => this._call("get_rotatividades_diarias", { days: 90 }).then(d => {
				if (d?.labels?.length) {
					this._nav["sx-ch-rot-diarias"].all_data = d;
					this._nav["sx-ch-rot-diarias"].offset   = 0;
					this._nav_render("sx-ch-rot-diarias");
				}
			}),

			"sx-ch-rot-semanais":       () => this._call("get_rotatividades_semanais", this._pf["sx-ch-rot-semanais"])
				.then(d => this._line("sx-ch-rot-semanais", d, "#D97706")),

			"sx-ch-rot-mensais":        () => this._call("get_rotatividades_mensais",  this._pf["sx-ch-rot-mensais"])
				.then(d => this._bar("sx-ch-rot-mensais", d, "#D97706", 300)),

			"rot-cliente": () => this._call("get_rotatividades_por_cliente", this._pf["rot-cliente"]).then(d => {
				this._stacked_bar("sx-ch-rot-cliente", d, 300);
				this._ob_set_badge("rot-cliente", d.total_clients, "clientes");
				this._ob["rot-cliente"].total = d.total_clients || 0;
				if (this._ob["rot-cliente"].open) {
					this._ob["rot-cliente"].offset = 0;
					this._ob_load_server("rot-cliente", true);
				}
			}),

			"sx-ch-aus-semanais": () => this._call("get_ausencias_semanais", this._pf["sx-ch-aus-semanais"])
				.then(d => this._bar("sx-ch-aus-semanais", d, "#2563EB", 280)),

			"sx-ch-aus-mensais":  () => this._call("get_ausencias_mensais",  this._pf["sx-ch-aus-mensais"])
				.then(d => this._bar("sx-ch-aus-mensais", d, "#2563EB", 280)),

			"sx-ch-admitidos": () => this._call("get_admitidos_demitidos", this._pf["sx-ch-admitidos"])
				.then(d => this._dual_bar("sx-ch-admitidos", d, 300)),

			"vig-cliente": () => this._call("get_vigilantes_por_cliente", { status: this._sf["vig-cliente"] }).then(d => {
				this._hbar("sx-ch-vig-cliente", d, "#E85D04", 280);
				this._ob_set_badge("vig-cliente", d.total_clients, "clientes");
				this._ob["vig-cliente"].total = d.total_clients || 0;
				if (this._ob["vig-cliente"].open) {
					this._ob["vig-cliente"].offset = 0;
					this._ob_load_server("vig-cliente", true);
				}
			}),

			"sx-ch-reservas-deleg": () => this._call("get_reservas_por_delegacao", { status: this._sf["sx-ch-reservas-deleg"] })
				.then(d => this._hbar("sx-ch-reservas-deleg", d, "#0891B2")),

			"sx-ch-feriadores-deleg": () => this._call("get_feriadores_por_delegacao", { status: this._sf["sx-ch-feriadores-deleg"] })
				.then(d => this._hbar("sx-ch-feriadores-deleg", d, "#EA580C")),

			"faltas": () => this._call("get_vigilantes_muitas_faltas", {
				min_faltas: 8,
				status: this._sf["faltas"],
				months: (this._pf["faltas"] || {}).months || 6,
			}).then(d => this._ob_init_faltas(d)),
		};
	}

	// ── HTML Layout ──────────────────────────────────────────────────────────

	_render() { $(this.page.body).html(this._html()); }

	_html() {
		return /* html */`
<div class="sx-wrap">

  <!-- ─ Header ───────────────────────────────────────────────────────── -->
  <header class="sx-topbar">
    <div class="sx-brand">
      <div class="sx-brand-mark">SX</div>
      <div>
        <span class="sx-brand-name">SIXS</span>
        <span class="sx-brand-sub">Central de Operações</span>
      </div>
    </div>
    <div class="sx-controls">
      <button class="sx-btn-refresh" id="sx-refresh">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <path d="M1 4v6h6"/><path d="M23 20v-6h-6"/>
          <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
        </svg>
        Actualizar
      </button>
    </div>
  </header>

  <!-- ─ KPI Cards ─────────────────────────────────────────────────────── -->
  <div class="sx-section-label">Resumo Operacional</div>
  <div class="sx-kpi-grid">
    ${this._kpi("clientes",        "Total de Clientes")}
    ${this._kpi("ativos",          "Vigilantes Activos")}
    ${this._kpi("mulheres",        "Vigilantes Mulheres")}
    ${this._kpi("homens",          "Vigilantes Homens")}
    ${this._kpi("armados",         "Vigilantes Armados")}
    ${this._kpi("simples",         "Vigilantes Normais")}
    ${this._kpi("reservas",        "Vigilantes Reservas")}
    ${this._kpi("administrativos", "Administrativos")}
    ${this._kpi("postos",          "Postos de Vigilância")}
    ${this._kpi("postos_ativos",   "Postos Activos")}
    ${this._kpi("tdu",             "Vigilantes TDU")}
    ${this._kpi("h24",             "Vigilantes H24")}
    ${this._kpi("tdn",             "Vigilantes TDN")}
  </div>

  <!-- ─ Demissões ──────────────────────────────────────────────────────── -->
  <div class="sx-section-label">Demissões</div>
  <div class="sx-row-half">
    ${this._chart_card("sx-ch-demissoes-diarias",  "Demissões Diárias",  "Navegar por período", 260, null, null, true)}
    ${this._chart_card("sx-ch-demissoes-semanais", "Demissões Semanais", "Período seleccionado", 260, _P.weekly)}
  </div>

  <!-- ─ Rotatividades ──────────────────────────────────────────────────── -->
  <div class="sx-section-label">Rotatividades</div>
  <div class="sx-row-half">
    ${this._chart_card("sx-ch-rot-diarias",  "Rotatividades Diárias",  "Navegar por período", 260, null, null, true)}
    ${this._chart_card("sx-ch-rot-semanais", "Rotatividades Semanais", "Período seleccionado", 260, _P.weekly)}
  </div>
  <div class="sx-row-full">
    ${this._chart_card("sx-ch-rot-mensais", "Rotatividades Mensais", "Período seleccionado", 300, _P.monthly)}
  </div>

  <!-- Rotatividades por Cliente — Option B -->
  <div class="sx-row-full">${this._ob_card("rot-cliente",
    "Rotatividades por Cliente",
    "Top 10 — período seleccionado",
    "clientes",
    [{ label: "#" }, { label: "Cliente" }, { label: "Rotatividades", right: true }, { label: "Última Data" }],
    300, false, _P.monthly
  )}</div>

  <!-- ─ Ausências ──────────────────────────────────────────────────────── -->
  <div class="sx-section-label">Ausências</div>
  <div class="sx-row-full">
    ${this._chart_card("sx-ch-aus-semanais", "Ausências Semanais", "Período seleccionado", 280, _P.weekly)}
  </div>
  <div class="sx-row-full">
    ${this._chart_card("sx-ch-aus-mensais", "Ausências Mensais", "Período seleccionado", 280, _P.monthly)}
  </div>

  <!-- ─ Distribuição ───────────────────────────────────────────────────── -->
  <div class="sx-section-label">Distribuição</div>

  <!-- Vigilantes por Cliente — Option B -->
  <div class="sx-row-full">${this._ob_card("vig-cliente",
    "Vigilantes por Cliente",
    "Top 10",
    "clientes",
    [{ label: "#" }, { label: "Cliente" }, { label: "Vigilantes", right: true }, { label: "% do Total", right: true }],
    280, true, null
  )}</div>

  <div class="sx-row-half">
    ${this._chart_card("sx-ch-armas-deleg",    "Armas por Delegação",    "Total registado")}
    ${this._chart_card("sx-ch-reservas-deleg", "Reservas por Delegação", "Estado seleccionado", 260, null, "sx-ch-reservas-deleg")}
  </div>
  <div class="sx-row-full">
    ${this._chart_card("sx-ch-admitidos", "Admitidos vs Demitidos", "Período seleccionado", 300, _P.monthly)}
  </div>
  <div class="sx-row-half">
    ${this._chart_card("sx-ch-superv-deleg",     "Supervisores por Delegação", "Total registado")}
    ${this._chart_card("sx-ch-feriadores-deleg", "Feriadores por Delegação",   "Estado seleccionado", 260, null, "sx-ch-feriadores-deleg")}
  </div>

  <!-- ─ Alertas ────────────────────────────────────────────────────────── -->
  <div class="sx-section-label sx-section-label--alert">Alertas & Relatórios</div>

  <!-- Vigilantes com +8 Faltas — Option B -->
  <div class="sx-row-full">${this._ob_card("faltas",
    "Vigilantes com mais de 8 Faltas",
    "Período seleccionado",
    "vigilantes",
    [{ label: "#" }, { label: "Vigilante" }, { label: "Nome" }, { label: "Posto" }, { label: "Delegação" }, { label: "Faltas", right: true }],
    240, true, _P.faltas
  )}</div>

  <!-- Utilizadores Activos -->
  <div class="sx-table-card" style="margin:0 28px 28px">
    <div class="sx-table-head">
      <div>
        <h3 class="sx-card-title">Utilizadores Activos no Sistema</h3>
        <p class="sx-card-sub">Último acesso em dias</p>
      </div>
    </div>
    <div class="sx-table-scroll">
      <table class="sx-table">
        <thead><tr>
          <th>Utilizador</th><th>Nome Completo</th>
          <th>Último Acesso</th><th class="sx-th-r">Dias</th>
        </tr></thead>
        <tbody id="sx-tbody-users">
          <tr><td colspan="4" class="sx-skeleton-cell"><div class="sx-skeleton"></div></td></tr>
        </tbody>
      </table>
    </div>
    <div class="sx-table-foot"><span id="sx-count-users" class="sx-count">—</span></div>
  </div>

  <div class="sx-loading-overlay" id="sx-loading"><div class="sx-spinner"></div></div>
</div>`;
	}

	_kpi(id, label) {
		return /* html */`
<div class="sx-kpi" id="sx-kpi-${id}">
  <div class="sx-kpi-label">${label}</div>
  <div class="sx-kpi-value" id="sx-kpi-${id}-val">—</div>
  <div class="sx-kpi-bar" id="sx-kpi-${id}-bar"></div>
</div>`;
	}

	_chart_card(id, title, sub, height = 260, periods = null, status_id = null, navigable = false) {
		const has_right = periods || status_id || navigable;
		const right_html = navigable
			? this._nav_window_pills(id)
			: `${status_id ? this._status_pills(status_id) : ""}${periods ? this._period_pills(id, periods) : ""}`;
		return /* html */`
<div class="sx-card">
  <div class="sx-card-head">
    <div><h3 class="sx-card-title">${title}</h3><p class="sx-card-sub">${sub}</p></div>
    ${has_right ? `<div class="sx-card-filters">${right_html}</div>` : ""}
  </div>
  ${navigable ? this._nav_bar(id) : ""}
  <div id="${id}" style="height:${height}px;width:100%"></div>
</div>`;
	}

	_period_pills(target, options) {
		const cur = this._pf[target] || {};
		return `<div class="sx-filter-row">${options.map(o => {
			const active = Object.keys(o.a).every(k => o.a[k] == cur[k]) && Object.keys(o.a).length === Object.keys(cur).length;
			return `<button class="sx-pf-btn${active ? " sx-pf-active" : ""}" data-target="${target}" data-args='${JSON.stringify(o.a)}'>${o.l}</button>`;
		}).join("")}</div>`;
	}

	_nav_window_pills(chart_id) {
		const opts = [{l:"7d",w:7},{l:"14d",w:14},{l:"30d",w:30}];
		const cur  = this._nav[chart_id]?.window || 7;
		return `<div class="sx-filter-row">${opts.map(o =>
			`<button class="sx-nw-btn${o.w === cur ? " sx-pf-active" : ""}" data-chart="${chart_id}" data-window="${o.w}">${o.l}</button>`
		).join("")}</div>`;
	}

	_nav_bar(id) {
		return /* html */`
<div class="sx-nav-bar">
  <button class="sx-nav-btn sx-nav-prev" data-chart="${id}" disabled title="Período anterior">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  </button>
  <span class="sx-nav-range" id="sx-nav-range-${id}">—</span>
  <button class="sx-nav-btn sx-nav-next" data-chart="${id}" disabled title="Período seguinte">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  </button>
</div>`;
	}

	_status_pills(target) {
		const opts = [{ l: "Activos", v: "Ativo" }, { l: "Inactivos", v: "Inativo" }, { l: "Todos", v: "Todos" }];
		return `<div class="sx-filter-row">${opts.map((o, i) =>
			`<button class="sx-sf-btn${i === 0 ? " sx-sf-active" : ""}" data-target="${target}" data-status="${o.v}">${o.l}</button>`
		).join("")}</div>`;
	}

	_ob_card(id, title, sub, unit, headers, chart_height = 280, status_filter = false, periods = null) {
		const th = headers.map(h => `<th${h.right ? ' class="sx-th-r"' : ""}>${h.label}</th>`).join("");
		const export_btn = id === "faltas"
			? `<button class="sx-btn-export" id="sx-ob-${id}-export">
               <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                 <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                 <polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/>
               </svg>CSV</button>`
			: "";

		const filters_html = (status_filter || periods)
			? `<div class="sx-ob-filters">${status_filter ? this._status_pills(id) : ""}${periods ? this._period_pills(id, periods) : ""}</div>`
			: "";

		return /* html */`
<div class="sx-card sx-ob-card">
  <div class="sx-card-head">
    <div><h3 class="sx-card-title">${title}</h3><p class="sx-card-sub">${sub}</p></div>
    <div class="sx-ob-head-right">
      <span class="sx-ob-badge" id="sx-ob-${id}-badge">—</span>
      ${export_btn}
    </div>
  </div>
  ${filters_html}
  <div id="sx-ch-${id}" style="height:${chart_height}px;width:100%"></div>

  <button class="sx-ob-toggle" id="sx-ob-${id}-toggle">
    <span id="sx-ob-${id}-toggle-label">Ver todos os ${unit}</span>
    <svg class="sx-ob-chevron" id="sx-ob-${id}-chevron" width="14" height="14" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  </button>

  <div class="sx-ob-drawer" id="sx-ob-${id}-drawer">
    <div class="sx-ob-searchbar">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <input type="text" class="sx-ob-input" id="sx-ob-${id}-search" placeholder="Filtrar ${unit}…">
    </div>
    <div class="sx-table-scroll">
      <table class="sx-table">
        <thead><tr>${th}</tr></thead>
        <tbody id="sx-ob-${id}-tbody">
          <tr><td colspan="${headers.length}" class="sx-skeleton-cell"><div class="sx-skeleton"></div></td></tr>
        </tbody>
      </table>
    </div>
    <div class="sx-ob-footer" id="sx-ob-${id}-footer">
      <span class="sx-count" id="sx-ob-${id}-count">—</span>
      <button class="sx-btn-load-more" id="sx-ob-${id}-more" style="display:none">Carregar mais</button>
    </div>
  </div>
</div>`;
	}

	// ── Events ───────────────────────────────────────────────────────────────

	_bind_events() {
		const $b = this.page.body;

		$b.on("click", "#sx-refresh", () => this.refresh());

		// Nav window size (daily charts)
		$b.on("click", ".sx-nw-btn", e => {
			const btn      = $(e.currentTarget);
			const chart_id = btn.data("chart");
			const win      = parseInt(btn.data("window"));
			$b.find(`.sx-nw-btn[data-chart="${chart_id}"]`).removeClass("sx-pf-active");
			btn.addClass("sx-pf-active");
			this._nav[chart_id].window = win;
			this._nav[chart_id].offset = 0;
			this._nav_render(chart_id);
		});

		// Nav prev — go back in time
		$b.on("click", ".sx-nav-prev", e => {
			const chart_id = $(e.currentTarget).data("chart");
			const nav      = this._nav[chart_id];
			if (!nav?.all_data) return;
			const max_offset = Math.ceil(nav.all_data.labels.length / nav.window) - 1;
			if (nav.offset < max_offset) { nav.offset++; this._nav_render(chart_id); }
		});

		// Nav next — go forward in time
		$b.on("click", ".sx-nav-next", e => {
			const chart_id = $(e.currentTarget).data("chart");
			const nav      = this._nav[chart_id];
			if (nav?.offset > 0) { nav.offset--; this._nav_render(chart_id); }
		});

		// Period filter
		$b.on("click", ".sx-pf-btn", e => {
			const btn    = $(e.currentTarget);
			const target = btn.data("target");
			const args   = JSON.parse(btn.attr("data-args") || "{}");
			$b.find(`.sx-pf-btn[data-target="${target}"]`).removeClass("sx-pf-active");
			btn.addClass("sx-pf-active");
			this._pf[target] = args;
			this._loaders[target]?.();
		});

		// Status filter
		$b.on("click", ".sx-sf-btn", e => {
			const btn    = $(e.currentTarget);
			const target = btn.data("target");
			const status = btn.data("status");
			$b.find(`.sx-sf-btn[data-target="${target}"]`).removeClass("sx-sf-active");
			btn.addClass("sx-sf-active");
			this._sf[target] = status;
			this._loaders[target]?.();
		});

		// OB toggles
		$b.on("click", "#sx-ob-vig-cliente-toggle",  () => this._ob_toggle("vig-cliente"));
		$b.on("click", "#sx-ob-rot-cliente-toggle",  () => this._ob_toggle("rot-cliente"));
		$b.on("click", "#sx-ob-faltas-toggle",       () => this._ob_toggle("faltas"));

		// OB search — server-side debounced
		$b.on("input", "#sx-ob-vig-cliente-search", e => {
			clearTimeout(this._ob["vig-cliente"].debounce);
			this._ob["vig-cliente"].debounce = setTimeout(() => {
				this._ob["vig-cliente"].search = e.target.value;
				this._ob["vig-cliente"].offset = 0;
				this._ob_load_server("vig-cliente", true);
			}, 320);
		});
		$b.on("input", "#sx-ob-rot-cliente-search", e => {
			clearTimeout(this._ob["rot-cliente"].debounce);
			this._ob["rot-cliente"].debounce = setTimeout(() => {
				this._ob["rot-cliente"].search = e.target.value;
				this._ob["rot-cliente"].offset = 0;
				this._ob_load_server("rot-cliente", true);
			}, 320);
		});

		// OB search — client-side (faltas)
		$b.on("input", "#sx-ob-faltas-search", e => {
			this._ob["faltas"].search = e.target.value;
			this._ob["faltas"].page   = 0;
			this._ob_render_faltas_table(true);
		});

		// Load more
		$b.on("click", "#sx-ob-vig-cliente-more", () => {
			this._ob["vig-cliente"].offset += this.PAGE_SIZE;
			this._ob_load_server("vig-cliente", false);
		});
		$b.on("click", "#sx-ob-rot-cliente-more", () => {
			this._ob["rot-cliente"].offset += this.PAGE_SIZE;
			this._ob_load_server("rot-cliente", false);
		});
		$b.on("click", "#sx-ob-faltas-more", () => {
			this._ob["faltas"].page++;
			this._ob_render_faltas_table(false);
		});

		$b.on("click", "#sx-ob-faltas-export", () => this._export_faltas());
	}

	// ── Refresh (all data) ────────────────────────────────────────────────────

	refresh() {
		this._show_loading(true);
		const all = [
			this._call("get_cards_summary").then(d => this._render_cards(d)),
			this._call("get_armas_por_delegacao").then(d => this._hbar("sx-ch-armas-deleg", d, "#7C3AED")),
			this._call("get_supervisores_por_delegacao").then(d => this._hbar("sx-ch-superv-deleg", d, "#059669")),
			this._call("get_users_ativos").then(d => this._render_users(d)),
			...Object.values(this._loaders).map(fn => fn().catch(() => {})),
		];
		Promise.all(all).finally(() => this._show_loading(false));
	}

	_call(method, args) {
		return frappe.call({
			method: `sixs_app.api.dashboard.${method}`, args: args || {},
		}).then(r => r.message || {});
	}

	// ── Cards ─────────────────────────────────────────────────────────────────

	_render_cards(d) {
		if (!d) return;
		Object.keys(d).forEach(k => this._set_kpi(k, d[k]));
	}

	_set_kpi(id, value) {
		const val_el = this.page.body.find(`#sx-kpi-${id}-val`)[0];
		const bar_el = this.page.body.find(`#sx-kpi-${id}-bar`)[0];
		if (!val_el) return;
		const target = parseInt(value) || 0;
		const dur = 700, start = Date.now();
		const tick = () => {
			const p    = Math.min((Date.now() - start) / dur, 1);
			const ease = 1 - Math.pow(1 - p, 3);
			val_el.textContent = Math.round(target * ease).toLocaleString("pt-PT");
			if (p < 1) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
		if (bar_el) {
			bar_el.style.transform  = "scaleX(0)";
			bar_el.style.transition = "transform 900ms cubic-bezier(.22,1,.36,1)";
			setTimeout(() => { bar_el.style.transform = "scaleX(1)"; }, 80);
		}
	}

	// ── Option B: shared helpers ──────────────────────────────────────────────

	_ob_toggle(id) {
		const state   = this._ob[id];
		state.open    = !state.open;
		const drawer  = this.page.body.find(`#sx-ob-${id}-drawer`)[0];
		const chevron = this.page.body.find(`#sx-ob-${id}-chevron`)[0];
		const label   = this.page.body.find(`#sx-ob-${id}-toggle-label`)[0];
		if (!drawer) return;

		if (state.open) {
			drawer.classList.add("sx-ob-open");
			if (chevron) chevron.style.transform = "rotate(180deg)";
			if (label)   label.textContent = "Fechar";
			if (id === "vig-cliente" && state.offset === 0) this._ob_load_server("vig-cliente", true);
			if (id === "rot-cliente" && state.offset === 0) this._ob_load_server("rot-cliente", true);
			if (id === "faltas") this._ob_render_faltas_table(true);
		} else {
			drawer.classList.remove("sx-ob-open");
			if (chevron) chevron.style.transform = "";
			if (label)   label.textContent = `Ver todos os ${id === "faltas" ? "vigilantes" : "clientes"}`;
		}
	}

	_nav_render(id) {
		const nav = this._nav[id];
		if (!nav?.all_data?.labels?.length) return;
		const { all_data, window: win, offset } = nav;
		const total = all_data.labels.length;

		// Slice the window from the end of the array (most recent = rightmost)
		const end   = total - offset * win;
		const start = Math.max(0, end - win);
		const slice = {
			labels: all_data.labels.slice(start, end),
			values: all_data.values.slice(start, end),
		};

		// Date range label
		const range_el = this.page.body.find(`#sx-nav-range-${id}`)[0];
		if (range_el && slice.labels.length) {
			range_el.textContent = `${slice.labels[0]}  →  ${slice.labels[slice.labels.length - 1]}`;
		}

		// Arrow states
		const max_offset = Math.ceil(total / win) - 1;
		const prev = this.page.body.find(`.sx-nav-prev[data-chart="${id}"]`)[0];
		const next = this.page.body.find(`.sx-nav-next[data-chart="${id}"]`)[0];
		if (prev) prev.disabled = offset >= max_offset;
		if (next) next.disabled = offset === 0;

		// Render chart
		const color = id.includes("dem") ? "#DC2626" : "#D97706";
		this._bar(id, slice, color);
	}

	_ob_set_badge(id, count, unit) {
		const el = this.page.body.find(`#sx-ob-${id}-badge`)[0];
		if (el) el.textContent = `${(count || 0).toLocaleString("pt-PT")} ${unit}`;
	}

	_ob_update_footer(id, loaded, total) {
		const count_el = this.page.body.find(`#sx-ob-${id}-count`)[0];
		const more_btn = this.page.body.find(`#sx-ob-${id}-more`)[0];
		if (count_el) count_el.textContent = `${loaded.toLocaleString("pt-PT")} de ${total.toLocaleString("pt-PT")}`;
		if (more_btn) {
			const remaining = total - loaded;
			if (remaining > 0) {
				more_btn.style.display = "";
				more_btn.textContent   = `Carregar mais (${remaining} restantes)`;
			} else {
				more_btn.style.display = "none";
			}
		}
	}

	// ── Option B: server-side (vig-cliente & rot-cliente) ────────────────────

	_ob_load_server(id, reset) {
		const state  = this._ob[id];
		const method = id === "vig-cliente" ? "get_vigilantes_por_cliente_table" : "get_rot_por_cliente_table";
		const args   = { limit: this.PAGE_SIZE, offset: state.offset, search: state.search };
		if (id === "rot-cliente") args.months = (this._pf["rot-cliente"] || {}).months || 6;
		if (id === "vig-cliente") args.status = this._sf["vig-cliente"] || "Ativo";

		const tbody = this.page.body.find(`#sx-ob-${id}-tbody`)[0];
		if (reset && tbody) {
			tbody.innerHTML = `<tr><td colspan="4" class="sx-skeleton-cell"><div class="sx-skeleton"></div></td></tr>`;
		}

		this._call(method, args).then(d => {
			if (!d.rows) return;
			if (reset) state.offset = 0;
			state.total = d.total;

			const rows_html = d.rows.map((r, i) => {
				const num = (reset ? 0 : state.offset - this.PAGE_SIZE) + i + 1;
				if (id === "vig-cliente") return /* html */`
<tr class="sx-row">
  <td class="sx-td-date">${num}</td>
  <td>${r.cliente}</td>
  <td class="sx-td-num">${r.total.toLocaleString("pt-PT")}</td>
  <td class="sx-td-num">${r.pct}%</td>
</tr>`;
				return /* html */`
<tr class="sx-row">
  <td class="sx-td-date">${num}</td>
  <td>${r.cliente}</td>
  <td class="sx-td-num">${r.total.toLocaleString("pt-PT")}</td>
  <td class="sx-td-date">${r.ultima_data ? frappe.format(r.ultima_data, { fieldtype: "Date" }) : "—"}</td>
</tr>`;
			}).join("");

			if (tbody) {
				if (reset) tbody.innerHTML = rows_html || `<tr><td colspan="4" class="sx-empty">Sem resultados.</td></tr>`;
				else       tbody.insertAdjacentHTML("beforeend", rows_html);
			}

			const actual_loaded = reset ? d.rows.length : Math.min(state.offset + d.rows.length, d.total);
			this._ob_update_footer(id, actual_loaded, d.total);
		});
	}

	// ── Option B: client-side (faltas) ────────────────────────────────────────

	_ob_init_faltas(data) {
		const rows = data || [];
		this._ob["faltas"].all_data = rows;

		const top10 = rows.slice(0, 10);
		if (top10.length) {
			this._hbar("sx-ch-faltas", {
				labels: top10.map(r => r.nome_completo || r.vigilante),
				values: top10.map(r => r.total_faltas),
			}, "#DC2626", 240);
		}

		this._ob_set_badge("faltas", rows.length, `vigilante${rows.length !== 1 ? "s" : ""}`);
		if (this._ob["faltas"].open) this._ob_render_faltas_table(true);
	}

	_ob_render_faltas_table(reset) {
		const state = this._ob["faltas"];
		if (reset) state.page = 0;

		const q = state.search.toLowerCase();
		const filtered = q
			? state.all_data.filter(r =>
				(r.nome_completo || "").toLowerCase().includes(q) ||
				(r.vigilante     || "").toLowerCase().includes(q) ||
				(r.posto         || "").toLowerCase().includes(q) ||
				(r.delegacao     || "").toLowerCase().includes(q)
			)
			: state.all_data;

		state.filtered  = filtered;
		const page_rows = filtered.slice(0, (state.page + 1) * this.PAGE_SIZE);
		const tbody     = this.page.body.find("#sx-ob-faltas-tbody")[0];
		if (!tbody) return;

		if (!page_rows.length) {
			tbody.innerHTML = `<tr><td colspan="6" class="sx-empty">Nenhum vigilante encontrado.</td></tr>`;
		} else {
			tbody.innerHTML = page_rows.map((r, i) => /* html */`
<tr class="sx-row">
  <td class="sx-td-date">${i + 1}</td>
  <td><a href="/app/vigilante/${r.vigilante}" class="sx-link">${r.vigilante}</a></td>
  <td>${r.nome_completo || "—"}</td>
  <td>${r.posto       || "—"}</td>
  <td>${r.delegacao   || "—"}</td>
  <td class="sx-td-num sx-faltas-high">${r.total_faltas}</td>
</tr>`).join("");
		}

		this._ob_update_footer("faltas", page_rows.length, filtered.length);
	}

	// ── Users table ───────────────────────────────────────────────────────────

	_render_users(rows) {
		const tbody = this.page.body.find("#sx-tbody-users")[0];
		const count = this.page.body.find("#sx-count-users")[0];
		if (!tbody) return;

		if (!rows?.length) {
			tbody.innerHTML = `<tr><td colspan="4" class="sx-empty">Sem utilizadores activos.</td></tr>`;
			if (count) count.textContent = "0 utilizadores";
			return;
		}

		tbody.innerHTML = rows.map(r => {
			const d = r.dias_desde_acesso;
			const badge = d === null
				? `<span class="sx-badge sx-badge--draft">Nunca</span>`
				: d === 0
				? `<span class="sx-badge sx-badge--paid">Hoje</span>`
				: d <= 3
				? `<span class="sx-badge sx-badge--paid">${d}d</span>`
				: d <= 14
				? `<span class="sx-badge sx-badge--unpaid">${d}d</span>`
				: `<span class="sx-badge sx-badge--overdue">${d}d</span>`;
			return /* html */`
<tr class="sx-row">
  <td><a href="/app/user/${r.user}" class="sx-link">${r.user}</a></td>
  <td>${r.full_name || "—"}</td>
  <td class="sx-td-date">${r.last_active ? frappe.format(r.last_active, { fieldtype: "Datetime" }) : "—"}</td>
  <td class="sx-td-num">${badge}</td>
</tr>`;
		}).join("");

		if (count) count.textContent = `${rows.length} utilizador${rows.length !== 1 ? "es" : ""}`;
	}

	// ── Chart factories ───────────────────────────────────────────────────────

	_chart_base(height) {
		return {
			chart: {
				height, toolbar: { show: false },
				fontFamily: "'Outfit', sans-serif",
				animations: { enabled: true, easing: "easeinout", speed: 500 },
				background: "transparent",
			},
			grid: {
				borderColor: "#E8E4DC",
				strokeDashArray: 3,
				padding: { left: 4, right: 8 },
				xaxis: { lines: { show: false } },
			},
			dataLabels: { enabled: false },
			tooltip: {
				style: { fontFamily: "'Outfit', sans-serif", fontSize: "12px" },
				y: { formatter: v => (v || 0).toLocaleString("pt-PT") },
			},
		};
	}

	_axis_style() {
		return { colors: "#9B9890", fontFamily: "'Outfit', sans-serif", fontSize: "11px", fontWeight: 500 };
	}

	_destroy(key) {
		if (this.charts[key]) { try { this.charts[key].destroy(); } catch (_) {} delete this.charts[key]; }
	}

	_make_chart(id, opts) {
		this._destroy(id);
		const el = this.page.body.find(`#${id}`)[0];
		if (!el) return;
		this.charts[id] = new ApexCharts(el, opts);
		this.charts[id].render();
	}

	_bar(el_id, data, color = "#E85D04", height = 260) {
		if (!data?.labels?.length) return;
		const base = this._chart_base(height);
		this._make_chart(el_id, {
			...base,
			series: [{ name: "Total", data: data.values }],
			chart:  { ...base.chart, type: "bar" },
			colors: [color],
			fill: { type: "gradient", gradient: { type: "vertical", shadeIntensity: .3, opacityFrom: 1, opacityTo: .72, stops: [0, 100] } },
			plotOptions: { bar: { borderRadius: 5, borderRadiusApplication: "end", columnWidth: "52%" } },
			dataLabels: {
				enabled: true,
				style: { fontSize: "10px", fontFamily: "'Outfit', sans-serif", fontWeight: "700", colors: ["rgba(255,255,255,.92)"] },
				formatter: v => v > 0 ? v.toLocaleString("pt-PT") : "",
				dropShadow: { enabled: false },
			},
			xaxis: { categories: data.labels, labels: { style: this._axis_style(), rotate: -30, hideOverlappingLabels: true }, axisBorder: { show: false }, axisTicks: { show: false } },
			yaxis: { labels: { style: this._axis_style(), formatter: v => Math.round(v) } },
		});
	}

	_line(el_id, data, color = "#E85D04", height = 260) {
		if (!data?.labels?.length) return;
		const base = this._chart_base(height);
		this._make_chart(el_id, {
			...base,
			series: [{ name: "Total", data: data.values }],
			chart:  { ...base.chart, type: "area" },
			colors: [color],
			fill: { type: "gradient", gradient: { opacityFrom: .22, opacityTo: .02, stops: [0, 90] } },
			stroke: { curve: "smooth", width: 2.5 },
			markers: { size: 0, hover: { size: 5 } },
			xaxis: { categories: data.labels, labels: { style: this._axis_style(), rotate: -30, hideOverlappingLabels: true }, axisBorder: { show: false }, axisTicks: { show: false } },
			yaxis: { labels: { style: this._axis_style(), formatter: v => Math.round(v) } },
		});
	}

	_hbar(el_id, data, color = "#E85D04", height = 260) {
		if (!data?.labels?.length) return;
		const dyn_height = Math.max(height, data.labels.length * 36 + 60);
		const base = this._chart_base(dyn_height);
		this._make_chart(el_id, {
			...base,
			series: [{ name: "Total", data: data.values }],
			chart:  { ...base.chart, type: "bar" },
			colors: [color],
			fill: { type: "gradient", gradient: { type: "horizontal", shadeIntensity: .2, opacityFrom: 1, opacityTo: .78, stops: [0, 100] } },
			plotOptions: { bar: { horizontal: true, borderRadius: 5, borderRadiusApplication: "end", barHeight: "52%", dataLabels: { position: "right" } } },
			dataLabels: {
				enabled: true, textAnchor: "start", offsetX: 6,
				style: { fontSize: "11px", fontFamily: "'Outfit', sans-serif", fontWeight: "700", colors: ["#3D3A35"] },
				formatter: v => v > 0 ? v.toLocaleString("pt-PT") : "",
				dropShadow: { enabled: false },
			},
			xaxis: { categories: data.labels, labels: { style: this._axis_style() }, axisBorder: { show: false }, axisTicks: { show: false } },
			yaxis: { labels: { style: { ...this._axis_style(), colors: "#3D3A35", fontWeight: 500 } } },
		});
	}

	_dual_bar(el_id, data, height = 300) {
		if (!data?.labels?.length) return;
		const base = this._chart_base(height);
		this._make_chart(el_id, {
			...base,
			series: [{ name: "Admitidos", data: data.admitidos }, { name: "Demitidos", data: data.demitidos }],
			chart:  { ...base.chart, type: "bar" },
			colors: ["#059669", "#DC2626"],
			fill: { type: "gradient", gradient: { type: "vertical", shadeIntensity: .3, opacityFrom: 1, opacityTo: .72, stops: [0, 100] } },
			plotOptions: { bar: { borderRadius: 4, borderRadiusApplication: "end", columnWidth: "52%", grouped: true } },
			dataLabels: {
				enabled: true,
				style: { fontSize: "10px", fontFamily: "'Outfit', sans-serif", fontWeight: "700", colors: ["rgba(255,255,255,.92)"] },
				formatter: v => v > 0 ? v.toLocaleString("pt-PT") : "",
				dropShadow: { enabled: false },
			},
			xaxis: { categories: data.labels, labels: { style: this._axis_style(), rotate: -30 }, axisBorder: { show: false }, axisTicks: { show: false } },
			yaxis: { labels: { style: this._axis_style(), formatter: v => Math.round(v) } },
			legend: { position: "top", fontFamily: "'Outfit', sans-serif", fontSize: "12px", fontWeight: 600, markers: { width: 8, height: 8, radius: 4 }, itemMargin: { horizontal: 10 } },
		});
	}

	_stacked_bar(el_id, data, height = 320) {
		if (!data?.labels?.length || !data?.series?.length) return;
		const palette = ["#E85D04","#2563EB","#059669","#D97706","#7C3AED","#DC2626","#0891B2","#EA580C","#16A34A","#9333EA"];
		const base = this._chart_base(height);
		this._make_chart(el_id, {
			...base,
			series: data.series,
			chart:  { ...base.chart, type: "bar", stacked: true },
			colors: data.series.map((_, i) => palette[i % palette.length]),
			plotOptions: { bar: { columnWidth: "58%", borderRadius: 0 } },
			xaxis: { categories: data.labels, labels: { style: this._axis_style(), rotate: -30 }, axisBorder: { show: false }, axisTicks: { show: false } },
			yaxis: { labels: { style: this._axis_style(), formatter: v => Math.round(v) } },
			legend: { position: "bottom", fontFamily: "'Outfit', sans-serif", fontSize: "11px", fontWeight: 600, markers: { width: 8, height: 8, radius: 4 }, itemMargin: { horizontal: 6 } },
		});
	}

	// ── Utilities ─────────────────────────────────────────────────────────────

	_export_faltas() {
		const data = this._ob["faltas"].all_data || [];
		if (!data.length) return;
		const hdr  = ["Vigilante","Nome","Posto","Delegação","Total Faltas"];
		const rows = data.map(r => [r.vigilante, r.nome_completo, r.posto, r.delegacao, r.total_faltas]);
		const csv  = [hdr, ...rows].map(r => r.map(v => `"${v ?? ""}"`).join(",")).join("\n");
		const a    = Object.assign(document.createElement("a"), {
			href:     URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
			download: `sixs_faltas_${frappe.datetime.get_today()}.csv`,
		});
		document.body.appendChild(a); a.click(); document.body.removeChild(a);
	}

	_show_loading(on) {
		const el = this.page.body.find("#sx-loading")[0];
		if (el) el.style.display = on ? "flex" : "none";
	}
}
