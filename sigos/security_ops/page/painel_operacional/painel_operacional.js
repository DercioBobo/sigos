frappe.provide("sigos");

frappe.pages["painel-operacional"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Painel Operacional CCO"),
		single_column: true,
	});
	wrapper.painel = new sigos.PainelOperacional(page, wrapper);
};

frappe.pages["painel-operacional"].on_page_show = function (wrapper) {
	if (wrapper.painel) wrapper.painel.on_show();
};

sigos.PainelOperacional = class PainelOperacional {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.state = {
			data: frappe.datetime.get_today(),
			delegacao: null,
			cliente: null,
			posto: null,
			busca: "",
			filtro: "todos", // todos | atencao | descobertos | ok
			auto: true,
		};
		this._dirty_timer = null;
		this._inject_css();
		this._build_shell();
		this._build_controls();
		this._subscribe_realtime();
		this.refresh();
	}

	on_show() {
		// Re-fetch when the user comes back to the page (data may have moved on).
		this.refresh();
	}

	// ───────────────────────────────────────────────────────── shell + controls

	_build_shell() {
		this.page.main.addClass("sigos-painel");
		this.$body = $(`
			<div class="po-root">
				<div class="po-toolbar"></div>
				<div class="po-kpis"></div>
				<div class="po-chips"></div>
				<div class="po-layout">
					<div class="po-board"><div class="po-loading">${__("A carregar...")}</div></div>
					<aside class="po-side"></aside>
				</div>
			</div>
		`).appendTo(this.page.main);

		this.$toolbar = this.$body.find(".po-toolbar");
		this.$kpis = this.$body.find(".po-kpis");
		this.$chips = this.$body.find(".po-chips");
		this.$board = this.$body.find(".po-board");
		this.$side = this.$body.find(".po-side");
	}

	_build_controls() {
		// Date stepper
		const $date = $(`
			<div class="po-datebar">
				<button class="po-nav" data-step="-1" title="${__("Dia anterior")}">&#8249;</button>
				<div class="po-date-wrap"></div>
				<button class="po-nav" data-step="1" title="${__("Dia seguinte")}">&#8250;</button>
				<button class="po-today">${__("Hoje")}</button>
			</div>
		`).appendTo(this.$toolbar);

		this.f_data = frappe.ui.form.make_control({
			df: { fieldtype: "Date", label: "", placeholder: __("Data") },
			parent: $date.find(".po-date-wrap").get(0),
			render_input: true,
		});
		this.f_data.set_value(this.state.data);
		this.f_data.$input.on("change", () => {
			const v = this.f_data.get_value();
			if (v) { this.state.data = v; this.refresh(); }
		});
		$date.find(".po-nav").on("click", (e) => {
			const step = parseInt($(e.currentTarget).data("step"), 10);
			this.state.data = frappe.datetime.add_days(this.state.data, step);
			this.f_data.set_value(this.state.data);
			this.refresh();
		});
		$date.find(".po-today").on("click", () => {
			this.state.data = frappe.datetime.get_today();
			this.f_data.set_value(this.state.data);
			this.refresh();
		});

		// Filters
		const $filters = $(`<div class="po-filters"></div>`).appendTo(this.$toolbar);
		this.f_deleg = this._link_filter($filters, "Delegacao", __("Delegação"), "delegacao");
		this.f_cli = this._link_filter($filters, "Customer", __("Cliente"), "cliente");
		this.f_posto = this._link_filter($filters, "Posto De Vigilancia", __("Posto"), "posto");

		// Search
		const $search = $(`
			<div class="po-search">
				<span class="po-search-ico">&#128269;</span>
				<input type="text" placeholder="${__("Procurar posto, vigilante, n.o mec...")}" />
			</div>
		`).appendTo($filters);
		this.$search = $search.find("input");
		this.$search.on("input", frappe.utils.debounce(() => {
			this.state.busca = this.$search.val();
			this.render();
		}, 250));

		// Live controls
		const $live = $(`
			<div class="po-live">
				<label class="po-auto"><input type="checkbox" ${this.state.auto ? "checked" : ""}/> <span class="po-dot"></span> ${__("Ao vivo")}</label>
				<span class="po-stamp"></span>
				<button class="po-refresh" title="${__("Actualizar")}">&#10227;</button>
			</div>
		`).appendTo(this.$toolbar);
		this.$stamp = $live.find(".po-stamp");
		$live.find(".po-auto input").on("change", (e) => {
			this.state.auto = e.target.checked;
			this._toggle_auto();
		});
		$live.find(".po-refresh").on("click", () => this.refresh());
		this._toggle_auto();
	}

	_link_filter($parent, doctype, label, key) {
		const $wrap = $(`<div class="po-filter"></div>`).appendTo($parent);
		const ctrl = frappe.ui.form.make_control({
			df: {
				fieldtype: "Link", options: doctype, label: "", placeholder: label,
				onchange: () => { this.state[key] = ctrl.get_value() || null; this.refresh(); },
			},
			parent: $wrap.get(0),
			render_input: true,
		});
		return ctrl;
	}

	// ─────────────────────────────────────────────────────────── data + render

	refresh() {
		if (this._loading) return;
		this._loading = true;
		this.$board.find(".po-loading").remove();
		this.page.main.find(".po-toolbar").addClass("po-busy");
		frappe.call({
			method: "sigos.painel.painel_operacional",
			args: {
				data: this.state.data,
				delegacao: this.state.delegacao,
				cliente: this.state.cliente,
				posto: this.state.posto,
			},
			callback: (r) => {
				this._loading = false;
				this.page.main.find(".po-toolbar").removeClass("po-busy");
				if (!r.message) return;
				this.data = r.message;
				this.render();
				this._stamp();
			},
			error: () => {
				this._loading = false;
				this.page.main.find(".po-toolbar").removeClass("po-busy");
			},
		});
	}

	render() {
		if (!this.data) return;
		this._render_kpis();
		this._render_chips();
		this._render_board();
		this._render_side();
	}

	_render_kpis() {
		const k = this.data.kpis;
		const ring = this._coverage_ring(k.taxa_cobertura);
		const tiles = [
			{ cls: "k-cob", val: k.postos_cobertos, lbl: __("Cobertos") },
			{ cls: "k-lac", val: k.postos_com_lacuna, lbl: __("Com lacuna") },
			{ cls: "k-desc", val: k.postos_descobertos, lbl: __("Descobertos") },
			{ cls: "k-falta", val: k.faltas, lbl: __("Faltas") },
			{ cls: "k-sub", val: k.substituidos, lbl: __("Substituidos") },
			{ cls: "k-fer", val: k.ferias, lbl: __("Ferias") },
			{ cls: "k-res", val: k.reserva_disponivel, lbl: __("Reserva") },
			{ cls: "k-oc", val: k.ocorrencias_abertas, lbl: __("Ocorr. abertas") },
		];
		this.$kpis.html(`
			<div class="po-ring-card">
				${ring}
				<div class="po-ring-meta">
					<div class="po-ring-lbl">${__("Cobertura")}</div>
					<div class="po-ring-sub">${k.escalados} ${__("escalados")} &middot; ${k.postos_total} ${__("postos")}</div>
				</div>
			</div>
			<div class="po-tiles">
				${tiles.map((t) => `
					<div class="po-tile ${t.cls}">
						<div class="po-tile-val">${t.val}</div>
						<div class="po-tile-lbl">${t.lbl}</div>
					</div>`).join("")}
			</div>
		`);
	}

	_coverage_ring(pct) {
		const tone = pct >= 95 ? "ok" : pct >= 85 ? "warn" : "bad";
		return `
			<div class="po-ring po-ring-${tone}" style="--pct:${pct}">
				<div class="po-ring-hole"><span>${pct}<small>%</small></span></div>
			</div>`;
	}

	_render_chips() {
		const k = this.data.kpis;
		const defs = [
			{ key: "todos", lbl: __("Todos"), n: k.postos_total },
			{ key: "atencao", lbl: __("Com lacuna"), n: k.postos_com_lacuna },
			{ key: "descobertos", lbl: __("Descobertos"), n: k.postos_descobertos },
			{ key: "ok", lbl: __("OK"), n: k.postos_cobertos },
		];
		this.$chips.html(defs.map((d) => `
			<button class="po-chip ${this.state.filtro === d.key ? "active" : ""} chip-${d.key}" data-k="${d.key}">
				${d.lbl} <b>${d.n}</b>
			</button>`).join(""));
		this.$chips.find(".po-chip").on("click", (e) => {
			this.state.filtro = $(e.currentTarget).data("k");
			this._render_chips();
			this._render_board();
		});
	}

	_board_cards() {
		let cards = this.data.postos || [];
		const f = this.state.filtro;
		if (f === "atencao") cards = cards.filter((c) => c.cobertura === "lacuna");
		else if (f === "descobertos") cards = cards.filter((c) => c.cobertura === "descoberto" || c.cobertura === "sem_escala");
		else if (f === "ok") cards = cards.filter((c) => c.cobertura === "coberto");

		const t = (this.state.busca || "").trim().toLowerCase();
		if (t) {
			cards = cards.map((c) => {
				if ((c.posto || "").toLowerCase().includes(t) || (c.nome || "").toLowerCase().includes(t)) return c;
				const g = c.guardas.filter((x) =>
					(x.nome || "").toLowerCase().includes(t) ||
					(x.vigilante || "").toLowerCase().includes(t) ||
					(x.mecanografico || "").toLowerCase().includes(t));
				return g.length ? Object.assign({}, c, { guardas: g }) : null;
			}).filter(Boolean);
		}
		return cards;
	}

	_render_board() {
		const cards = this._board_cards();
		if (!cards.length) {
			this.$board.html(`<div class="po-empty">${__("Sem postos para os filtros actuais.")}</div>`);
			return;
		}
		this.$board.html(`<div class="po-grid">${cards.map((c) => this._posto_card(c)).join("")}</div>`);

		this.$board.find("[data-posto]").on("click", (e) => {
			if ($(e.target).closest("[data-vig]").length) return;
			frappe.set_route("Form", "Posto De Vigilancia", $(e.currentTarget).data("posto"));
		});
		this.$board.find("[data-vig]").on("click", (e) => {
			e.stopPropagation();
			frappe.set_route("Form", "Vigilante", $(e.currentTarget).data("vig"));
		});
	}

	_posto_card(c) {
		const badge = c.slots ? `${c.slots - c.gaps}/${c.slots}` : "0/0";
		const periodos = ["Manhã", "Tarde", "Noite"];
		const grupos = {};
		c.guardas.forEach((g) => { (grupos[g.periodo] = grupos[g.periodo] || []).push(g); });

		const cols = periodos
			.filter((p) => grupos[p])
			.map((p) => `
				<div class="po-per">
					<div class="po-per-h">${p}</div>
					${grupos[p].map((g) => this._guard_row(g)).join("")}
				</div>`).join("");

		const extra_periods = Object.keys(grupos).filter((p) => !periodos.includes(p));
		const extra = extra_periods.map((p) => `
			<div class="po-per">
				<div class="po-per-h">${frappe.utils.escape_html(p)}</div>
				${grupos[p].map((g) => this._guard_row(g)).join("")}
			</div>`).join("");

		const body = (cols + extra) || `<div class="po-no-sched">${__("Sem escala neste dia")}</div>`;
		const tipo = c.tipo === "Temporário" ? `<span class="po-tag-temp">${__("Temp")}</span>` : "";

		return `
			<div class="po-card cov-${c.cobertura}" data-posto="${frappe.utils.escape_html(c.posto)}">
				<div class="po-card-h">
					<div class="po-card-id">
						<span class="po-code">${frappe.utils.escape_html(c.posto)}</span>
						<span class="po-pname">${frappe.utils.escape_html(c.nome || "")}</span>
					</div>
					<div class="po-card-meta">
						${tipo}
						<span class="po-badge b-${c.cobertura}">${badge}</span>
					</div>
				</div>
				<div class="po-card-sub">
					${c.delegacao ? `<span class="po-mchip">${frappe.utils.escape_html(c.delegacao)}</span>` : ""}
					${c.cliente ? `<span class="po-mchip dim">${frappe.utils.escape_html(c.cliente)}</span>` : ""}
				</div>
				<div class="po-card-b">${body}</div>
			</div>`;
	}

	_guard_row(g) {
		const sub = g.cobre_nome
			? `<span class="po-cover">&#8594; ${frappe.utils.escape_html(g.cobre_nome)}</span>` : "";
		const mec = g.mecanografico ? `<span class="po-mec">${frappe.utils.escape_html(g.mecanografico)}</span>` : "";
		return `
			<div class="po-guard st-${g.estado}" data-vig="${frappe.utils.escape_html(g.vigilante)}" title="${this._estado_label(g.estado)}">
				<span class="po-gdot"></span>
				<span class="po-gname">${frappe.utils.escape_html(g.nome || g.vigilante)}</span>
				${mec}
				${g.turno ? `<span class="po-turno">${frappe.utils.escape_html(g.turno)}</span>` : ""}
				${sub}
			</div>`;
	}

	_estado_label(e) {
		return {
			presente: __("Presente"), falta: __("Falta"), ferias: __("Ferias"),
			substituido: __("Substituido"), atraso: __("Atraso / saida antecipada"),
		}[e] || e;
	}

	// ───────────────────────────────────────────────────────────────── sidebar

	_render_side() {
		const cards = this.data.postos || [];
		const atencao = cards.filter((c) => c.cobertura !== "coberto").slice(0, 40);
		const res = this.data.reserva || [];
		const oc = this.data.ocorrencias || [];

		this.$side.html(`
			<section class="po-panel">
				<h3>${__("Precisa de atencao")} <span class="po-pn">${atencao.length}</span></h3>
				<div class="po-panel-b">
					${atencao.length ? atencao.map((c) => `
						<div class="po-mini cov-${c.cobertura}" data-posto="${frappe.utils.escape_html(c.posto)}">
							<span class="po-mini-code">${frappe.utils.escape_html(c.posto)}</span>
							<span class="po-mini-name">${frappe.utils.escape_html(c.nome || "")}</span>
							<span class="po-mini-badge b-${c.cobertura}">${c.slots ? (c.slots - c.gaps) + "/" + c.slots : "0/0"}</span>
						</div>`).join("") : `<div class="po-mt">${__("Tudo coberto.")}</div>`}
				</div>
			</section>
			<section class="po-panel">
				<h3>${__("Reserva disponivel")} <span class="po-pn">${res.length}</span></h3>
				<div class="po-panel-b">
					${res.length ? res.slice(0, 60).map((v) => `
						<div class="po-mini" data-vig="${frappe.utils.escape_html(v.name)}">
							<span class="po-gdot st-reserva"></span>
							<span class="po-mini-name">${frappe.utils.escape_html(v.nome_completo || v.name)}</span>
							${v.delegacao ? `<span class="po-mchip dim">${frappe.utils.escape_html(v.delegacao)}</span>` : ""}
						</div>`).join("") + (res.length > 60 ? `<div class="po-mt">+${res.length - 60} ${__("mais")}</div>` : "")
						: `<div class="po-mt">${__("Sem vigilantes na reserva.")}</div>`}
				</div>
			</section>
			<section class="po-panel">
				<h3>${__("Ocorrencias de hoje")} <span class="po-pn">${oc.length}</span></h3>
				<div class="po-panel-b">
					${oc.length ? oc.map((o) => `
						<div class="po-oc grav-${this._grav_key(o.gravidade)}" data-oc="${frappe.utils.escape_html(o.name)}">
							<span class="po-oc-grav"></span>
							<div class="po-oc-body">
								<div class="po-oc-top">${frappe.utils.escape_html(o.assunto || o.name)}</div>
								<div class="po-oc-meta">${frappe.utils.escape_html(o.tipo || "")}${o.posto_nome ? " &middot; " + frappe.utils.escape_html(o.posto_nome) : ""} &middot; <span class="po-oc-estado">${frappe.utils.escape_html(o.estado || "")}</span></div>
							</div>
						</div>`).join("") : `<div class="po-mt">${__("Sem ocorrencias registadas hoje.")}</div>`}
				</div>
				<button class="po-add-oc">+ ${__("Registar ocorrencia")}</button>
			</section>
		`);

		this.$side.find("[data-posto]").on("click", (e) =>
			frappe.set_route("Form", "Posto De Vigilancia", $(e.currentTarget).data("posto")));
		this.$side.find("[data-vig]").on("click", (e) =>
			frappe.set_route("Form", "Vigilante", $(e.currentTarget).data("vig")));
		this.$side.find("[data-oc]").on("click", (e) =>
			frappe.set_route("Form", "Ocorrencia", $(e.currentTarget).data("oc")));
		this.$side.find(".po-add-oc").on("click", () => {
			const r = {};
			if (this.state.delegacao) r.delegacao = this.state.delegacao;
			if (this.state.posto) r.posto = this.state.posto;
			frappe.new_doc("Ocorrencia", r);
		});
	}

	_grav_key(g) {
		return { "Crítica": "critica", "Alta": "alta", "Média": "media", "Baixa": "baixa" }[g] || "media";
	}

	// ──────────────────────────────────────────────────────────── live / utils

	_subscribe_realtime() {
		frappe.realtime.on("sigos_painel_operacional", () => {
			if (!this.state.auto) return;
			clearTimeout(this._dirty_timer);
			this._dirty_timer = setTimeout(() => this.refresh(), 1500);
		});
	}

	_toggle_auto() {
		clearInterval(this._poll);
		this.$body.toggleClass("po-live-on", this.state.auto);
		if (this.state.auto) {
			this._poll = setInterval(() => {
				if (this.state.auto && this.wrapper.offsetParent !== null) this.refresh();
			}, 60000);
		}
	}

	_stamp() {
		const now = frappe.datetime.str_to_user(this.data.gerado_em);
		this.$stamp.text(__("Actualizado") + " " + (now || "").split(" ").slice(1).join(" "));
	}

	_inject_css() {
		if (document.getElementById("sigos-painel-css")) return;
		const css = `
.sigos-painel { background: #0b0e13; }
.layout-main-section-wrapper:has(.sigos-painel), .page-body:has(.sigos-painel) { background:#0b0e13; }
.po-root { color:#c9d4e3; font-feature-settings:"tnum" 1; padding:4px 2px 40px; }
.po-root .po-code, .po-root .po-mec, .po-root .po-turno, .po-root .po-mini-code, .po-root .po-tile-val, .po-root .po-ring-hole span { font-family: ui-monospace, "SFMono-Regular", "Cascadia Code", Menlo, Consolas, monospace; }

/* Toolbar */
.po-toolbar { display:flex; flex-wrap:wrap; gap:10px 14px; align-items:center; padding:10px 12px; background:linear-gradient(180deg,#141a23,#10151d); border:1px solid #1f2935; border-radius:12px; }
.po-toolbar.po-busy { opacity:.8; }
.po-datebar { display:flex; align-items:center; gap:6px; }
.po-nav, .po-today, .po-refresh { background:#1b2430; color:#c9d4e3; border:1px solid #2a3a4d; border-radius:8px; cursor:pointer; height:30px; }
.po-nav { width:30px; font-size:18px; line-height:1; }
.po-today { padding:0 10px; font-size:12px; }
.po-nav:hover, .po-today:hover, .po-refresh:hover { border-color:#3aa0ff; color:#eaf2fb; }
.po-date-wrap .control-input input, .po-date-wrap input { background:#1b2430; color:#eaf2fb; border:1px solid #2a3a4d; height:30px; min-width:130px; }
.po-filters { display:flex; flex-wrap:wrap; gap:8px; align-items:center; flex:1; }
.po-filter { min-width:150px; }
.po-filter .control-input input { background:#1b2430; color:#eaf2fb; border:1px solid #2a3a4d; height:30px; }
.po-search { display:flex; align-items:center; gap:6px; background:#1b2430; border:1px solid #2a3a4d; border-radius:8px; padding:0 10px; height:30px; }
.po-search input { background:transparent; border:0; outline:0; color:#eaf2fb; width:210px; }
.po-search-ico { opacity:.6; font-size:13px; }
.po-live { display:flex; align-items:center; gap:12px; margin-left:auto; }
.po-auto { display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; margin:0; color:#8aa0b8; }
.po-dot { width:9px; height:9px; border-radius:50%; background:#3b4a5c; display:inline-block; }
.po-live-on .po-dot { background:#2ec36b; box-shadow:0 0 0 0 rgba(46,195,107,.6); animation:po-pulse 2s infinite; }
@keyframes po-pulse { 0%{box-shadow:0 0 0 0 rgba(46,195,107,.5);} 70%{box-shadow:0 0 0 7px rgba(46,195,107,0);} 100%{box-shadow:0 0 0 0 rgba(46,195,107,0);} }
.po-stamp { font-size:11px; color:#6b7e93; }
.po-refresh { width:32px; font-size:15px; }

/* KPI strip */
.po-kpis { display:flex; gap:12px; margin-top:14px; flex-wrap:wrap; }
.po-ring-card { display:flex; align-items:center; gap:14px; background:linear-gradient(180deg,#141a23,#10151d); border:1px solid #1f2935; border-radius:14px; padding:14px 20px; }
.po-ring { --pct:0; width:84px; height:84px; border-radius:50%; display:grid; place-items:center;
	background: conic-gradient(var(--ring) calc(var(--pct)*1%), #202a37 0); }
.po-ring-ok { --ring:#2ec36b; } .po-ring-warn { --ring:#f5a623; } .po-ring-bad { --ring:#ef4444; }
.po-ring-hole { width:62px; height:62px; border-radius:50%; background:#10151d; display:grid; place-items:center; }
.po-ring-hole span { font-size:22px; font-weight:600; color:#eaf2fb; } .po-ring-hole small { font-size:11px; color:#8aa0b8; }
.po-ring-lbl { font-size:13px; letter-spacing:.12em; text-transform:uppercase; color:#8aa0b8; }
.po-ring-sub { font-size:12px; color:#6b7e93; margin-top:3px; }
.po-tiles { display:grid; grid-template-columns:repeat(4,minmax(86px,1fr)); gap:10px; flex:1; }
.po-tile { background:linear-gradient(180deg,#141a23,#10151d); border:1px solid #1f2935; border-left-width:3px; border-radius:12px; padding:10px 12px; }
.po-tile-val { font-size:24px; font-weight:600; color:#eaf2fb; line-height:1.1; }
.po-tile-lbl { font-size:11px; color:#8aa0b8; text-transform:uppercase; letter-spacing:.06em; margin-top:2px; }
.po-tile.k-cob { border-left-color:#2ec36b; } .po-tile.k-lac { border-left-color:#f5a623; }
.po-tile.k-desc { border-left-color:#ef4444; } .po-tile.k-falta { border-left-color:#ef4444; }
.po-tile.k-sub { border-left-color:#a877ff; } .po-tile.k-fer { border-left-color:#3aa0ff; }
.po-tile.k-res { border-left-color:#16c2c2; } .po-tile.k-oc { border-left-color:#f5a623; }

/* Filter chips */
.po-chips { display:flex; gap:8px; margin:16px 0 10px; flex-wrap:wrap; }
.po-chip { background:#141a23; border:1px solid #243140; color:#9fb1c6; border-radius:999px; padding:5px 14px; font-size:12px; cursor:pointer; }
.po-chip b { color:#eaf2fb; margin-left:4px; }
.po-chip:hover { border-color:#3aa0ff; }
.po-chip.active { background:#1c2a3a; border-color:#3aa0ff; color:#eaf2fb; }
.po-chip.chip-descobertos.active { background:#2a1518; border-color:#ef4444; }
.po-chip.chip-atencao.active { background:#2a2310; border-color:#f5a623; }
.po-chip.chip-ok.active { background:#13241a; border-color:#2ec36b; }

/* Layout */
.po-layout { display:grid; grid-template-columns:1fr 320px; gap:16px; align-items:start; }
@media (max-width:1100px){ .po-layout { grid-template-columns:1fr; } }
.po-loading, .po-empty, .po-mt { color:#6b7e93; padding:24px; text-align:center; font-size:13px; }

/* Board */
.po-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:14px; }
.po-card { background:linear-gradient(180deg,#141a23,#10151d); border:1px solid #1f2935; border-top:3px solid #2a3a4d; border-radius:14px; padding:12px 14px; cursor:pointer; transition:transform .08s ease, border-color .12s ease, box-shadow .12s ease; }
.po-card:hover { transform:translateY(-2px); box-shadow:0 8px 24px rgba(0,0,0,.4); }
.po-card.cov-coberto { border-top-color:#2ec36b; }
.po-card.cov-lacuna { border-top-color:#f5a623; }
.po-card.cov-descoberto, .po-card.cov-sem_escala { border-top-color:#ef4444; }
.po-card-h { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
.po-card-id { display:flex; flex-direction:column; gap:1px; min-width:0; }
.po-code { font-size:14px; font-weight:600; color:#eaf2fb; }
.po-pname { font-size:12px; color:#8aa0b8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px; }
.po-card-meta { display:flex; align-items:center; gap:6px; }
.po-badge { font-size:13px; font-weight:600; border-radius:7px; padding:2px 8px; background:#202a37; color:#c9d4e3; }
.po-badge.b-coberto { background:#13351f; color:#5be09a; }
.po-badge.b-lacuna { background:#3a2e10; color:#ffce6b; }
.po-badge.b-descoberto, .po-badge.b-sem_escala { background:#3a1417; color:#ff8a8a; }
.po-tag-temp { font-size:10px; text-transform:uppercase; letter-spacing:.05em; background:#2a2034; color:#cba6ff; border-radius:5px; padding:2px 6px; }
.po-card-sub { display:flex; gap:6px; margin:8px 0 4px; flex-wrap:wrap; }
.po-mchip { font-size:10.5px; background:#1a2330; color:#9fb1c6; border-radius:5px; padding:2px 7px; }
.po-mchip.dim { color:#6b7e93; }
.po-card-b { display:flex; flex-direction:column; gap:8px; margin-top:6px; }
.po-per-h { font-size:10px; text-transform:uppercase; letter-spacing:.1em; color:#6b7e93; margin:4px 0 3px; border-bottom:1px dashed #202a37; padding-bottom:3px; }
.po-no-sched { font-size:12px; color:#6b7e93; font-style:italic; padding:6px 0; }

/* Guard row */
.po-guard { display:flex; align-items:center; gap:7px; padding:4px 6px; border-radius:7px; font-size:12.5px; cursor:pointer; }
.po-guard:hover { background:#1a2330; }
.po-gdot { width:8px; height:8px; border-radius:50%; flex:none; background:#3b4a5c; }
.st-presente .po-gdot { background:#2ec36b; }
.st-falta .po-gdot { background:#ef4444; }
.st-ferias .po-gdot { background:#3aa0ff; }
.st-substituido .po-gdot { background:#a877ff; }
.st-atraso .po-gdot { background:#f5a623; }
.po-gdot.st-reserva { background:#16c2c2; }
.po-gname { color:#dbe5f1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; min-width:0; }
.st-falta .po-gname { color:#ff9b9b; }
.po-mec { font-size:10.5px; color:#6b7e93; }
.po-turno { font-size:10px; color:#9fb1c6; background:#1a2330; border-radius:4px; padding:1px 6px; }
.po-cover { font-size:11px; color:#bfa0ff; white-space:nowrap; }

/* Sidebar */
.po-side { display:flex; flex-direction:column; gap:14px; position:sticky; top:8px; }
.po-panel { background:linear-gradient(180deg,#141a23,#10151d); border:1px solid #1f2935; border-radius:14px; overflow:hidden; }
.po-panel h3 { font-size:12px; text-transform:uppercase; letter-spacing:.1em; color:#8aa0b8; margin:0; padding:12px 14px 8px; display:flex; align-items:center; gap:8px; }
.po-pn { background:#1c2a3a; color:#9fc6ff; border-radius:999px; font-size:11px; padding:1px 8px; }
.po-panel-b { max-height:340px; overflow:auto; padding:0 8px 8px; }
.po-mini { display:flex; align-items:center; gap:8px; padding:7px 8px; border-radius:8px; cursor:pointer; font-size:12.5px; }
.po-mini:hover { background:#1a2330; }
.po-mini.cov-lacuna { border-left:2px solid #f5a623; }
.po-mini.cov-descoberto, .po-mini.cov-sem_escala { border-left:2px solid #ef4444; }
.po-mini-code { font-size:12px; color:#eaf2fb; font-weight:600; }
.po-mini-name { color:#bccadb; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.po-mini-badge { font-size:11px; border-radius:6px; padding:1px 7px; background:#202a37; }
.po-oc { display:flex; gap:9px; padding:8px; border-radius:8px; cursor:pointer; }
.po-oc:hover { background:#1a2330; }
.po-oc-grav { width:6px; border-radius:3px; flex:none; }
.grav-critica .po-oc-grav { background:#ff3b3b; } .grav-alta .po-oc-grav { background:#f5662a; }
.grav-media .po-oc-grav { background:#f5a623; } .grav-baixa .po-oc-grav { background:#3aa0ff; }
.po-oc-top { font-size:12.5px; color:#eaf2fb; }
.po-oc-meta { font-size:11px; color:#7c8ea3; margin-top:2px; }
.po-oc-estado { color:#9fb1c6; }
.po-add-oc { width:calc(100% - 16px); margin:0 8px 10px; background:#16202c; color:#9fc6ff; border:1px dashed #2a3a4d; border-radius:8px; padding:7px; font-size:12px; cursor:pointer; }
.po-add-oc:hover { border-color:#3aa0ff; color:#eaf2fb; }
`;
		const style = document.createElement("style");
		style.id = "sigos-painel-css";
		style.textContent = css;
		document.head.appendChild(style);
	}
};
