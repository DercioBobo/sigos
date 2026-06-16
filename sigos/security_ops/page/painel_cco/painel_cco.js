// SIGOS — Painel CCO (estatístico). Editorial light, all-custom charts (no chart lib).
// Analytical sibling of the RH dashboard; shares the paper/Fraunces/terracotta language.
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
		this.theme = localStorage.getItem(this.THEME_KEY) || "dark"; // CCO defaults to dark
		this._palettes = {
			light: {
				accent: "#BC4A22", accentInk: "#8E3315", graphite: "#574E42", ink3: "#A99E8B",
				good: "#5E7A3E", bad: "#A8472E", amber: "#C99A52", stroke: "#FBF8F1",
				palette: ["#BC4A22", "#574E42", "#5E7A3E", "#C99A52", "#8C6A4F", "#7C8B5A", "#A8472E", "#9E8B6A"],
			},
			dark: {
				accent: "#D2622F", accentInk: "#E8865A", graphite: "#8A7A66", ink3: "#7D7165",
				good: "#7BA35C", bad: "#D2452A", amber: "#D69A3C", stroke: "#171310",
				palette: ["#D2622F", "#C99A6A", "#7BA35C", "#D6A94C", "#B98A5E", "#9DB36A", "#D2452A", "#B49A72"],
			},
		};
		this.C = this._palettes[this.theme];
		this._tables = [];
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
      <div>
        <div class="cco-wordmark"><b>SIGOS</b></div>
        <div class="cco-eyebrow"><span class="cco-tick"></span><span class="cco-up">Painel CCO &middot; Centro de Controlo Operacional</span></div>
      </div>
    </div>
    <div class="cco-mast-r">
      <div class="cco-dateline">&mdash;</div>
      <div class="cco-mast-meta">
        <span class="cco-pulse"><i></i><span class="cco-stamp">${__("A carregar...")}</span></span>
        <button class="cco-btn cco-icon cco-theme" title="${__("Tema claro / escuro")}" aria-label="theme"></button>
        <button class="cco-btn cco-refresh">${__("Actualizar")}</button>
      </div>
    </div>
  </header>
  <div class="cco-rule cco-rise"></div>

  <div class="cco-controls cco-rise">
    <div class="cco-ctl-grp">
      <span class="cco-ctl-lbl">${__("Período")}</span>
      <div class="cco-pills"></div>
      <div class="cco-range"></div>
    </div>
    <div class="cco-ctl-grp cco-scope">
      <span class="cco-ctl-lbl">${__("Âmbito")}</span>
      <div class="cco-filters"></div>
      <div class="cco-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="text" placeholder="${__("Filtrar tabelas...")}">
      </div>
    </div>
  </div>

  <div class="cco-kpis cco-rise"></div>

  ${this._sec("01", "Cobertura &amp; Efectivo", "Escala publicada vs faltas e férias")}
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

  ${this._sec("02", "Scorecard Regional", "Estado por delegação", "", "score")}
  <div class="cco-card cco-span">
    <div id="cco-scorecard"></div>
  </div>

  ${this._sec("03", "Ocorrências", "Incidentes registados")}
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

  ${this._sec("04", "Ausências &amp; Reserva", "Faltas e capacidade disponível")}
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

  ${this._sec("05", "Armamento", "Parque e distribuição")}
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

	_sec(idx, title, aside, right, cls) {
		return `<div class="cco-sec ${cls ? "cco-sec-" + cls : ""} cco-rise">
			<span class="cco-sec-idx">${idx}</span><h2 class="cco-sec-title">${title}</h2>
			<span class="cco-sec-line"></span>${right || `<span class="cco-sec-aside">${aside}</span>`}</div>`;
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
		const tiles = [
			this._kpi("Cobertura Média", k.cobertura_media, k.cobertura_media_prev, true, "%", { feature: true, meta: k.meta_cobertura }),
			this._kpi("Slots Descobertos", k.gap_slots, k.gap_slots_prev, false, "", {}),
			this._kpi("Ocorrências", k.ocorrencias, k.ocorrencias_prev, false, "", {}),
			this._kpi("Graves", k.ocorrencias_graves, k.ocorrencias_graves_prev, false, "", { tone: "bad", sub: "Alta / Crítica" }),
			this._kpi("Taxa Substituição", k.taxa_substituicao, k.taxa_substituicao_prev, true, "%", {}),
			this._kpi("Reserva", k.reserva, null, true, "", { sub: "disponível" }),
		];
		this.$root.find(".cco-kpis").html(tiles.join(""));
		this._countup();
	}

	_kpi(label, val, prev, higher_better, suffix, o) {
		o = o || {};
		const dec = suffix === "%" ? 1 : 0;
		let delta = `<span class="cco-dsub">${o.sub || "&nbsp;"}</span>`;
		if (prev !== null && prev !== undefined) {
			const diff = Math.round((val - prev) * 10) / 10;
			if (!diff) delta = `<span class="cco-delta flat">&plusmn;0</span><span class="cco-dsub">${__("vs anterior")}</span>`;
			else {
				const up = diff > 0, good = higher_better ? up : !up;
				delta = `<span class="cco-delta ${good ? "up" : "down"}">${up ? "&#9650;" : "&#9660;"} ${Math.abs(diff)}${suffix}</span><span class="cco-dsub">${__("vs anterior")}</span>`;
			}
		}
		let meta = "";
		if (o.meta != null) {
			const ok = (Number(val) || 0) >= o.meta;
			meta = `<div class="cco-meta-bar"><span style="width:${Math.min(Number(val) || 0, 100)}%" class="${ok ? "ok" : "under"}"></span>
				<em>${__("Meta")} ${o.meta}%</em></div>`;
		}
		const shown = (val === null || val === undefined) ? "—" : "";
		return `
			<div class="cco-kpi ${o.feature ? "cco-feature" : ""} ${o.tone === "bad" ? "cco-tone-bad" : ""}">
				<div class="cco-kpi-lbl"><span class="cco-up">${label}</span></div>
				<div class="cco-kpi-val cco-num" data-to="${val == null ? 0 : val}" data-dec="${dec}" data-suffix="${suffix}">${shown || "0"}</div>
				${meta}
				<div class="cco-kpi-foot">${delta}</div>
			</div>`;
	}

	_render_cobertura() {
		const c = this.data.cobertura || {};
		// callouts: best / worst day
		const co = [];
		if (c.melhor_dia) co.push(`<span class="cco-callout good"><i>&#9650;</i>${__("Melhor")} ${this._dlabel(c.melhor_dia.data)} &middot; <b>${c.melhor_dia.pct}%</b></span>`);
		if (c.pior_dia) co.push(`<span class="cco-callout bad"><i>&#9660;</i>${__("Pior")} ${this._dlabel(c.pior_dia.data)} &middot; <b>${c.pior_dia.pct}%</b></span>`);
		co.push(`<span class="cco-callout meta"><i>&#9472;</i>${__("Meta")} <b>${c.meta || 95}%</b></span>`);
		this.$root.find("#cco-cob-callouts").html(co.join(""));

		const pts = (c.trend || []).map((d) => ({ label: d.data, v: d.pct }));
		this._trend("cco-cob-trend", "cco-cob-x", pts, {
			pct: true, yMax: 100, meta: c.meta || 95,
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
			["Abatidas", g.abatidas, "bad"],
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
			const suffix = el.getAttribute("data-suffix") || "", t0 = performance.now(), dur = 900, self = this;
			(function tick(t) {
				const p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3), cur = to * e;
				el.textContent = (dec ? cur.toFixed(dec) : self._fmt(Math.round(cur))) + suffix;
				if (p < 1) requestAnimationFrame(tick);
			})(t0);
		});
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
			const seg = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${s.color}" stroke-width="16"
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
			metaLine = `<line x1="${padX}" y1="${my}" x2="${W - padX}" y2="${my}" stroke="${this.C.accentInk}" stroke-width="1" stroke-dasharray="4 4" opacity="0.55"/>`;
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
			<stop offset="0%" stop-color="${color}" stop-opacity="0.20"/>
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
	_grav_color(g) { return { "Crítica": this.C.bad, "Alta": this.C.accent, "Média": this.C.amber, "Baixa": this.C.good }[g] || this.C.graphite; }
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
		l.href = "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500;600&display=swap";
		document.head.appendChild(l);
	}

	_inject_css() {
		if (document.getElementById("cco-css")) return;
		const css = `
/* SIGOS Painel CCO — editorial light. ASCII-only. */
.sigos-cco { background:#F4EFE4; }
.layout-main-section-wrapper:has(.sigos-cco), .page-body:has(.sigos-cco) { background:#F4EFE4; }
.sigos-cco .page-head, .sigos-cco + .page-head { display:none; }
.cco-root {
  --paper:#F4EFE4; --paper2:#FBF8F1; --paper3:#EFE8D8; --ink:#1B1712; --ink2:#6A6053;
  --ink3:#A99E8B; --line:#E1D7C4; --line2:#D2C6AF; --accent:#BC4A22; --accentInk:#8E3315;
  --wash:rgba(188,74,34,.08); --good:#5E7A3E; --bad:#A8472E; --amber:#C99A52; --graphite:#574E42;
  --serif:'Fraunces',Georgia,serif; --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
  --shadow:0 1px 2px rgba(40,30,15,.05), 0 12px 28px -18px rgba(40,30,15,.18);
  position:relative; max-width:1180px; margin:0 auto; padding:6px 12px 70px;
  color:var(--ink); font-family:var(--mono); font-size:13px; font-feature-settings:"tnum" 1;
}
.cco-root::before { content:""; position:fixed; inset:0; z-index:0; pointer-events:none; mix-blend-mode:multiply; opacity:.5;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.38'/%3E%3C/svg%3E"); }
.cco-root > * { position:relative; z-index:1; }
.cco-num { font-family:var(--serif); font-feature-settings:"tnum" 1; letter-spacing:-.01em; }
.cco-up { font-family:var(--mono); text-transform:uppercase; letter-spacing:.14em; font-size:10px; color:var(--ink3); font-weight:500; }

/* masthead */
.cco-mast { display:flex; justify-content:space-between; align-items:flex-end; padding:18px 4px 16px; }
.cco-mast-l { display:flex; align-items:flex-end; gap:16px; }
.cco-mark { width:44px; height:44px; border:1.5px solid var(--ink); border-radius:50%; display:grid; place-items:center;
  font-family:var(--serif); font-size:20px; font-weight:500; position:relative; flex:none; }
.cco-mark::after { content:""; position:absolute; inset:4px; border:1px solid var(--line2); border-radius:50%; }
.cco-wordmark { font-family:var(--serif); font-weight:400; font-size:34px; line-height:.9; letter-spacing:-.02em; }
.cco-wordmark b { font-weight:600; }
.cco-eyebrow { margin-top:7px; display:flex; gap:10px; align-items:center; }
.cco-tick { width:14px; height:1.5px; background:var(--accent); }
.cco-mast-r { text-align:right; display:flex; flex-direction:column; gap:6px; align-items:flex-end; }
.cco-dateline { font-family:var(--serif); font-size:15px; }
.cco-dl-days { color:var(--ink3); font-size:12px; }
.cco-mast-meta { display:flex; gap:14px; align-items:center; }
.cco-pulse { display:inline-flex; align-items:center; gap:6px; color:var(--good); font-size:10px; text-transform:uppercase; letter-spacing:.1em; }
.cco-pulse i { width:6px; height:6px; border-radius:50%; background:var(--good); animation:cco-blip 2.4s ease-in-out infinite; }
@keyframes cco-blip { 0%,100%{opacity:1} 50%{opacity:.4} }
.cco-btn { font-family:var(--mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.12em; border:1px solid var(--line2);
  background:var(--paper2); color:var(--ink); padding:7px 13px; border-radius:2px; cursor:pointer; transition:.25s; }
.cco-btn:hover { border-color:var(--accent); color:var(--accentInk); }
.cco-rule { height:1.5px; background:var(--ink); position:relative; }
.cco-rule::after { content:""; position:absolute; left:0; right:0; top:3px; height:1px; background:var(--line2); }

/* controls */
.cco-controls { display:flex; flex-wrap:wrap; gap:12px 24px; align-items:flex-end; margin:18px 4px 4px; }
.cco-ctl-grp { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.cco-ctl-grp.cco-scope { flex:1; justify-content:flex-end; }
.cco-ctl-lbl { font-family:var(--mono); text-transform:uppercase; letter-spacing:.14em; font-size:9.5px; color:var(--ink3); }
.cco-pills { display:flex; gap:3px; background:var(--paper3); border:1px solid var(--line); border-radius:3px; padding:3px; }
.cco-pill { font-family:var(--mono); font-size:10px; letter-spacing:.06em; border:0; background:transparent; color:var(--ink2);
  padding:5px 11px; border-radius:2px; cursor:pointer; transition:.2s; }
.cco-pill:hover { color:var(--ink); } .cco-pill.on { background:var(--ink); color:var(--paper2); }
.cco-range { display:flex; gap:8px; }
.cco-date { display:flex; flex-direction:column; gap:3px; }
.cco-date label { font-size:8.5px; }
.cco-filter { min-width:140px; }
.cco-filters { display:flex; gap:8px; flex-wrap:wrap; }
.cco-root .cco-date-i input, .cco-root .cco-filter input { background:var(--paper2) !important; color:var(--ink) !important;
  border:1px solid var(--line2) !important; border-radius:3px !important; height:30px !important; font-family:var(--mono) !important; font-size:11.5px !important; box-shadow:none !important; }
.cco-root .cco-date-i input { min-width:120px; }
.cco-search { display:flex; align-items:center; gap:8px; background:var(--paper2); border:1px solid var(--line2); border-radius:3px; padding:0 11px; height:30px; }
.cco-search svg { width:12px; height:12px; color:var(--ink3); flex:none; }
.cco-search input { border:0; background:transparent; outline:0; font-family:var(--mono); font-size:11.5px; color:var(--ink); width:150px; }

/* sections */
.cco-sec { display:flex; align-items:baseline; gap:14px; margin:42px 4px 18px; }
.cco-sec-idx { font-family:var(--mono); font-size:11px; color:var(--accent); font-weight:600; letter-spacing:.1em; }
.cco-sec-title { font-family:var(--serif); font-size:21px; font-weight:500; letter-spacing:-.01em; margin:0; }
.cco-sec-line { flex:1; height:1px; background:var(--line); align-self:center; }
.cco-sec-aside { font-size:10px; text-transform:uppercase; letter-spacing:.14em; color:var(--ink3); }

/* KPIs */
.cco-kpis { display:grid; grid-template-columns:repeat(6,1fr); gap:0; margin-top:18px; background:var(--paper2); border:1px solid var(--line); border-radius:4px; box-shadow:var(--shadow); overflow:hidden; }
.cco-kpi { padding:18px 18px 16px; border-left:1px solid var(--line); }
.cco-kpi:first-child { border-left:0; }
.cco-kpi-lbl { margin-bottom:12px; }
.cco-kpi-val { font-family:var(--serif); font-weight:300; font-size:38px; line-height:.9; letter-spacing:-.025em; }
.cco-feature { background:linear-gradient(180deg,var(--wash),transparent); }
.cco-feature .cco-kpi-val { color:var(--accentInk); }
.cco-tone-bad .cco-kpi-val { color:var(--bad); }
.cco-kpi-foot { margin-top:11px; display:flex; align-items:center; gap:8px; min-height:15px; }
.cco-delta { font-size:11px; font-weight:500; } .cco-delta.up { color:var(--good); } .cco-delta.down { color:var(--bad); } .cco-delta.flat { color:var(--ink3); }
.cco-dsub { font-size:9.5px; color:var(--ink3); text-transform:uppercase; letter-spacing:.1em; }
.cco-meta-bar { margin-top:10px; height:4px; background:var(--paper3); border-radius:3px; position:relative; }
.cco-meta-bar span { position:absolute; left:0; top:0; bottom:0; border-radius:3px; background:var(--good); }
.cco-meta-bar span.under { background:var(--bad); }
.cco-meta-bar em { position:absolute; right:0; top:7px; font-style:normal; font-size:8.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink3); }
@media (max-width:980px){ .cco-kpis { grid-template-columns:repeat(3,1fr); } .cco-kpi:nth-child(4){ border-left:0; } .cco-kpi:nth-child(n+4){ border-top:1px solid var(--line); } }

/* cards */
.cco-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-bottom:18px; }
.cco-card { background:var(--paper2); border:1px solid var(--line); border-radius:4px; box-shadow:var(--shadow); padding:22px 24px; margin-bottom:18px; min-width:0; }
.cco-grid2 .cco-card { margin-bottom:0; }
.cco-card-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px; }
.cco-card-title { font-family:var(--serif); font-size:18px; font-weight:500; letter-spacing:-.01em; }
.cco-card-sub { font-size:10px; text-transform:uppercase; letter-spacing:.13em; color:var(--ink3); margin-top:3px; }
.cco-card-body { margin-top:18px; }
.cco-empty { padding:26px; text-align:center; color:var(--ink3); font-size:11px; letter-spacing:.06em; }

/* trend */
.cco-trend-host { margin-top:8px; border-bottom:1px solid var(--line); }
.cco-trendx { display:flex; margin-top:9px; }
.cco-trendx span { flex:1; text-align:center; font-size:9px; letter-spacing:.02em; color:var(--ink3); white-space:nowrap; overflow:hidden; }
.cco-callouts { display:flex; gap:8px; flex-wrap:wrap; margin:4px 0 6px; }
.cco-callout { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink2); background:var(--paper3); border:1px solid var(--line); border-radius:2px; padding:4px 9px; display:inline-flex; gap:6px; align-items:center; }
.cco-callout b { font-family:var(--serif); font-size:12px; letter-spacing:0; }
.cco-callout i { font-style:normal; font-size:9px; }
.cco-callout.good i { color:var(--good); } .cco-callout.bad i { color:var(--bad); } .cco-callout.meta i { color:var(--accentInk); }

/* rank */
.cco-rank-row { display:grid; grid-template-columns:120px 1fr 78px; align-items:center; gap:14px; margin-bottom:14px; }
.cco-rank-row:last-child { margin-bottom:0; }
.cco-rank-name { font-size:11.5px; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cco-rank-track { height:9px; background:var(--paper3); border-radius:5px; overflow:hidden; position:relative; }
.cco-rank-bar { height:100%; width:0; background:var(--graphite); border-radius:5px; transition:width .9s cubic-bezier(.2,.9,.25,1); }
.cco-rank-bar.first { background:var(--accent); }
.cco-rank-bar.ghost { background:var(--line2); }
.cco-rank-bar.over { background:var(--accent); position:absolute; left:0; top:0; }
.cco-rank-val { font-family:var(--serif); font-size:15px; text-align:right; font-weight:500; }
.cco-rank-sub { font-family:var(--mono); font-size:9px; color:var(--ink3); margin-left:3px; }

/* donut */
.cco-donut { display:flex; align-items:center; gap:24px; flex-wrap:wrap; }
.cco-donut-c { font-family:var(--serif); font-size:20px; font-weight:500; fill:var(--ink); }
.cco-donut-l { font-family:var(--mono); font-size:7px; letter-spacing:.18em; fill:var(--ink3); }
.cco-dleg { display:flex; flex-direction:column; gap:9px; flex:1; min-width:150px; }
.cco-dleg-i { display:grid; grid-template-columns:11px 1fr auto auto; align-items:center; gap:9px; font-size:11px; color:var(--ink2); }
.cco-dleg-i i { width:11px; height:11px; border-radius:2px; }
.cco-dleg-i b { font-family:var(--serif); font-size:14px; color:var(--ink); font-weight:500; }
.cco-dleg-i em { font-style:normal; font-size:9.5px; color:var(--ink3); min-width:32px; text-align:right; }

/* stacked bar */
.cco-stk-bar { display:flex; height:16px; border-radius:3px; overflow:hidden; background:var(--paper3); }
.cco-stk-seg { flex-grow:0; flex-shrink:0; flex-basis:0; transition:flex-basis .8s cubic-bezier(.2,.9,.25,1); }
.cco-stk-legs { display:flex; flex-direction:column; gap:9px; margin-top:16px; }
.cco-stk-leg { display:grid; grid-template-columns:11px 1fr auto auto; align-items:center; gap:9px; font-size:11px; color:var(--ink2); }
.cco-stk-leg i { width:11px; height:11px; border-radius:2px; }
.cco-stk-leg b { font-family:var(--serif); font-size:14px; color:var(--ink); font-weight:500; }
.cco-stk-leg em { font-style:normal; font-size:9.5px; color:var(--ink3); min-width:32px; text-align:right; }

/* big stat (resolução) */
.cco-bigstat { padding:6px 0 14px; border-bottom:1px solid var(--line); }
.cco-bigstat-v { font-family:var(--serif); font-weight:300; font-size:40px; line-height:.9; color:var(--accentInk); letter-spacing:-.02em; }
.cco-bigstat-l { display:block; margin-top:8px; }
.cco-ministats { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:16px; }
.cco-ministats b { font-family:var(--serif); font-size:22px; font-weight:500; display:block; }
.cco-ministats span { font-size:9px; text-transform:uppercase; letter-spacing:.1em; color:var(--ink3); }
.cco-bad { color:var(--bad); }

/* parque (armamento) */
.cco-parque { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; }
.cco-pq { text-align:center; padding:16px 8px; border:1px solid var(--line); border-radius:3px; background:var(--paper3); border-top:3px solid var(--graphite); }
.cco-pq-v { font-family:var(--serif); font-size:30px; font-weight:400; display:block; line-height:1; }
.cco-pq-l { display:block; margin-top:7px; }
.cco-pq-good { border-top-color:var(--good); } .cco-pq-accent { border-top-color:var(--accent); }
.cco-pq-amber { border-top-color:var(--amber); } .cco-pq-bad { border-top-color:var(--bad); }
@media (max-width:620px){ .cco-parque { grid-template-columns:repeat(3,1fr); } }

/* tables */
.cco-table { width:100%; border-collapse:collapse; }
.cco-table thead th { font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:.12em; color:var(--ink3);
  font-weight:500; text-align:left; padding:9px 10px; border-bottom:1px solid var(--line2); }
.cco-table th.r, .cco-table td.r { text-align:right; }
.cco-table tbody td { padding:11px 10px; border-bottom:1px solid var(--line); font-size:12.5px; color:var(--ink2); }
.cco-table tbody tr:last-child td { border-bottom:0; }
.cco-table tbody tr:hover { background:var(--wash); }
.cco-table td.main { display:flex; align-items:baseline; gap:9px; }
.cco-table td.main.clk { cursor:pointer; }
.cco-rt-rank { font-family:var(--mono); font-size:10px; color:var(--ink3); min-width:14px; }
.cco-rt-name { color:var(--ink); }
.cco-table td.main.clk:hover .cco-rt-name { color:var(--accentInk); }
.cco-rt-code { font-family:var(--mono); font-size:9.5px; color:var(--ink3); }
.cco-table td.r.cco-num, .cco-table td .cco-num { font-size:14px; font-weight:500; color:var(--ink); }
.cco-barcell { display:flex; align-items:center; justify-content:flex-end; gap:9px; position:relative; min-height:16px; }
.cco-barcell .cco-bar { position:absolute; right:0; height:7px; border-radius:4px; opacity:.22; }
.cco-barcell b { position:relative; }
.cco-bar.bad { background:var(--bad); } .cco-bar.accent { background:var(--accent); } .cco-bar.graphite { background:var(--graphite); }
.cco-grave-badge { font-family:var(--mono); font-size:8.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--bad); background:var(--wash); border-radius:2px; padding:1px 5px; }
.cco-gauge { display:flex; align-items:center; justify-content:flex-end; gap:9px; }
.cco-gauge-tr { width:74px; height:7px; background:var(--paper3); border-radius:4px; overflow:hidden; }
.cco-gauge-fill { display:block; height:100%; border-radius:4px; }
.cco-gauge-fill.ok { background:var(--good); } .cco-gauge-fill.warn { background:var(--amber); } .cco-gauge-fill.under { background:var(--bad); }
.cco-gauge b { font-family:var(--serif); font-size:13px; min-width:38px; text-align:right; }
.cco-gauge-na { color:var(--ink3); }
.cco-scoretable thead th { border-bottom-width:1.5px; }

/* reveal */
.cco-rise { opacity:0; transform:translateY(12px); animation:cco-rise .7s cubic-bezier(.2,.9,.25,1) forwards; }
.cco-rise:nth-of-type(2){animation-delay:.04s}.cco-rise:nth-of-type(3){animation-delay:.08s}
.cco-rise:nth-of-type(4){animation-delay:.12s}.cco-rise:nth-of-type(5){animation-delay:.16s}
@keyframes cco-rise { to { opacity:1; transform:none; } }

@media (max-width:880px){ .cco-grid2 { grid-template-columns:1fr; } .cco-grid2 .cco-card { margin-bottom:18px; } }

/* theme toggle button */
.cco-icon { padding:6px; width:32px; display:inline-grid; place-items:center; }
.cco-icon svg { width:15px; height:15px; }

/* smooth theme switch */
.sigos-cco { transition:background-color .35s ease; }
.cco-card, .cco-kpis, .cco-pq, .cco-callout { transition:background-color .35s ease, border-color .35s ease; }

/* ---------------------------------------------------------------- DARK THEME */
.sigos-cco.theme-dark { background:#0d0b09; }
.layout-main-section-wrapper:has(.sigos-cco.theme-dark), .page-body:has(.sigos-cco.theme-dark) { background:#0d0b09; }
.sigos-cco.theme-dark .cco-root {
  --paper:#0d0b09; --paper2:#171310; --paper3:#221b15; --ink:#ECE4D8; --ink2:#B3A695;
  --ink3:#7D7165; --line:#2A221B; --line2:#3A2F25; --accent:#D2622F; --accentInk:#E8865A;
  --wash:rgba(210,98,47,.12); --good:#7BA35C; --bad:#D2452A; --amber:#D69A3C; --graphite:#8A7A66;
  --shadow:0 1px 2px rgba(0,0,0,.4), 0 16px 36px -20px rgba(0,0,0,.7);
}
.sigos-cco.theme-dark .cco-root::before { mix-blend-mode:screen; opacity:.05; }
`;
		const s = document.createElement("style");
		s.id = "cco-css"; s.textContent = css;
		document.head.appendChild(s);
	}
};
