// SIGOS - Painel CCO (estatistico). "Operations Daylight": bright control surface,
// all-custom charts (no chart lib). Indigo = interaction; green/amber/red = coverage
// status only. Space Grotesk numerals, Inter body, IBM Plex Mono for entity codes.
frappe.provide("sigos");

frappe.pages["painel-cco"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({ parent: wrapper, title: __("Painel CCO"), single_column: true });
	wrapper.painel_cco = new sigos.PainelCCO(page, wrapper);
};
frappe.pages["painel-cco"].on_page_show = function (wrapper) {
	if (wrapper.painel_cco) wrapper.painel_cco.refresh();
};

sigos.PainelCCO = class PainelCCO {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.state = {
			preset: "30",
			de: frappe.datetime.add_days(frappe.datetime.get_today(), -29),
			ate: frappe.datetime.get_today(),
			delegacao: null, cliente: null, posto: null,
			busca: "",
		};
		this.THEME_KEY = "sigos_cco_theme";
		this.theme = localStorage.getItem(this.THEME_KEY) || "light"; // daylight by default
		this._palettes = {
			light: {
				accent: "#4F46E5", accentInk: "#4338CA", graphite: "#64748B", ink3: "#93A1B5",
				good: "#16A34A", bad: "#E5484D", amber: "#F59E0B", info: "#2F6FED", stroke: "#FFFFFF",
				palette: ["#4F46E5", "#2F6FED", "#16A34A", "#F59E0B", "#E5484D", "#0EA5A3", "#8B5CF6", "#64748B"],
			},
			dark: {
				accent: "#7C83FF", accentInk: "#A5ABFF", graphite: "#7A8699", ink3: "#6B7688",
				good: "#3DD68C", bad: "#FF6166", amber: "#FBBF4D", info: "#5AA2FF", stroke: "#171B22",
				palette: ["#7C83FF", "#5AA2FF", "#3DD68C", "#FBBF4D", "#FF6166", "#3FD0CE", "#B79BFF", "#8A97AD"],
			},
		};
		this.C = this._palettes[this.theme];
		this._tables = [];
		this._spid = 0;
		this._fmt = (n) => (Number(n) || 0).toLocaleString("pt-PT");
		this._inject_fonts();
		this._inject_css();
		this._build();
		this._wire();
		this._apply_theme();
		this.refresh();
	}

	// ============================================================ DATA
	refresh() {
		if (this._loading) return;
		this._loading = true;
		this.$root.find(".cco-stamp").text(__("A actualizar..."));
		frappe.call({
			method: "sigos.cco.cco_dashboard",
			args: {
				de: this.state.de, ate: this.state.ate,
				delegacao: this.state.delegacao, cliente: this.state.cliente, posto: this.state.posto,
			},
			callback: (r) => {
				this._loading = false;
				if (!r.message) return;
				this.data = r.message;
				this._render();
				this._stamp();
			},
			error: () => { this._loading = false; this.$root.find(".cco-stamp").text(__("Erro")); },
		});
	}

	_render() {
		this._tables = [];
		this._render_dateline();
		this._render_kpis();
		this._render_cobertura();
		this._render_scorecard();
		this._render_ocorrencias();
		this._render_ausencias();
		this._render_armamento();
	}

	// ============================================================ SHELL
	_build() {
		this.page.main.addClass("sigos-cco");
		this.$root = $(`
<div class="cco-root">
  <header class="cco-mast cco-rise">
    <div class="cco-mast-l">
      <div class="cco-mark">S</div>
      <div class="cco-mast-id">
        <div class="cco-eyebrow"><span class="cco-up">Centro de Controlo Operacional</span></div>
        <h1 class="cco-h1">Painel CCO</h1>
        <div class="cco-dateline">&mdash;</div>
      </div>
    </div>
    <div class="cco-mast-r">
      <span class="cco-pulse"><i></i><span class="cco-stamp">${__("A carregar...")}</span></span>
      <button class="cco-btn cco-icon cco-theme" title="${__("Tema claro / escuro")}" aria-label="theme"></button>
      <button class="cco-btn cco-refresh">${__("Actualizar")}</button>
    </div>
  </header>

  <div class="cco-controls cco-rise">
    <div class="cco-ctl-grp">
      <span class="cco-ctl-lbl">${__("Período")}</span>
      <div class="cco-pills"></div>
      <div class="cco-range"></div>
    </div>
    <div class="cco-ctl-grp cco-scope">
      <div class="cco-filters"></div>
      <div class="cco-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="text" placeholder="${__("Filtrar tabelas...")}">
      </div>
    </div>
  </div>

  <div class="cco-kpis cco-rise"></div>

  ${this._sec("Cobertura &amp; Efectivo", "Escala publicada vs faltas e férias")}
  <div class="cco-card cco-span">
    ${this._cardhead("Taxa de Cobertura Diária", "Percentagem de slots cobertos por dia")}
    <div class="cco-callouts" id="cco-cob-callouts"></div>
    <div class="cco-trend-host" id="cco-cob-trend"></div>
    <div class="cco-trendx" id="cco-cob-x"></div>
  </div>
  <div class="cco-grid2">
    ${this._card("cco-efe-deleg", "Efectivo por Delegação", "Vigilantes activos", "rank")}
    ${this._card("cco-efe-cat", "Efectivo por Categoria", "Composição do activo", "donut")}
  </div>
  <div class="cco-card cco-span">
    ${this._cardhead("Postos com Mais Lacunas", "Slots descobertos no período")}
    <div id="cco-lacunas"></div>
  </div>

  ${this._sec("Scorecard Regional", "Estado por delegação")}
  <div class="cco-card cco-span">
    <div id="cco-scorecard"></div>
  </div>

  ${this._sec("Ocorrências", "Incidentes registados")}
  <div class="cco-card cco-span">
    ${this._cardhead("Ocorrências por Dia", "Volume diário")}
    <div class="cco-trend-host" id="cco-oc-trend"></div>
    <div class="cco-trendx" id="cco-oc-x"></div>
  </div>
  <div class="cco-grid2">
    ${this._card("cco-oc-grav", "Por Gravidade", "Distribuição de severidade", "donut")}
    ${this._card("cco-oc-tipo", "Por Tipo", "Natureza do incidente", "rank")}
  </div>
  <div class="cco-grid2">
    ${this._card("cco-oc-estado", "Por Estado", "Ciclo de vida", "stack")}
    ${this._card("cco-oc-resol", "Resolução", "Tempo médio &amp; pendentes", "stat")}
  </div>
  <div class="cco-grid2">
    ${this._card("cco-oc-postos", "Top Postos", "Mais ocorrências", "table")}
    ${this._card("cco-oc-vigs", "Top Vigilantes", "Mais ocorrências", "table")}
  </div>

  ${this._sec("Ausências &amp; Reserva", "Faltas e capacidade disponível")}
  <div class="cco-card cco-span">
    ${this._cardhead("Faltas por Dia", "Faltas registadas (submetidas)")}
    <div class="cco-trend-host" id="cco-aus-trend"></div>
    <div class="cco-trendx" id="cco-aus-x"></div>
  </div>
  <div class="cco-grid2">
    ${this._card("cco-aus-tipo", "Ausências por Tipo", "Natureza da ausência", "rank")}
    ${this._card("cco-aus-res", "Reserva por Delegação", "Capacidade destacável", "rank")}
  </div>
  <div class="cco-card cco-span">
    ${this._cardhead("Vigilantes com Mais Faltas", "No período seleccionado")}
    <div id="cco-aus-vigs"></div>
  </div>

  ${this._sec("Armamento", "Parque e distribuição")}
  <div class="cco-card cco-span">
    ${this._cardhead("Estado do Parque", "Inventário de armas")}
    <div class="cco-parque" id="cco-arm-stats"></div>
  </div>
  <div class="cco-grid2">
    ${this._card("cco-arm-deleg", "Armas por Delegação", "Alocadas vs total", "rank")}
    ${this._card("cco-arm-tipo", "Por Tipo de Arma", "Composição do parque", "donut")}
  </div>
</div>`).appendTo(this.page.main);

		this._build_controls();
	}

	_sec(title, aside) {
		return `<div class="cco-sec cco-rise">
			<span class="cco-sec-bar"></span><h2 class="cco-sec-title">${title}</h2>
			<span class="cco-sec-line"></span><span class="cco-sec-aside">${aside}</span></div>`;
	}
	_cardhead(title, sub) {
		return `<div class="cco-card-head"><div>
			<div class="cco-card-title">${title}</div><div class="cco-card-sub">${sub}</div></div></div>`;
	}
	_card(id, title, sub, kind) {
		return `<div class="cco-card"><div class="cco-card-head"><div>
			<div class="cco-card-title">${title}</div><div class="cco-card-sub">${sub}</div></div></div>
			<div class="cco-card-body cco-k-${kind}" id="${id}"></div></div>`;
	}

	// ============================================================ CONTROLS
	_build_controls() {
		const $pills = this.$root.find(".cco-pills");
		[["7", "7D"], ["30", "30D"], ["90", "90D"], ["mes", __("Mês")]].forEach(([k, lbl]) => {
			$(`<button class="cco-pill ${this.state.preset === k ? "on" : ""}" data-p="${k}">${lbl}</button>`)
				.appendTo($pills).on("click", () => this._set_preset(k));
		});

		const $range = this.$root.find(".cco-range");
		this.f_de = this._date_ctrl($range, __("De"), this.state.de, (v) => {
			this.state.de = v; this.state.preset = "custom"; this._sync_pills(); this.refresh();
		});
		this.f_ate = this._date_ctrl($range, __("Até"), this.state.ate, (v) => {
			this.state.ate = v; this.state.preset = "custom"; this._sync_pills(); this.refresh();
		});

		const $f = this.$root.find(".cco-filters");
		this.f_deleg = this._link_filter($f, "Delegacao", __("Delegação"), "delegacao");
		this.f_cli = this._link_filter($f, "Customer", __("Cliente"), "cliente");
		this.f_posto = this._link_filter($f, "Posto De Vigilancia", __("Posto"), "posto");
	}

	_wire() {
		this.$root.find(".cco-refresh").on("click", () => this.refresh());
		this.$root.find(".cco-theme").on("click", () => this._toggle_theme());
		this.$search = this.$root.find(".cco-search input");
		this.$search.on("input", frappe.utils.debounce(() => {
			this.state.busca = this.$search.val();
			this._filter_tables();
		}, 200));
	}

	_date_ctrl($parent, label, val, onset) {
		const $w = $(`<div class="cco-date"><label class="cco-up">${label}</label><div class="cco-date-i"></div></div>`).appendTo($parent);
		const ctrl = frappe.ui.form.make_control({
			df: { fieldtype: "Date", label: "" }, parent: $w.find(".cco-date-i").get(0), render_input: true,
		});
		ctrl.set_value(val);
		ctrl.$input.on("change", () => { const v = ctrl.get_value(); if (v) onset(v); });
		return ctrl;
	}
	_link_filter($parent, doctype, label, key) {
		const $wrap = $(`<div class="cco-filter"></div>`).appendTo($parent);
		const ctrl = frappe.ui.form.make_control({
			df: {
				fieldtype: "Link", options: doctype, label: "", placeholder: label,
				onchange: () => { this.state[key] = ctrl.get_value() || null; this.refresh(); },
			},
			parent: $wrap.get(0), render_input: true,
		});
		return ctrl;
	}
	_set_preset(k) {
		this.state.preset = k;
		const today = frappe.datetime.get_today();
		if (k === "mes") { this.state.de = today.slice(0, 8) + "01"; this.state.ate = today; }
		else { this.state.ate = today; this.state.de = frappe.datetime.add_days(today, -(parseInt(k, 10) - 1)); }
		this.f_de.set_value(this.state.de);
		this.f_ate.set_value(this.state.ate);
		this._sync_pills();
		this.refresh();
	}
	_sync_pills() {
		this.$root.find(".cco-pill").each((i, el) => $(el).toggleClass("on", $(el).data("p") === this.state.preset));
	}

	// ============================================================ RENDERERS
	_render_dateline() {
		const p = this.data.periodo || {};
		this.$root.find(".cco-dateline").html(
			`${this._dlabel(p.de)} &ndash; ${this._dlabel(p.ate)} <span class="cco-dl-days">&middot; ${p.dias} ${__("dias")}</span>`);
	}

	_render_kpis() {
		const k = this.data.kpis;
		const trend = (this.data.cobertura || {}).trend || [];
		const ocTrend = (this.data.ocorrencias || {}).trend || [];
		const cobVals = trend.map((d) => (d.pct == null ? 0 : d.pct));
		const gapVals = trend.map((d) => d.gaps || 0);
		const ocVals = ocTrend.map((d) => d.n || 0);
		const tiles = [
			this._kpi({ label: "Cobertura", val: k.cobertura_media, prev: k.cobertura_media_prev, higher: true, suffix: "%", feature: true, meta: k.meta_cobertura, spark: { vals: cobVals, type: "area", color: this.C.good } }),
			this._kpi({ label: "Descobertos", val: k.gap_slots, prev: k.gap_slots_prev, higher: false, sub: "slots", spark: { vals: gapVals, type: "bar", color: this.C.bad } }),
			this._kpi({ label: "Ocorrências", val: k.ocorrencias, prev: k.ocorrencias_prev, higher: false, sub: "no período", spark: { vals: ocVals, type: "bar", color: this.C.accent } }),
			this._kpi({ label: "Graves", val: k.ocorrencias_graves, prev: k.ocorrencias_graves_prev, higher: false, tone: "bad", sub: "Alta / Crítica" }),
			this._kpi({ label: "Substituição", val: k.taxa_substituicao, prev: k.taxa_substituicao_prev, higher: true, suffix: "%", sub: "faltas cobertas" }),
			this._kpi({ label: "Reserva", val: k.reserva, prev: null, higher: true, sub: "disponível" }),
		];
		this.$root.find(".cco-kpis").html(tiles.join(""));
		this._countup();
	}

	_kpi(o) {
		const suffix = o.suffix || "", dec = suffix === "%" ? 1 : 0;
		let delta = "";
		if (o.prev !== null && o.prev !== undefined) {
			const diff = Math.round((o.val - o.prev) * 10) / 10;
			if (!diff) delta = `<span class="cco-delta flat">&plusmn;0</span>`;
			else {
				const up = diff > 0, good = o.higher ? up : !up;
				delta = `<span class="cco-delta ${good ? "up" : "down"}">${up ? "&#9650;" : "&#9660;"} ${Math.abs(diff)}${suffix}</span>`;
			}
		}
		const spark = o.spark ? this._spark(o.spark.vals, { type: o.spark.type, color: o.spark.color }) : "";
		let foot;
		if (o.meta != null) {
			const v = Number(o.val) || 0, ok = v >= o.meta;
			foot = `<div class="cco-meta"><div class="cco-meta-tr">
				<span class="cco-meta-fill ${ok ? "ok" : "under"}" style="width:${Math.min(v, 100)}%"></span>
				<i class="cco-meta-tick" style="left:${o.meta}%"></i></div>
				<span class="cco-meta-lbl">${__("Meta")} ${o.meta}%</span></div>`;
		} else {
			foot = `<span class="cco-kpi-sub">${o.sub || "&nbsp;"}</span>`;
		}
		return `
			<div class="cco-kpi ${o.feature ? "feature" : ""} ${o.tone === "bad" ? "tone-bad" : ""}">
				<div class="cco-kpi-top"><span class="cco-up cco-kpi-lbl">${o.label}</span>${delta}</div>
				<div class="cco-kpi-mid">
					<div class="cco-kpi-val cco-num" data-to="${o.val == null ? 0 : o.val}" data-dec="${dec}" data-suffix="${suffix}">0</div>
					${spark ? `<div class="cco-kpi-spark">${spark}</div>` : ""}
				</div>
				<div class="cco-kpi-foot">${foot}</div>
			</div>`;
	}

	_render_cobertura() {
		const c = this.data.cobertura || {};
		const co = [];
		if (c.melhor_dia) co.push(`<span class="cco-callout good"><i>&#9650;</i>${__("Melhor")} ${this._dlabel(c.melhor_dia.data)} &middot; <b>${c.melhor_dia.pct}%</b></span>`);
		if (c.pior_dia) co.push(`<span class="cco-callout bad"><i>&#9660;</i>${__("Pior")} ${this._dlabel(c.pior_dia.data)} &middot; <b>${c.pior_dia.pct}%</b></span>`);
		co.push(`<span class="cco-callout meta"><i>&#9472;</i>${__("Meta")} <b>${c.meta || 95}%</b></span>`);
		this.$root.find("#cco-cob-callouts").html(co.join(""));

		const pts = (c.trend || []).map((d) => ({ label: d.data, v: d.pct }));
		this._trend("cco-cob-trend", "cco-cob-x", pts, {
			pct: true, yMax: 100, meta: c.meta || 95, color: this.C.good,
			best: c.melhor_dia && c.melhor_dia.data, worst: c.pior_dia && c.pior_dia.data,
		});

		this._rank("cco-efe-deleg", (c.efectivo_delegacao || []).map((r) => ({ name: r.k, val: r.n })));
		this._donut("cco-efe-cat", (c.efectivo_categoria || []).map((r, i) => ({ label: r.k, val: r.n, color: this.C.palette[i % this.C.palette.length] })));

		this._rank_table("cco-lacunas", c.top_lacunas, {
			cols: [
				{ key: "nome", label: __("Posto"), main: true, code: "posto", route: "Posto De Vigilancia" },
				{ key: "gaps", label: __("Descobertos"), num: true, bar: "bad", max: this._maxBy(c.top_lacunas, "gaps") },
				{ key: "escalados", label: __("Escalados"), num: true },
			],
			empty: __("Sem lacunas no período."), search: ["nome", "posto"],
		});
	}

	_render_scorecard() {
		const rows = this.data.scorecard || [];
		const maxEf = this._maxBy(rows, "efectivo");
		this._rank_table("cco-scorecard", rows, {
			cls: "cco-scoretable",
			cols: [
				{ key: "delegacao", label: __("Delegação"), main: true },
				{ key: "efectivo", label: __("Efectivo"), num: true, bar: "graphite", max: maxEf },
				{ key: "cobertura", label: __("Cobertura"), gauge: true, meta: this.data.kpis.meta_cobertura },
				{ key: "faltas", label: __("Faltas"), num: true },
				{ key: "ocorrencias", label: __("Ocorr."), num: true, badgeKey: "graves" },
				{ key: "reserva", label: __("Reserva"), num: true },
			],
			empty: __("Sem dados de delegação."), search: ["delegacao"],
		});
	}

	_render_ocorrencias() {
		const o = this.data.ocorrencias || {};
		this._trend("cco-oc-trend", "cco-oc-x", (o.trend || []).map((d) => ({ label: d.d, v: d.n })), { color: this.C.accent });
		this._donut("cco-oc-grav", (o.por_gravidade || []).map((x) => ({ label: x.k, val: x.n, color: this._grav_color(x.k) })));
		this._rank("cco-oc-tipo", (o.por_tipo || []).map((x) => ({ name: x.k, val: x.n })));
		this._stackbar("cco-oc-estado", (o.por_estado || []).map((x) => ({ label: x.k, val: x.n, color: this._estado_color(x.k) })));

		const tr = o.tempo_resolucao == null ? "—" : o.tempo_resolucao + " " + __("dias");
		this.$root.find("#cco-oc-resol").html(`
			<div class="cco-bigstat">
				<div class="cco-bigstat-v cco-num">${tr}</div>
				<div class="cco-bigstat-l cco-up">${__("Tempo médio de resolução")}</div>
			</div>
			<div class="cco-ministats">
				<div><b class="cco-num">${this._fmt(o.total || 0)}</b><span>${__("Total")}</span></div>
				<div><b class="cco-num">${this._fmt(o.resolvidas || 0)}</b><span>${__("Resolvidas")}</span></div>
				<div><b class="cco-num cco-bad">${this._fmt(o.graves || 0)}</b><span>${__("Graves")}</span></div>
			</div>`);

		this._rank_table("cco-oc-postos", o.top_postos, {
			cols: [
				{ key: "nome", label: __("Posto"), main: true, code: "posto", route: "Posto De Vigilancia" },
				{ key: "n", label: __("N.º"), num: true, bar: "accent", max: this._maxBy(o.top_postos, "n") },
			], empty: __("Sem ocorrências."), search: ["nome", "posto"],
		});
		this._rank_table("cco-oc-vigs", o.top_vigilantes, {
			cols: [
				{ key: "nome", label: __("Vigilante"), main: true, code: "vigilante", route: "Vigilante" },
				{ key: "n", label: __("N.º"), num: true, bar: "accent", max: this._maxBy(o.top_vigilantes, "n") },
			], empty: __("Sem ocorrências associadas."), search: ["nome", "vigilante"],
		});
	}

	_render_ausencias() {
		const a = this.data.ausencias || {};
		this._trend("cco-aus-trend", "cco-aus-x", (a.trend || []).map((d) => ({ label: d.d, v: d.n })), { color: this.C.bad });
		this._rank("cco-aus-tipo", (a.por_tipo || []).map((x) => ({ name: x.k, val: x.n })));
		this._rank("cco-aus-res", ((a.reserva || {}).por_delegacao || []).map((x) => ({ name: x.k, val: x.n })));
		this._rank_table("cco-aus-vigs", a.top_vigilantes, {
			cols: [
				{ key: "nome", label: __("Vigilante"), main: true, code: "vigilante", route: "Vigilante" },
				{ key: "delegacao", label: __("Delegação") },
				{ key: "n", label: __("Faltas"), num: true, bar: "bad", max: this._maxBy(a.top_vigilantes, "n") },
			], empty: __("Sem faltas no período."), search: ["nome", "vigilante", "delegacao"],
		});
	}

	_render_armamento() {
		const g = this.data.armamento || {};
		const stats = [
			["Total", g.total, "graphite"], ["Alocadas", g.alocadas, "good"],
			["Disponíveis", g.disponiveis, "accent"], ["Manutenção", g.manutencao, "amber"],
			["Em Arsenal", g.abatidas, "graphite"], ["Avariadas", g.avariadas, "bad"],
		];
		this.$root.find("#cco-arm-stats").html(stats.map(([l, v, t]) =>
			`<div class="cco-pq cco-pq-${t}"><span class="cco-pq-v cco-num">${this._fmt(v || 0)}</span><span class="cco-pq-l cco-up">${l}</span></div>`).join(""));

		this._rank2("cco-arm-deleg", (g.por_delegacao || []).map((x) => ({ name: x.k, total: x.total, alocadas: x.alocadas })));
		this._donut("cco-arm-tipo", (g.por_tipo || []).map((x, i) => ({ label: x.k, val: x.n, color: this.C.palette[i % this.C.palette.length] })));
	}

	// ============================================================ CHART PRIMITIVES
	_countup() {
		this.$root.find(".cco-num[data-to]").each((_, el) => {
			const to = +el.getAttribute("data-to"), dec = +(el.getAttribute("data-dec") || 0);
			const suffix = el.getAttribute("data-suffix") || "", t0 = performance.now(), dur = 850, self = this;
			(function tick(t) {
				const p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3), cur = to * e;
				el.textContent = (dec ? cur.toFixed(dec) : self._fmt(Math.round(cur))) + suffix;
				if (p < 1) requestAnimationFrame(tick);
			})(t0);
		});
	}

	// tiny inline KPI chart: area (line+fill) or bars; last value emphasized
	_spark(values, opts) {
		opts = opts || {};
		const vals = (values || []).map((v) => (v == null ? 0 : +v));
		if (!vals.length || !vals.some((v) => v)) return "";
		const color = opts.color || this.C.accent;
		const W = 116, H = 34;
		if (opts.type === "bar") {
			const n = vals.length, mx = Math.max(...vals, 1), bw = W / n, gap = Math.min(2.6, bw * 0.32);
			const bars = vals.map((v, i) => {
				const h = Math.max(1.5, (v / mx) * (H - 3)), x = i * bw + gap / 2, w = Math.max(0.6, bw - gap);
				return `<rect x="${x.toFixed(1)}" y="${(H - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${color}" opacity="${i === n - 1 ? 1 : 0.42}"/>`;
			}).join("");
			return `<svg class="cco-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>`;
		}
		const n = vals.length, mn = Math.min(...vals), mx = Math.max(...vals), span = (mx - mn) || 1;
		const x = (i) => i * (W / (n - 1 || 1));
		const y = (v) => 3 + (1 - (v - mn) / span) * (H - 6);
		const line = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
		const fill = `M0,${H} L${line.replace(/ /g, " L")} L${W},${H} Z`;
		const id = "ccosp" + (++this._spid);
		return `<svg class="cco-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
			<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="${color}" stop-opacity="0.24"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
			<path d="${fill}" fill="url(#${id})"/>
			<polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
	}

	_rank(id, items) {
		const host = this.$root.find(`#${id}`)[0];
		if (!host) return;
		if (!items.length) { host.innerHTML = `<div class="cco-empty">${__("Sem dados.")}</div>`; return; }
		const mx = Math.max(...items.map((i) => i.val), 1);
		host.innerHTML = items.map((it, i) => `
			<div class="cco-rank-row">
			  <span class="cco-rank-name" title="${frappe.utils.escape_html(it.name || "")}">${it.name ? frappe.utils.escape_html(it.name) : "—"}</span>
			  <div class="cco-rank-track"><div class="cco-rank-bar ${i === 0 ? "first" : ""}" data-w="${(it.val / mx) * 100}"></div></div>
			  <span class="cco-rank-val cco-num">${this._fmt(it.val)}</span>
			</div>`).join("");
		this._raf2(() => host.querySelectorAll(".cco-rank-bar").forEach((b, i) =>
			setTimeout(() => (b.style.width = b.dataset.w + "%"), 45 * i)));
	}

	// rank with a secondary (alocadas) fill over the total track
	_rank2(id, items) {
		const host = this.$root.find(`#${id}`)[0];
		if (!host) return;
		if (!items.length) { host.innerHTML = `<div class="cco-empty">${__("Sem dados.")}</div>`; return; }
		const mx = Math.max(...items.map((i) => i.total), 1);
		host.innerHTML = items.map((it) => `
			<div class="cco-rank-row">
			  <span class="cco-rank-name" title="${frappe.utils.escape_html(it.name || "")}">${frappe.utils.escape_html(it.name || "—")}</span>
			  <div class="cco-rank-track">
			    <div class="cco-rank-bar ghost" data-w="${(it.total / mx) * 100}"></div>
			    <div class="cco-rank-bar over" data-w="${(it.alocadas / mx) * 100}"></div>
			  </div>
			  <span class="cco-rank-val cco-num">${this._fmt(it.alocadas)}<span class="cco-rank-sub">/ ${this._fmt(it.total)}</span></span>
			</div>`).join("");
		this._raf2(() => host.querySelectorAll(".cco-rank-bar").forEach((b, i) =>
			setTimeout(() => (b.style.width = b.dataset.w + "%"), 30 * i)));
	}

	_donut(id, segs) {
		const host = this.$root.find(`#${id}`)[0];
		if (!host) return;
		segs = (segs || []).filter((s) => s.val > 0);
		if (!segs.length) { host.innerHTML = `<div class="cco-empty">${__("Sem dados.")}</div>`; return; }
		const total = segs.reduce((s, x) => s + x.val, 0) || 1;
		const R = 52, C = 2 * Math.PI * R; let off = 0;
		const rings = segs.map((s) => {
			const len = (s.val / total) * C;
			const seg = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${s.color}" stroke-width="15"
				stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"/>`;
			off += len; return seg;
		}).join("");
		const legend = segs.map((s) => `<div class="cco-dleg-i"><i style="background:${s.color}"></i>
			<span>${frappe.utils.escape_html(s.label || "—")}</span><b class="cco-num">${this._fmt(s.val)}</b>
			<em>${Math.round((s.val / total) * 100)}%</em></div>`).join("");
		host.innerHTML = `<div class="cco-donut"><svg viewBox="0 0 140 140" width="140" height="140">${rings}
			<text x="70" y="66" text-anchor="middle" class="cco-donut-c">${this._fmt(total)}</text>
			<text x="70" y="84" text-anchor="middle" class="cco-donut-l">TOTAL</text></svg>
			<div class="cco-dleg">${legend}</div></div>`;
	}

	_stackbar(id, segs) {
		const host = this.$root.find(`#${id}`)[0];
		if (!host) return;
		segs = (segs || []).filter((s) => s.val > 0);
		if (!segs.length) { host.innerHTML = `<div class="cco-empty">${__("Sem dados.")}</div>`; return; }
		const total = segs.reduce((s, x) => s + x.val, 0) || 1;
		const bar = segs.map((s) => `<span class="cco-stk-seg" data-w="${(s.val / total) * 100}" style="background:${s.color}" title="${frappe.utils.escape_html(s.label)}: ${s.val}"></span>`).join("");
		const legend = segs.map((s) => `<div class="cco-stk-leg"><i style="background:${s.color}"></i>
			<span>${frappe.utils.escape_html(s.label || "—")}</span><b class="cco-num">${this._fmt(s.val)}</b>
			<em>${Math.round((s.val / total) * 100)}%</em></div>`).join("");
		host.innerHTML = `<div class="cco-stk"><div class="cco-stk-bar">${bar}</div><div class="cco-stk-legs">${legend}</div></div>`;
		this._raf2(() => host.querySelectorAll(".cco-stk-seg").forEach((s) => (s.style.flexBasis = s.dataset.w + "%")));
	}

	// date-series area/line; pct mode adds a meta reference line + best/worst markers
	_trend(hostId, xId, pts, opts) {
		const host = this.$root.find(`#${hostId}`)[0];
		const xhost = this.$root.find(`#${xId}`)[0];
		if (!host) return;
		opts = opts || {};
		const color = opts.color || this.C.accent;
		const vals = pts.map((p) => (p.v == null ? 0 : p.v));
		if (!pts.length || !vals.some((v) => v)) {
			host.innerHTML = `<div class="cco-empty">${__("Sem dados no período.")}</div>`;
			if (xhost) xhost.innerHTML = ""; return;
		}
		const W = 760, H = 200, padX = 6, padT = 16, padB = 6, n = pts.length;
		const yMax = opts.yMax || Math.max(...vals) * 1.18 || 1;
		const x = (i) => padX + i * (W - 2 * padX) / (n - 1 || 1);
		const y = (v) => padT + (1 - v / yMax) * (H - padT - padB);
		const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.v == null ? 0 : p.v).toFixed(1)}`).join(" ");
		const fill = `M${x(0).toFixed(1)},${(H - padB).toFixed(1)} L${line.replace(/ /g, " L")} L${x(n - 1).toFixed(1)},${(H - padB).toFixed(1)} Z`;

		let metaLine = "";
		if (opts.meta != null) {
			const my = y(opts.meta).toFixed(1);
			metaLine = `<line x1="${padX}" y1="${my}" x2="${W - padX}" y2="${my}" stroke="${this.C.accentInk}" stroke-width="1" stroke-dasharray="4 4" opacity="0.5"/>`;
		}
		let markers = "";
		const showDots = n <= 31 && !opts.pct;
		if (showDots) markers = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v == null ? 0 : p.v).toFixed(1)}" r="2.4" fill="${color}"/>`).join("");
		if (opts.pct) {
			pts.forEach((p, i) => {
				if (p.label === opts.best) markers += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4" fill="${this.C.good}" stroke="${this.C.stroke}" stroke-width="1.5"/>`;
				if (p.label === opts.worst) markers += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4" fill="${this.C.bad}" stroke="${this.C.stroke}" stroke-width="1.5"/>`;
			});
		}
		host.innerHTML = `
		<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="cco-trend-svg" style="width:100%;height:200px">
		  <defs><linearGradient id="cg-${hostId}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stop-color="${color}" stop-opacity="0.22"/>
			<stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
		  ${metaLine}
		  <path d="${fill}" fill="url(#cg-${hostId})"/>
		  <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
		  ${markers}
		</svg>`;

		if (xhost) {
			const step = Math.max(1, Math.ceil(n / 7));
			xhost.innerHTML = pts.map((p, i) =>
				`<span>${(i % step === 0 || i === n - 1) ? this._dlabel(p.label) : ""}</span>`).join("");
		}
	}

	// ============================================================ TABLES (filterable)
	_rank_table(hostId, rows, cfg) {
		const host = this.$root.find(`#${hostId}`)[0];
		if (!host) return;
		this._tables.push({ host, rows: rows || [], cfg });
		this._paint_table(host, rows || [], cfg);
	}

	_filter_tables() {
		const t = (this.state.busca || "").trim().toLowerCase();
		this._tables.forEach(({ host, rows, cfg }) => {
			const filtered = !t ? rows : rows.filter((r) => (cfg.search || []).some((k) => String(r[k] || "").toLowerCase().includes(t)));
			this._paint_table(host, filtered, cfg);
		});
	}

	_paint_table(host, rows, cfg) {
		if (!rows.length) { host.innerHTML = `<div class="cco-empty">${cfg.empty || __("Sem dados.")}</div>`; return; }
		const head = cfg.cols.map((c) => `<th class="${c.num || c.gauge ? "r" : ""}">${c.label}</th>`).join("");
		const body = rows.map((r, idx) => {
			const tds = cfg.cols.map((c) => {
				let v = r[c.key];
				if (c.gauge) {
					const pct = v == null ? null : v;
					if (pct == null) return `<td class="r"><span class="cco-gauge-na">—</span></td>`;
					const tone = pct >= (c.meta || 95) ? "ok" : pct >= (c.meta || 95) - 10 ? "warn" : "under";
					return `<td class="r"><div class="cco-gauge"><div class="cco-gauge-tr"><span class="cco-gauge-fill ${tone}" style="width:${Math.min(pct, 100)}%"></span></div><b class="cco-num">${pct}%</b></div></td>`;
				}
				if (c.bar) {
					const pct = c.max ? Math.round(((r[c.key] || 0) / c.max) * 100) : 0;
					return `<td class="r"><div class="cco-barcell"><span class="cco-bar ${c.bar}" style="width:${pct}%"></span><b class="cco-num">${this._fmt(v || 0)}</b></div></td>`;
				}
				if (c.main) {
					const route = c.route ? (r[c.code] || r[c.key]) : null;
					const sub = c.code && r[c.code] && r[c.code] !== v ? `<span class="cco-rt-code">${frappe.utils.escape_html(r[c.code])}</span>` : "";
					return `<td class="main ${route ? "clk" : ""}" data-route="${c.route ? frappe.utils.escape_html(c.route) : ""}" data-name="${route ? frappe.utils.escape_html(route) : ""}">
						<span class="cco-rt-rank">${idx + 1}</span><span class="cco-rt-name">${frappe.utils.escape_html(String(v == null || v === "" ? "—" : v))}</span>${sub}</td>`;
				}
				if (c.badgeKey && r[c.badgeKey]) {
					return `<td class="r cco-num">${this._fmt(v || 0)} <span class="cco-grave-badge">${this._fmt(r[c.badgeKey])} ${__("graves")}</span></td>`;
				}
				return `<td class="${c.num ? "r cco-num" : ""}">${v == null || v === "" ? "—" : frappe.utils.escape_html(String(this._fmt ? (c.num ? this._fmt(v) : v) : v))}</td>`;
			}).join("");
			return `<tr>${tds}</tr>`;
		}).join("");
		host.innerHTML = `<table class="cco-table ${cfg.cls || ""}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
		host.querySelectorAll("td.main.clk[data-name]").forEach((el) => {
			if (!el.getAttribute("data-name")) return;
			el.addEventListener("click", () => frappe.set_route("Form", el.getAttribute("data-route"), el.getAttribute("data-name")));
		});
	}

	// ============================================================ THEME
	_apply_theme() {
		const dark = this.theme === "dark";
		this.page.main.toggleClass("theme-dark", dark);
		this.C = this._palettes[this.theme];
		this.$root.find(".cco-theme").html(dark ? this._icon_sun() : this._icon_moon());
	}
	_toggle_theme() {
		this.theme = this.theme === "dark" ? "light" : "dark";
		localStorage.setItem(this.THEME_KEY, this.theme);
		this._apply_theme();
		if (this.data) this._render();
	}
	_icon_sun() {
		return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>`;
	}
	_icon_moon() {
		return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z"/></svg>`;
	}

	// ============================================================ UTILS
	_maxBy(rows, key) { return (rows || []).reduce((m, r) => Math.max(m, r[key] || 0), 0); }
	_dlabel(iso) { const p = (iso || "").split("-"); return p.length === 3 ? p[2] + "/" + p[1] : iso; }
	_raf2(fn) { requestAnimationFrame(() => requestAnimationFrame(fn)); }
	_grav_color(g) { return { "Crítica": this.C.bad, "Alta": this.C.amber, "Média": this.C.info, "Baixa": this.C.good }[g] || this.C.graphite; }
	_estado_color(e) { return { "Aberta": this.C.bad, "Em Investigação": this.C.amber, "Resolvida": this.C.good, "Fechada": this.C.graphite }[e] || this.C.ink3; }
	_stamp() {
		const now = frappe.datetime.str_to_user(this.data.gerado_em);
		this.$root.find(".cco-stamp").text(__("Actualizado") + " " + (now || "").split(" ").slice(1).join(" "));
	}

	// ============================================================ FONTS + CSS
	_inject_fonts() {
		if (document.getElementById("cco-fonts")) return;
		const l = document.createElement("link");
		l.id = "cco-fonts"; l.rel = "stylesheet";
		l.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";
		document.head.appendChild(l);
	}

	_inject_css() {
		if (document.getElementById("cco-css")) return;
		const css = `
/* SIGOS Painel CCO - Operations Daylight. ASCII-only. */
.sigos-cco { background:#F4F6FA; }
.layout-main-section-wrapper:has(.sigos-cco), .page-body:has(.sigos-cco) { background:#F4F6FA; }
.sigos-cco .page-head, .sigos-cco + .page-head { display:none; }
.cco-root {
  --paper:#F4F6FA; --paper2:#FFFFFF; --paper3:#EEF1F6; --ink:#0E1726; --ink2:#5B6B82;
  --ink3:#93A1B5; --line:#E6EAF2; --line2:#D5DCE8; --accent:#4F46E5; --accentInk:#4338CA;
  --wash:rgba(79,70,229,.07); --good:#16A34A; --bad:#E5484D; --amber:#F59E0B; --info:#2F6FED;
  --graphite:#64748B; --goodWash:rgba(22,163,74,.12); --badWash:rgba(229,72,77,.12);
  --display:'Space Grotesk',system-ui,sans-serif; --body:'Inter',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
  --shadow:0 1px 2px rgba(16,23,38,.04), 0 14px 34px -20px rgba(16,23,38,.22);
  --r:16px;
  position:relative; max-width:1200px; margin:0 auto; padding:8px 14px 80px;
  color:var(--ink); font-family:var(--body); font-size:13px; font-feature-settings:"tnum" 1; -webkit-font-smoothing:antialiased;
}
.cco-num { font-family:var(--display); font-feature-settings:"tnum" 1; letter-spacing:-.01em; }
.cco-up { font-family:var(--body); text-transform:uppercase; letter-spacing:.12em; font-size:10px; color:var(--ink3); font-weight:600; }

/* masthead */
.cco-mast { display:flex; justify-content:space-between; align-items:flex-start; padding:20px 4px 14px; gap:16px; flex-wrap:wrap; }
.cco-mast-l { display:flex; align-items:flex-start; gap:15px; }
.cco-mark { width:42px; height:42px; border-radius:13px; display:grid; place-items:center; flex:none;
  background:linear-gradient(150deg,var(--accent),var(--accentInk)); color:#fff; font-family:var(--display); font-size:21px; font-weight:600;
  box-shadow:0 6px 16px -6px rgba(79,70,229,.6); }
.cco-eyebrow { margin-bottom:4px; }
.cco-h1 { font-family:var(--display); font-weight:600; font-size:27px; line-height:1; letter-spacing:-.02em; margin:0; color:var(--ink); }
.cco-dateline { font-family:var(--body); font-size:13px; color:var(--ink2); margin-top:7px; font-weight:500; }
.cco-dl-days { color:var(--ink3); }
.cco-mast-r { display:flex; gap:10px; align-items:center; }
.cco-pulse { display:inline-flex; align-items:center; gap:7px; color:var(--ink3); font-size:10px; text-transform:uppercase; letter-spacing:.08em; font-weight:600; }
.cco-pulse i { width:7px; height:7px; border-radius:50%; background:var(--good); box-shadow:0 0 0 3px var(--goodWash); animation:cco-blip 2.4s ease-in-out infinite; }
@keyframes cco-blip { 0%,100%{opacity:1} 50%{opacity:.45} }
.cco-btn { font-family:var(--body); font-size:11px; font-weight:600; letter-spacing:.02em; border:1px solid var(--line2);
  background:var(--paper2); color:var(--ink2); padding:8px 14px; border-radius:10px; cursor:pointer; transition:.2s; box-shadow:var(--shadow); }
.cco-btn:hover { border-color:var(--accent); color:var(--accent); }
.cco-refresh:hover { background:var(--accent); color:#fff; border-color:var(--accent); }

/* controls */
.cco-controls { display:flex; flex-wrap:wrap; gap:12px 20px; align-items:center; margin:10px 4px 4px; }
.cco-ctl-grp { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.cco-ctl-grp.cco-scope { flex:1; justify-content:flex-end; }
.cco-ctl-lbl { font-family:var(--body); text-transform:uppercase; letter-spacing:.1em; font-size:9.5px; color:var(--ink3); font-weight:600; }
.cco-pills { display:flex; gap:3px; background:var(--paper3); border:1px solid var(--line); border-radius:11px; padding:3px; }
.cco-pill { font-family:var(--body); font-size:11px; font-weight:600; border:0; background:transparent; color:var(--ink2);
  padding:6px 13px; border-radius:8px; cursor:pointer; transition:.18s; }
.cco-pill:hover { color:var(--ink); } .cco-pill.on { background:var(--paper2); color:var(--accent); box-shadow:0 1px 3px rgba(16,23,38,.12); }
.cco-range { display:flex; gap:8px; }
.cco-date { display:flex; flex-direction:column; gap:3px; }
.cco-date label { font-size:8.5px; }
.cco-filter { min-width:140px; }
.cco-filters { display:flex; gap:8px; flex-wrap:wrap; }
.cco-root .cco-date-i input, .cco-root .cco-filter input { background:var(--paper2) !important; color:var(--ink) !important;
  border:1px solid var(--line2) !important; border-radius:10px !important; height:32px !important; font-family:var(--body) !important; font-size:12px !important; box-shadow:none !important; }
.cco-root .cco-date-i input { min-width:120px; }
.cco-search { display:flex; align-items:center; gap:8px; background:var(--paper2); border:1px solid var(--line2); border-radius:10px; padding:0 12px; height:32px; }
.cco-search svg { width:13px; height:13px; color:var(--ink3); flex:none; }
.cco-search input { border:0; background:transparent; outline:0; font-family:var(--body); font-size:12px; color:var(--ink); width:150px; }

/* sections */
.cco-sec { display:flex; align-items:center; gap:13px; margin:40px 4px 18px; }
.cco-sec-bar { width:4px; height:20px; border-radius:3px; background:var(--accent); flex:none; }
.cco-sec-title { font-family:var(--display); font-size:19px; font-weight:600; letter-spacing:-.01em; margin:0; }
.cco-sec-line { flex:1; height:1px; background:var(--line); }
.cco-sec-aside { font-size:11px; color:var(--ink3); font-weight:500; }

/* KPIs */
.cco-kpis { display:grid; grid-template-columns:repeat(6,1fr); gap:14px; margin-top:18px; }
.cco-kpi { background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); padding:16px 17px 15px; display:flex; flex-direction:column; min-width:0; }
.cco-kpi.feature { border-color:transparent; box-shadow:0 1px 2px rgba(16,23,38,.04), 0 18px 40px -22px rgba(79,70,229,.45); position:relative; }
.cco-kpi.feature::before { content:""; position:absolute; inset:0; border-radius:var(--r); padding:1px; background:linear-gradient(150deg,var(--accent),transparent 60%); -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0); -webkit-mask-composite:xor; mask-composite:exclude; pointer-events:none; }
.cco-kpi-top { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; min-height:16px; }
.cco-kpi-lbl { flex:1; min-width:0; font-size:9.5px; letter-spacing:.08em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cco-kpi-top .cco-delta { flex:none; }
.cco-kpi-mid { display:flex; align-items:flex-end; justify-content:space-between; gap:8px; }
.cco-kpi-val { font-family:var(--display); font-weight:600; font-size:32px; line-height:.95; letter-spacing:-.025em; color:var(--ink); }
.cco-kpi.feature .cco-kpi-val { color:var(--accentInk); }
.cco-kpi.tone-bad .cco-kpi-val { color:var(--bad); }
.cco-kpi-spark { flex:none; width:50%; max-width:118px; }
.cco-spark { width:100%; height:34px; display:block; }
.cco-kpi-foot { margin-top:12px; min-height:14px; }
.cco-kpi-sub { font-size:10px; color:var(--ink3); text-transform:uppercase; letter-spacing:.07em; font-weight:600; }
.cco-delta { font-family:var(--body); font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; white-space:nowrap; }
.cco-delta.up { color:var(--good); background:var(--goodWash); }
.cco-delta.down { color:var(--bad); background:var(--badWash); }
.cco-delta.flat { color:var(--ink3); background:var(--paper3); }
.cco-meta { }
.cco-meta-tr { position:relative; height:5px; background:var(--paper3); border-radius:3px; }
.cco-meta-fill { position:absolute; left:0; top:0; bottom:0; border-radius:3px; background:var(--good); transition:width .8s cubic-bezier(.2,.9,.25,1); }
.cco-meta-fill.under { background:var(--bad); }
.cco-meta-tick { position:absolute; top:-2px; width:1.5px; height:9px; background:var(--ink2); border-radius:1px; transform:translateX(-50%); }
.cco-meta-lbl { display:block; margin-top:6px; font-size:9px; text-transform:uppercase; letter-spacing:.07em; color:var(--ink3); font-weight:600; }
@media (max-width:1080px){ .cco-kpis { grid-template-columns:repeat(3,1fr); } }
@media (max-width:640px){ .cco-kpis { grid-template-columns:repeat(2,1fr); } }

/* cards */
.cco-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-bottom:18px; }
.cco-card { background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); padding:22px 24px; margin-bottom:18px; min-width:0; }
.cco-grid2 .cco-card { margin-bottom:0; }
.cco-card-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px; }
.cco-card-title { font-family:var(--display); font-size:16px; font-weight:600; letter-spacing:-.01em; }
.cco-card-sub { font-size:11px; color:var(--ink3); margin-top:3px; font-weight:500; }
.cco-card-body { margin-top:18px; }
.cco-empty { padding:26px; text-align:center; color:var(--ink3); font-size:12px; }

/* trend */
.cco-trend-host { margin-top:8px; }
.cco-trendx { display:flex; margin-top:9px; }
.cco-trendx span { flex:1; text-align:center; font-size:9.5px; color:var(--ink3); white-space:nowrap; overflow:hidden; font-weight:500; }
.cco-callouts { display:flex; gap:8px; flex-wrap:wrap; margin:4px 0 8px; }
.cco-callout { font-size:10.5px; color:var(--ink2); background:var(--paper3); border:1px solid var(--line); border-radius:999px; padding:4px 11px; display:inline-flex; gap:6px; align-items:center; font-weight:500; }
.cco-callout b { font-family:var(--display); font-size:12px; font-weight:600; }
.cco-callout i { font-style:normal; font-size:9px; }
.cco-callout.good i { color:var(--good); } .cco-callout.bad i { color:var(--bad); } .cco-callout.meta i { color:var(--accent); }

/* rank */
.cco-rank-row { display:grid; grid-template-columns:120px 1fr 78px; align-items:center; gap:14px; margin-bottom:14px; }
.cco-rank-row:last-child { margin-bottom:0; }
.cco-rank-name { font-size:12px; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:500; }
.cco-rank-track { height:9px; background:var(--paper3); border-radius:6px; overflow:hidden; position:relative; }
.cco-rank-bar { height:100%; width:0; background:var(--graphite); border-radius:6px; transition:width .9s cubic-bezier(.2,.9,.25,1); }
.cco-rank-bar.first { background:var(--accent); }
.cco-rank-bar.ghost { background:var(--line2); }
.cco-rank-bar.over { background:var(--accent); position:absolute; left:0; top:0; }
.cco-rank-val { font-family:var(--display); font-size:15px; text-align:right; font-weight:600; }
.cco-rank-sub { font-family:var(--mono); font-size:9.5px; color:var(--ink3); margin-left:3px; font-weight:400; }

/* donut */
.cco-donut { display:flex; align-items:center; gap:24px; flex-wrap:wrap; }
.cco-donut-c { font-family:var(--display); font-size:20px; font-weight:600; fill:var(--ink); }
.cco-donut-l { font-family:var(--body); font-size:7px; font-weight:600; letter-spacing:.18em; fill:var(--ink3); }
.cco-dleg { display:flex; flex-direction:column; gap:9px; flex:1; min-width:150px; }
.cco-dleg-i { display:grid; grid-template-columns:11px 1fr auto auto; align-items:center; gap:9px; font-size:12px; color:var(--ink2); }
.cco-dleg-i i { width:11px; height:11px; border-radius:3px; }
.cco-dleg-i b { font-family:var(--display); font-size:14px; color:var(--ink); font-weight:600; }
.cco-dleg-i em { font-style:normal; font-size:10px; color:var(--ink3); min-width:32px; text-align:right; font-weight:500; }

/* stacked bar */
.cco-stk-bar { display:flex; height:16px; border-radius:6px; overflow:hidden; background:var(--paper3); }
.cco-stk-seg { flex-grow:0; flex-shrink:0; flex-basis:0; transition:flex-basis .8s cubic-bezier(.2,.9,.25,1); }
.cco-stk-legs { display:flex; flex-direction:column; gap:9px; margin-top:16px; }
.cco-stk-leg { display:grid; grid-template-columns:11px 1fr auto auto; align-items:center; gap:9px; font-size:12px; color:var(--ink2); }
.cco-stk-leg i { width:11px; height:11px; border-radius:3px; }
.cco-stk-leg b { font-family:var(--display); font-size:14px; color:var(--ink); font-weight:600; }
.cco-stk-leg em { font-style:normal; font-size:10px; color:var(--ink3); min-width:32px; text-align:right; font-weight:500; }

/* big stat (resolucao) */
.cco-bigstat { padding:6px 0 14px; border-bottom:1px solid var(--line); }
.cco-bigstat-v { font-family:var(--display); font-weight:600; font-size:38px; line-height:.95; color:var(--accentInk); letter-spacing:-.02em; }
.cco-bigstat-l { display:block; margin-top:8px; }
.cco-ministats { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:16px; }
.cco-ministats b { font-family:var(--display); font-size:22px; font-weight:600; display:block; }
.cco-ministats span { font-size:9.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink3); font-weight:600; }
.cco-bad { color:var(--bad); }

/* parque (armamento) */
.cco-parque { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; }
.cco-pq { text-align:center; padding:16px 8px; border:1px solid var(--line); border-radius:12px; background:var(--paper3); border-top:3px solid var(--graphite); }
.cco-pq-v { font-family:var(--display); font-size:28px; font-weight:600; display:block; line-height:1; }
.cco-pq-l { display:block; margin-top:7px; }
.cco-pq-good { border-top-color:var(--good); } .cco-pq-accent { border-top-color:var(--accent); }
.cco-pq-amber { border-top-color:var(--amber); } .cco-pq-bad { border-top-color:var(--bad); }
@media (max-width:620px){ .cco-parque { grid-template-columns:repeat(3,1fr); } }

/* tables */
.cco-table { width:100%; border-collapse:collapse; }
.cco-table thead th { font-family:var(--body); font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink3);
  font-weight:600; text-align:left; padding:9px 10px; border-bottom:1px solid var(--line2); }
.cco-table th.r, .cco-table td.r { text-align:right; }
.cco-table tbody td { padding:11px 10px; border-bottom:1px solid var(--line); font-size:12.5px; color:var(--ink2); }
.cco-table tbody tr:last-child td { border-bottom:0; }
.cco-table tbody tr:hover { background:var(--wash); }
.cco-table td.main { display:flex; align-items:baseline; gap:9px; }
.cco-table td.main.clk { cursor:pointer; }
.cco-rt-rank { font-family:var(--mono); font-size:10px; color:var(--ink3); min-width:14px; }
.cco-rt-name { color:var(--ink); font-weight:500; }
.cco-table td.main.clk:hover .cco-rt-name { color:var(--accent); }
.cco-rt-code { font-family:var(--mono); font-size:9.5px; color:var(--ink3); }
.cco-table td.r.cco-num, .cco-table td .cco-num { font-size:14px; font-weight:600; color:var(--ink); }
.cco-barcell { display:flex; align-items:center; justify-content:flex-end; gap:9px; position:relative; min-height:16px; }
.cco-barcell .cco-bar { position:absolute; right:0; height:7px; border-radius:4px; opacity:.22; }
.cco-barcell b { position:relative; }
.cco-bar.bad { background:var(--bad); } .cco-bar.accent { background:var(--accent); } .cco-bar.graphite { background:var(--graphite); }
.cco-grave-badge { font-family:var(--body); font-size:9px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--bad); background:var(--badWash); border-radius:999px; padding:2px 7px; }
.cco-gauge { display:flex; align-items:center; justify-content:flex-end; gap:9px; }
.cco-gauge-tr { width:74px; height:7px; background:var(--paper3); border-radius:4px; overflow:hidden; }
.cco-gauge-fill { display:block; height:100%; border-radius:4px; }
.cco-gauge-fill.ok { background:var(--good); } .cco-gauge-fill.warn { background:var(--amber); } .cco-gauge-fill.under { background:var(--bad); }
.cco-gauge b { font-family:var(--display); font-size:13px; min-width:38px; text-align:right; font-weight:600; }
.cco-gauge-na { color:var(--ink3); }
.cco-scoretable thead th { border-bottom-width:1.5px; }

/* reveal */
.cco-rise { opacity:0; transform:translateY(12px); animation:cco-rise .6s cubic-bezier(.2,.9,.25,1) forwards; }
.cco-rise:nth-of-type(2){animation-delay:.04s}.cco-rise:nth-of-type(3){animation-delay:.08s}
.cco-rise:nth-of-type(4){animation-delay:.12s}.cco-rise:nth-of-type(5){animation-delay:.16s}
@keyframes cco-rise { to { opacity:1; transform:none; } }
@media (prefers-reduced-motion:reduce){ .cco-rise{ animation:none; opacity:1; transform:none; } .cco-spark,.cco-rank-bar,.cco-meta-fill,.cco-stk-seg{ transition:none; } }

@media (max-width:880px){ .cco-grid2 { grid-template-columns:1fr; } .cco-grid2 .cco-card { margin-bottom:18px; } }

/* theme toggle button */
.cco-icon { padding:7px; width:34px; display:inline-grid; place-items:center; }
.cco-icon svg { width:15px; height:15px; }

/* smooth theme switch */
.sigos-cco { transition:background-color .35s ease; }
.cco-card, .cco-kpi, .cco-pq, .cco-callout, .cco-btn { transition:background-color .35s ease, border-color .35s ease, box-shadow .35s ease; }

/* ---------------------------------------------------------------- DARK THEME */
.sigos-cco.theme-dark { background:#0E1117; }
.layout-main-section-wrapper:has(.sigos-cco.theme-dark), .page-body:has(.sigos-cco.theme-dark) { background:#0E1117; }
.sigos-cco.theme-dark .cco-root {
  --paper:#0E1117; --paper2:#171B22; --paper3:#1F242E; --ink:#E8ECF3; --ink2:#A4AEC0;
  --ink3:#6B7688; --line:#242A34; --line2:#323A47; --accent:#7C83FF; --accentInk:#A5ABFF;
  --wash:rgba(124,131,255,.12); --good:#3DD68C; --bad:#FF6166; --amber:#FBBF4D; --info:#5AA2FF;
  --graphite:#7A8699; --goodWash:rgba(61,214,140,.14); --badWash:rgba(255,97,102,.14);
  --shadow:0 1px 2px rgba(0,0,0,.4), 0 18px 42px -24px rgba(0,0,0,.75);
}
.sigos-cco.theme-dark .cco-mark { box-shadow:0 6px 16px -6px rgba(124,131,255,.5); }
.sigos-cco.theme-dark .cco-pill.on { background:var(--paper2); }
`;
		const s = document.createElement("style");
		s.id = "cco-css"; s.textContent = css;
		document.head.appendChild(s);
	}
};
