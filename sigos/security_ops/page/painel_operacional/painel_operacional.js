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
		this._inject_fonts();
		this._inject_css();
		this._build_shell();
		this._build_controls();
		this._subscribe_realtime();
		this.refresh();
	}

	on_show() {
		// Re-fetch when the user comes back to the page (data may have moved on).
		this._close_modal();
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

		// Primary action
		$(`<button class="po-act-aus">+ ${__("Registar ausência")}</button>`)
			.appendTo($filters)
			.on("click", () => this._registar_ausencia());

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
			{ cls: "k-desc", val: k.postos_descobertos, lbl: __("Sem Cobertura") },
			{ cls: "k-falta", val: k.faltas, lbl: __("Faltas") },
			{ cls: "k-sub", val: k.substituidos, lbl: __("Substituidos") },
			{ cls: "k-fer", val: k.ferias, lbl: __("Ferias") },
			{ cls: "k-res", val: k.reserva_disponivel, lbl: __("Reserva") },
			{ cls: "k-oc", val: k.ocorrencias_abertas, lbl: __("Ocorr. abertas") },
		];
		this.$kpis.html(`
			<div class="po-ring-card">
				${ring}
				<div class="po-ring-info">
					<div class="po-ring-meta">
						<div class="po-ring-lbl">${__("Cobertura")}</div>
						<div class="po-ring-sub">${k.escalados} ${__("escalados")} &middot; ${k.postos_total} ${__("postos")}</div>
					</div>
					${this._sparkline_html()}
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

	// 7-day coverage trend (from painel.py _sparkline) — a compact bar sparkline
	// under the ring. Nulls (days with no escala) render as a hatched ghost bar.
	_sparkline_html() {
		const spark = this.data.sparkline || [];
		if (!spark.length) return "";
		const vals = spark.map((s) => s.pct).filter((v) => v !== null && v !== undefined);
		const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
		const bars = spark.map((s, i) => {
			const last = i === spark.length - 1 ? " is-today" : "";
			const wd = this._wd(s.data);
			if (s.pct === null || s.pct === undefined) {
				return `<span class="po-sbar po-sbar-void${last}" title="${this._fmt_day(s.data)}: ${__("sem escala")}"><i style="--h:8%"></i><em>${wd}</em></span>`;
			}
			const tone = s.pct >= 95 ? "ok" : s.pct >= 85 ? "warn" : "bad";
			const h = Math.max(8, Math.round(s.pct));
			return `<span class="po-sbar tone-${tone}${last}" title="${this._fmt_day(s.data)}: ${s.pct}%"><i style="--h:${h}%"></i><em>${wd}</em></span>`;
		}).join("");
		return `
			<div class="po-spark">
				<div class="po-spark-h">${__("Cobertura 7 dias")}${avg !== null ? `<span class="po-spark-avg">${__("media")} ${avg}%</span>` : ""}</div>
				<div class="po-spark-bars">${bars}</div>
			</div>`;
	}

	_wd(iso) {
		const dt = new Date(iso + "T00:00:00");
		return ["D", "S", "T", "Q", "Q", "S", "S"][dt.getDay()] || "";
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
			{ key: "descobertos", lbl: __("Sem Cobertura"), n: k.postos_descobertos },
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
			this._abrir_posto($(e.currentTarget).data("posto"));
		});
		this.$board.find("[data-vig]").on("click", (e) => {
			e.stopPropagation();
			this._abrir_vigilante($(e.currentTarget).data("vig"));
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
			this._abrir_posto($(e.currentTarget).data("posto")));
		this.$side.find("[data-vig]").on("click", (e) =>
			this._abrir_vigilante($(e.currentTarget).data("vig")));
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

	// ─────────────────────────────────────────────────────── modals (week view)

	_registar_ausencia() {
		frappe.new_doc("Ausencias", { data: this.state.data });
	}

	_modal_shell() {
		this._close_modal();
		this.$modal = $(`
			<div class="po-modal-back">
				<div class="po-modal">
					<div class="po-modal-h">
						<div class="po-modal-title"></div>
						<div class="po-modal-actions"></div>
						<button class="po-modal-x" title="${__("Fechar")}">&times;</button>
					</div>
					<div class="po-modal-b"></div>
				</div>
			</div>`).appendTo(document.body);
		this.$modal.on("mousedown", (e) => { if (e.target === this.$modal.get(0)) this._close_modal(); });
		this.$modal.find(".po-modal-x").on("click", () => this._close_modal());
		this._esc = (e) => { if (e.key === "Escape") this._close_modal(); };
		$(document).on("keydown", this._esc);
		return this.$modal;
	}

	_close_modal() {
		if (this.$modal) { this.$modal.remove(); this.$modal = null; }
		if (this._esc) { $(document).off("keydown", this._esc); this._esc = null; }
	}

	_abrir_posto(posto) {
		if (!posto) return;
		const $m = this._modal_shell();
		$m.find(".po-modal-b").html(`<div class="po-mloading">${__("A carregar...")}</div>`);
		frappe.call({
			method: "sigos.painel.escala_semana_posto",
			args: { posto, data: this.state.data },
			callback: (r) => { if (this.$modal && r.message) this._fill_posto_modal(r.message); },
		});
	}

	_abrir_vigilante(vig) {
		if (!vig) return;
		const $m = this._modal_shell();
		$m.find(".po-modal-b").html(`<div class="po-mloading">${__("A carregar...")}</div>`);
		frappe.call({
			method: "sigos.painel.escala_semana_vigilante",
			args: { vigilante: vig, data: this.state.data },
			callback: (r) => { if (this.$modal && r.message) this._fill_vig_modal(r.message); },
		});
	}

	_fill_posto_modal(m) {
		const p = m.posto;
		const sub = [p.delegacao, p.cliente].filter(Boolean)
			.map((x) => frappe.utils.escape_html(x)).join(" &middot; ");
		this.$modal.find(".po-modal-title").html(`
			<span class="po-mt-code">${frappe.utils.escape_html(p.name)}</span>
			<div class="po-vtitle">
				<span class="po-mt-name">${frappe.utils.escape_html(p.nome_do_posto || "")}</span>
				${sub ? `<span class="po-mt-sub">${sub}</span>` : ""}
			</div>`);
		this.$modal.find(".po-modal-actions").html(
			`<button class="po-mbtn ghost" data-go-posto="${frappe.utils.escape_html(p.name)}">${__("Abrir posto")}</button>`);
		this.$modal.find(".po-modal-b").html(this._week_caption() + this._week_html(m.dias, "posto"));
		this._bind_modal_common();
	}

	_fill_vig_modal(m) {
		const v = m.vigilante;
		const ini = (v.nome_completo || v.name || "?").trim().slice(0, 1).toUpperCase();
		const foto = v.foto
			? `<img class="po-vphoto" src="${frappe.utils.escape_html(v.foto)}"/>`
			: `<div class="po-vphoto po-vph-ph">${frappe.utils.escape_html(ini)}</div>`;
		const sub = [v.name, v.codename, v.mecanografico].filter(Boolean)
			.map((x) => frappe.utils.escape_html(x)).join(" &middot; ");
		this.$modal.find(".po-modal-title").html(`
			${foto}
			<div class="po-vtitle">
				<span class="po-mt-name">${frappe.utils.escape_html(v.nome_completo || v.name)}</span>
				<span class="po-mt-sub">${sub}</span>
			</div>`);
		this.$modal.find(".po-modal-actions").html(`
			<button class="po-mbtn" data-new-aus="1">+ ${__("Registar ausência")}</button>
			<button class="po-mbtn ghost" data-go-vig="${frappe.utils.escape_html(v.name)}">${__("Abrir ficha")}</button>`);
		const chips = [
			[__("Estado"), v.status],
			[__("Categoria"), v.categoria],
			[__("Regime"), v.regime_do_vigilante],
			[__("Tipo"), v.tipo_de_vigilante],
			[__("Delegação"), v.delegacao],
			[__("Posto"), v.nome_do_posto || v.posto_de_vigilancia],
			[__("Cliente"), v.cliente],
			[__("Contacto"), v.contacto],
			[__("Admissão"), v.data_admissao ? frappe.datetime.str_to_user(v.data_admissao) : null],
		].filter(([, val]) => val);
		const meta = `<div class="po-vmeta">${chips.map(([k, val]) =>
			`<div class="po-vchip"><span>${k}</span><b>${frappe.utils.escape_html(String(val))}</b></div>`).join("")}</div>`;
		this.$modal.find(".po-modal-b").html(meta + this._week_caption() + this._week_html(m.dias, "vig"));
		this._bind_modal_common();
	}

	_week_caption() {
		return `<div class="po-week-cap">${__("Escala")} &middot; ${__("7 dias a partir de")} ${this._fmt_day(this.state.data)}</div>`;
	}

	_week_html(dias, mode) {
		const cols = dias.map((d) => {
			const today = d.data === this.state.data ? " is-today" : "";
			const body = d.rows.length
				? d.rows.map((r) => this._week_row(r, mode)).join("")
				: `<div class="po-wempty">&mdash;</div>`;
			return `<div class="po-wday${today}">
				<div class="po-wday-h"><b>${d.label}</b><span>${this._fmt_day(d.data)}</span></div>
				<div class="po-wday-b">${body}</div>
			</div>`;
		}).join("");
		return `<div class="po-week">${cols}</div>`;
	}

	_week_row(r, mode) {
		const turno = r.turno ? `<span class="po-turno">${frappe.utils.escape_html(r.turno)}</span>` : "";
		if (r.e_folga) {
			return `<div class="po-wrow folga"><span class="po-folga">${__("Folga")}</span>${turno}</div>`;
		}
		const per = r.periodo
			? `<span class="po-wper p-${this._per_key(r.periodo)}">${frappe.utils.escape_html(r.periodo)}</span>` : "";
		if (mode === "posto") {
			return `<div class="po-wrow" data-vig="${frappe.utils.escape_html(r.vigilante)}">
				<span class="po-wname">${frappe.utils.escape_html(r.nome_completo || r.vigilante)}</span>
				<div class="po-wtags">${per}${turno}</div></div>`;
		}
		return `<div class="po-wrow" data-posto="${frappe.utils.escape_html(r.posto || "")}">
			<span class="po-wname">${frappe.utils.escape_html(r.nome_do_posto || r.posto || "—")}</span>
			<div class="po-wtags">${per}${turno}</div></div>`;
	}

	_bind_modal_common() {
		this.$modal.find("[data-go-posto]").on("click", (e) => {
			const n = $(e.currentTarget).data("go-posto"); this._close_modal();
			frappe.set_route("Form", "Posto De Vigilancia", n);
		});
		this.$modal.find("[data-go-vig]").on("click", (e) => {
			const n = $(e.currentTarget).data("go-vig"); this._close_modal();
			frappe.set_route("Form", "Vigilante", n);
		});
		this.$modal.find("[data-new-aus]").on("click", () => { this._close_modal(); this._registar_ausencia(); });
		this.$modal.find("[data-vig]").on("click", (e) => {
			e.stopPropagation(); this._abrir_vigilante($(e.currentTarget).data("vig"));
		});
		this.$modal.find("[data-posto]").on("click", (e) => {
			e.stopPropagation(); this._abrir_posto($(e.currentTarget).data("posto"));
		});
	}

	_per_key(p) {
		return { "Manhã": "m", "Tarde": "t", "Noite": "n" }[p] || "x";
	}

	_fmt_day(iso) {
		const parts = (iso || "").split("-");
		return parts.length === 3 ? parts[2] + "/" + parts[1] : iso;
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

	_inject_fonts() {
		if (document.getElementById("po-fonts")) return;
		const l = document.createElement("link");
		l.id = "po-fonts"; l.rel = "stylesheet";
		l.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";
		document.head.appendChild(l);
	}

	_inject_css() {
		if (document.getElementById("sigos-painel-css")) return;
		const css = `
.sigos-painel { background:#F4F6FA; }
.layout-main-section-wrapper:has(.sigos-painel), .page-body:has(.sigos-painel) { background:#F4F6FA; }
.po-root {
  --paper:#F4F6FA; --paper2:#FFFFFF; --paper3:#EEF1F6; --ink:#0E1726; --ink2:#5B6B82;
  --ink3:#93A1B5; --line:#E6EAF2; --line2:#D5DCE8; --accent:#4F46E5; --accentInk:#4338CA;
  --wash:rgba(79,70,229,.07); --good:#16A34A; --bad:#E5484D; --amber:#F59E0B; --info:#2F6FED;
  --violet:#8B5CF6; --teal:#0EA5A3; --graphite:#64748B; --goodWash:rgba(22,163,74,.12); --badWash:rgba(229,72,77,.12);
  --display:'Space Grotesk',system-ui,sans-serif; --body:'Inter',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
  --shadow:0 1px 2px rgba(16,23,38,.04), 0 14px 34px -20px rgba(16,23,38,.22);
  color:var(--ink); font-family:var(--body); font-feature-settings:"tnum" 1; padding:8px 4px 60px; -webkit-font-smoothing:antialiased;
}
.po-root .po-code, .po-root .po-mec, .po-root .po-mini-code, .po-root .po-mt-code, .po-root .po-wday-h span { font-family:var(--mono); }
.po-root .po-tile-val, .po-root .po-ring-hole span, .po-root .po-badge, .po-root .po-mini-badge { font-family:var(--display); }

/* Toolbar */
.po-toolbar { display:flex; flex-wrap:wrap; gap:10px 14px; align-items:center; padding:12px 14px; background:var(--paper2); border:1px solid var(--line); border-radius:16px; box-shadow:var(--shadow); }
.po-toolbar.po-busy { opacity:.85; }
.po-datebar { display:flex; align-items:center; gap:6px; }
.po-nav, .po-today, .po-refresh { background:var(--paper2); color:var(--ink2); border:1px solid var(--line2); border-radius:10px; cursor:pointer; height:32px; transition:.18s; }
.po-nav { width:32px; font-size:18px; line-height:1; }
.po-today { padding:0 12px; font-size:12px; font-weight:600; }
.po-nav:hover, .po-today:hover, .po-refresh:hover { border-color:var(--accent); color:var(--accent); }
.po-date-wrap .control-input input, .po-date-wrap input { background:var(--paper2); color:var(--ink); border:1px solid var(--line2); border-radius:10px; height:32px; min-width:130px; font-family:var(--body); }
.po-filters { display:flex; flex-wrap:wrap; gap:8px; align-items:center; flex:1; }
.po-filter { min-width:150px; }
.po-filter .control-input input { background:var(--paper2); color:var(--ink); border:1px solid var(--line2); border-radius:10px; height:32px; font-family:var(--body); }
.po-search { display:flex; align-items:center; gap:6px; background:var(--paper2); border:1px solid var(--line2); border-radius:10px; padding:0 12px; height:32px; }
.po-search input { background:transparent; border:0; outline:0; color:var(--ink); width:210px; font-family:var(--body); }
.po-search-ico { opacity:.55; font-size:13px; }
.po-live { display:flex; align-items:center; gap:12px; margin-left:auto; }
.po-auto { display:flex; align-items:center; gap:6px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; margin:0; color:var(--ink3); }
.po-dot { width:8px; height:8px; border-radius:50%; background:var(--ink3); display:inline-block; }
.po-live-on .po-dot { background:var(--good); box-shadow:0 0 0 0 rgba(22,163,74,.5); animation:po-pulse 2s infinite; }
@keyframes po-pulse { 0%{box-shadow:0 0 0 0 rgba(22,163,74,.45);} 70%{box-shadow:0 0 0 6px rgba(22,163,74,0);} 100%{box-shadow:0 0 0 0 rgba(22,163,74,0);} }
.po-stamp { font-size:11px; color:var(--ink3); font-weight:500; }
.po-refresh { width:34px; font-size:15px; }

/* KPI strip */
.po-kpis { display:flex; gap:12px; margin-top:14px; flex-wrap:wrap; }
.po-ring-card { display:flex; align-items:center; gap:20px; background:var(--paper2); border:1px solid var(--line); border-radius:16px; box-shadow:var(--shadow); padding:18px 24px; }
.po-ring { --pct:0; width:84px; height:84px; border-radius:50%; display:grid; place-items:center; flex:none;
	background: conic-gradient(var(--ring) calc(var(--pct)*1%), var(--paper3) 0); }
.po-ring-ok { --ring:var(--good); } .po-ring-warn { --ring:var(--amber); } .po-ring-bad { --ring:var(--bad); }
.po-ring-hole { width:62px; height:62px; border-radius:50%; background:var(--paper2); display:grid; place-items:center; }
.po-ring-hole span { font-size:23px; font-weight:600; color:var(--ink); } .po-ring-hole small { font-size:11px; color:var(--ink3); }
.po-ring-info { display:flex; flex-direction:column; gap:12px; }
.po-ring-lbl { font-size:10px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; color:var(--ink3); }
.po-ring-sub { font-size:12px; color:var(--ink2); margin-top:3px; font-weight:500; }

/* Coverage sparkline (7 days) */
.po-spark { min-width:172px; }
.po-spark-h { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--ink3); display:flex; align-items:baseline; gap:8px; margin-bottom:6px; }
.po-spark-avg { color:var(--ink2); letter-spacing:.04em; }
.po-spark-bars { display:flex; align-items:flex-end; gap:5px; height:42px; margin-bottom:16px; }
.po-sbar { position:relative; width:15px; height:100%; display:flex; align-items:flex-end; }
.po-sbar i { width:100%; height:var(--h,8%); border-radius:3px 3px 0 0; background:var(--ink3); display:block; transition:height .25s ease; }
.po-sbar em { position:absolute; left:0; right:0; bottom:-15px; text-align:center; font-size:9px; font-style:normal; color:var(--ink3); }
.po-sbar.tone-ok i { background:var(--good); }
.po-sbar.tone-warn i { background:var(--amber); }
.po-sbar.tone-bad i { background:var(--bad); }
.po-sbar-void i { background:repeating-linear-gradient(45deg,var(--paper3),var(--paper3) 3px,var(--line) 3px,var(--line) 6px); }
.po-sbar.is-today i { outline:1.5px solid var(--accent); outline-offset:1px; }
.po-sbar.is-today em { color:var(--ink); font-weight:600; }

.po-tiles { display:grid; grid-template-columns:repeat(4,minmax(86px,1fr)); gap:10px; flex:1; }
.po-tile { background:var(--paper2); border:1px solid var(--line); border-left-width:3px; border-radius:14px; box-shadow:var(--shadow); padding:12px 14px; transition:transform .08s ease, border-color .12s ease; }
.po-tile:hover { transform:translateY(-2px); }
.po-tile-val { font-size:24px; font-weight:600; color:var(--ink); line-height:1.1; }
.po-tile-lbl { font-size:10px; color:var(--ink3); text-transform:uppercase; letter-spacing:.06em; margin-top:2px; font-weight:600; }
.po-tile.k-cob { border-left-color:var(--good); } .po-tile.k-lac { border-left-color:var(--amber); }
.po-tile.k-desc { border-left-color:var(--bad); } .po-tile.k-falta { border-left-color:var(--bad); }
.po-tile.k-sub { border-left-color:var(--violet); } .po-tile.k-fer { border-left-color:var(--info); }
.po-tile.k-res { border-left-color:var(--teal); } .po-tile.k-oc { border-left-color:var(--amber); }

/* Filter chips */
.po-chips { display:flex; gap:8px; margin:16px 0 10px; flex-wrap:wrap; }
.po-chip { background:var(--paper2); border:1px solid var(--line2); color:var(--ink2); border-radius:999px; padding:6px 15px; font-size:12px; font-weight:500; cursor:pointer; transition:.18s; }
.po-chip b { color:var(--ink); margin-left:4px; font-family:var(--display); }
.po-chip:hover { border-color:var(--accent); color:var(--accent); }
.po-chip.active { background:var(--wash); border-color:var(--accent); color:var(--accentInk); }
.po-chip.chip-descobertos.active { background:var(--badWash); border-color:var(--bad); color:var(--bad); }
.po-chip.chip-atencao.active { background:rgba(245,158,11,.12); border-color:var(--amber); color:#9A6608; }
.po-chip.chip-ok.active { background:var(--goodWash); border-color:var(--good); color:var(--good); }

/* Layout */
.po-layout { display:grid; grid-template-columns:1fr 320px; gap:16px; align-items:start; }
@media (max-width:1100px){ .po-layout { grid-template-columns:1fr; } }
.po-loading, .po-empty, .po-mt { color:var(--ink3); padding:24px; text-align:center; font-size:13px; }

/* Board */
.po-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:14px; }
.po-card { background:var(--paper2); border:1px solid var(--line); border-top:3px solid var(--line2); border-radius:16px; box-shadow:var(--shadow); padding:13px 15px; cursor:pointer; transition:transform .08s ease, border-color .12s ease, box-shadow .12s ease; }
.po-card:hover { transform:translateY(-2px); box-shadow:0 1px 2px rgba(16,23,38,.04), 0 18px 38px -20px rgba(16,23,38,.34); }
.po-card.cov-coberto { border-top-color:var(--good); }
.po-card.cov-lacuna { border-top-color:var(--amber); }
.po-card.cov-descoberto, .po-card.cov-sem_escala { border-top-color:var(--bad); }
.po-card-h { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
.po-card-id { display:flex; flex-direction:column; gap:1px; min-width:0; }
.po-code { font-size:14px; font-weight:600; color:var(--ink); }
.po-pname { font-size:12px; color:var(--ink2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px; }
.po-card-meta { display:flex; align-items:center; gap:6px; }
.po-badge { font-size:13px; font-weight:600; border-radius:8px; padding:2px 9px; background:var(--paper3); color:var(--ink2); }
.po-badge.b-coberto { background:var(--goodWash); color:var(--good); }
.po-badge.b-lacuna { background:rgba(245,158,11,.14); color:#9A6608; }
.po-badge.b-descoberto, .po-badge.b-sem_escala { background:var(--badWash); color:var(--bad); }
.po-tag-temp { font-size:9.5px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; background:rgba(139,92,246,.12); color:var(--violet); border-radius:6px; padding:2px 7px; }
.po-card-sub { display:flex; gap:6px; margin:8px 0 4px; flex-wrap:wrap; }
.po-mchip { font-size:10.5px; background:var(--paper3); color:var(--ink2); border-radius:6px; padding:2px 8px; font-weight:500; }
.po-mchip.dim { color:var(--ink3); }
.po-card-b { display:flex; flex-direction:column; gap:8px; margin-top:6px; }
.po-per-h { font-size:9.5px; text-transform:uppercase; letter-spacing:.1em; color:var(--ink3); font-weight:600; margin:4px 0 3px; border-bottom:1px dashed var(--line2); padding-bottom:3px; }
.po-no-sched { font-size:12px; color:var(--ink3); font-style:italic; padding:6px 0; }

/* Guard row */
.po-guard { display:flex; align-items:center; gap:7px; padding:5px 6px; border-radius:9px; font-size:12.5px; cursor:pointer; }
.po-guard:hover { background:var(--wash); }
.po-gdot { width:8px; height:8px; border-radius:50%; flex:none; background:var(--ink3); }
.st-presente .po-gdot { background:var(--good); }
.st-falta .po-gdot { background:var(--bad); }
.st-ferias .po-gdot { background:var(--info); }
.st-substituido .po-gdot { background:var(--violet); }
.st-atraso .po-gdot { background:var(--amber); }
.po-gdot.st-reserva { background:var(--teal); }
.po-gname { color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; min-width:0; font-weight:500; }
.st-falta .po-gname { color:var(--bad); }
.po-mec { font-size:10.5px; color:var(--ink3); }
.po-turno { font-size:10px; color:var(--ink2); background:var(--paper3); border-radius:5px; padding:1px 7px; font-weight:500; }
.po-cover { font-size:11px; color:var(--violet); white-space:nowrap; font-weight:500; }

/* Sidebar */
.po-side { display:flex; flex-direction:column; gap:14px; position:sticky; top:8px; }
.po-panel { background:var(--paper2); border:1px solid var(--line); border-radius:16px; box-shadow:var(--shadow); overflow:hidden; }
.po-panel h3 { font-size:11px; text-transform:uppercase; letter-spacing:.1em; color:var(--ink3); font-weight:600; margin:0; padding:14px 16px 9px; display:flex; align-items:center; gap:8px; }
.po-pn { background:var(--wash); color:var(--accent); border-radius:999px; font-size:11px; padding:2px 9px; font-family:var(--display); font-weight:600; }
.po-panel-b { max-height:340px; overflow:auto; padding:0 9px 9px; }
.po-mini { display:flex; align-items:center; gap:8px; padding:8px; border-radius:9px; cursor:pointer; font-size:12.5px; }
.po-mini:hover { background:var(--wash); }
.po-mini.cov-lacuna { border-left:2px solid var(--amber); }
.po-mini.cov-descoberto, .po-mini.cov-sem_escala { border-left:2px solid var(--bad); }
.po-mini-code { font-size:12px; color:var(--ink); font-weight:600; }
.po-mini-name { color:var(--ink2); flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; font-weight:500; }
.po-mini-badge { font-size:11px; border-radius:7px; padding:1px 8px; background:var(--paper3); color:var(--ink2); font-weight:600; }
.po-oc { display:flex; gap:9px; padding:9px 8px; border-radius:9px; cursor:pointer; }
.po-oc:hover { background:var(--wash); }
.po-oc-grav { width:5px; border-radius:3px; flex:none; }
.grav-critica .po-oc-grav { background:var(--bad); } .grav-alta .po-oc-grav { background:#F5662A; }
.grav-media .po-oc-grav { background:var(--amber); } .grav-baixa .po-oc-grav { background:var(--info); }
.po-oc-top { font-size:12.5px; color:var(--ink); font-weight:500; }
.po-oc-meta { font-size:11px; color:var(--ink3); margin-top:2px; }
.po-oc-estado { color:var(--ink2); }
.po-add-oc { width:calc(100% - 18px); margin:0 9px 10px; background:var(--paper3); color:var(--accent); border:1px dashed var(--line2); border-radius:10px; padding:8px; font-size:12px; font-weight:600; cursor:pointer; transition:.18s; }
.po-add-oc:hover { border-color:var(--accent); background:var(--wash); }

/* Primary action button (toolbar) */
.po-act-aus { background:var(--accent); color:#fff; border:1px solid var(--accent); border-radius:10px; height:32px; padding:0 14px; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; transition:.18s; }
.po-act-aus:hover { background:var(--accentInk); border-color:var(--accentInk); }

/* Modal */
.po-modal-back { position:fixed; inset:0; background:rgba(14,23,38,.4); backdrop-filter:blur(3px); z-index:1050; display:flex; align-items:flex-start; justify-content:center; padding:46px 16px; overflow:auto; }
.po-modal { width:min(1040px,100%); background:var(--paper2); border:1px solid var(--line); border-radius:18px; box-shadow:0 30px 80px -24px rgba(16,23,38,.5); overflow:hidden; animation:po-pop .12s ease; }
@keyframes po-pop { from { transform:translateY(8px); opacity:0; } to { transform:none; opacity:1; } }
.po-modal-h { display:flex; align-items:center; gap:14px; padding:16px 20px; border-bottom:1px solid var(--line); background:var(--paper2); }
.po-modal-title { display:flex; align-items:center; gap:11px; flex:1; min-width:0; }
.po-mt-code { font-size:15px; font-weight:600; color:var(--accentInk); background:var(--wash); border:1px solid var(--line2); border-radius:8px; padding:2px 10px; }
.po-mt-name { font-family:var(--display); font-size:17px; font-weight:600; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.po-mt-sub { font-size:11.5px; color:var(--ink3); }
.po-vtitle { display:flex; flex-direction:column; gap:2px; min-width:0; }
.po-vphoto { width:46px; height:46px; border-radius:12px; object-fit:cover; border:1px solid var(--line2); flex:none; }
.po-vph-ph { display:grid; place-items:center; background:linear-gradient(150deg,var(--accent),var(--accentInk)); color:#fff; font-family:var(--display); font-size:20px; font-weight:600; }
.po-modal-actions { display:flex; gap:8px; flex:none; }
.po-mbtn { background:var(--accent); color:#fff; border:1px solid var(--accent); border-radius:10px; padding:7px 13px; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; transition:.18s; }
.po-mbtn:hover { background:var(--accentInk); border-color:var(--accentInk); }
.po-mbtn.ghost { background:var(--paper2); color:var(--ink2); border-color:var(--line2); }
.po-mbtn.ghost:hover { border-color:var(--accent); color:var(--accent); }
.po-modal-x { background:transparent; border:0; color:var(--ink3); font-size:24px; line-height:1; cursor:pointer; width:32px; height:32px; border-radius:9px; flex:none; }
.po-modal-x:hover { background:var(--paper3); color:var(--ink); }
.po-modal-b { padding:18px 20px 24px; max-height:calc(100vh - 170px); overflow:auto; }
.po-mloading { color:var(--ink3); text-align:center; padding:40px; font-size:13px; }
.po-vmeta { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
.po-vchip { background:var(--paper3); border:1px solid var(--line); border-radius:11px; padding:7px 11px; min-width:92px; }
.po-vchip span { display:block; font-size:9px; text-transform:uppercase; letter-spacing:.07em; color:var(--ink3); font-weight:600; }
.po-vchip b { font-size:12.5px; color:var(--ink); font-weight:600; }
.po-week-cap { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink3); font-weight:600; margin:2px 0 8px; }

/* Week grid */
.po-week { display:grid; grid-template-columns:repeat(7,minmax(116px,1fr)); gap:8px; }
@media (max-width:900px) { .po-week { grid-auto-flow:column; grid-template-columns:none; grid-auto-columns:minmax(150px,70%); overflow-x:auto; } }
.po-wday { background:var(--paper3); border:1px solid var(--line); border-radius:12px; overflow:hidden; min-height:88px; }
.po-wday.is-today { border-color:var(--accent); box-shadow:inset 0 0 0 1px rgba(79,70,229,.35); }
.po-wday-h { display:flex; justify-content:space-between; align-items:baseline; padding:8px 10px; background:var(--paper2); border-bottom:1px solid var(--line); }
.po-wday-h b { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink2); font-weight:600; }
.po-wday-h span { font-size:11px; color:var(--ink3); }
.po-wday-b { padding:6px; display:flex; flex-direction:column; gap:5px; }
.po-wempty { color:var(--ink3); text-align:center; font-size:13px; padding:8px 0; }
.po-wrow { background:var(--paper2); border:1px solid var(--line); border-radius:9px; padding:6px 8px; cursor:pointer; display:flex; flex-direction:column; gap:4px; transition:.15s; }
.po-wrow:hover { border-color:var(--accent); }
.po-wrow.folga { background:var(--paper3); cursor:default; flex-direction:row; align-items:center; gap:6px; }
.po-wrow.folga:hover { border-color:var(--line); }
.po-wname { font-size:12px; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:500; }
.po-wtags { display:flex; flex-wrap:wrap; gap:4px; align-items:center; }
.po-wper { font-size:9.5px; text-transform:uppercase; letter-spacing:.04em; border-radius:5px; padding:1px 7px; font-weight:600; }
.po-wper.p-m { background:rgba(47,111,237,.12); color:var(--info); }
.po-wper.p-t { background:rgba(245,158,11,.14); color:#9A6608; }
.po-wper.p-n { background:rgba(139,92,246,.12); color:var(--violet); }
.po-wper.p-x { background:var(--paper3); color:var(--ink2); }
.po-folga { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink3); background:var(--paper3); border-radius:5px; padding:1px 8px; font-weight:600; }
@media (prefers-reduced-motion:reduce){ .po-card,.po-tile,.po-sbar i{ transition:none; } }
`;
		const style = document.createElement("style");
		style.id = "sigos-painel-css";
		style.textContent = css;
		document.head.appendChild(style);
	}
};
