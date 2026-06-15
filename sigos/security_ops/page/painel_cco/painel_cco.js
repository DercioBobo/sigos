frappe.provide("sigos");

frappe.pages["painel-cco"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Painel CCO"),
		single_column: true,
	});
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
			delegacao: null,
			cliente: null,
			posto: null,
			busca: "",
		};
		this._inject_css();
		this._build_shell();
		this._build_controls();
		this.refresh();
	}

	// ───────────────────────────────────────────────────────── shell + controls

	_build_shell() {
		this.page.main.addClass("sigos-cco");
		this.$body = $(`
			<div class="cco-root">
				<div class="cco-toolbar"></div>
				<div class="cco-kpis"></div>
				<div class="cco-sections"><div class="cco-loading">${__("A carregar...")}</div></div>
			</div>
		`).appendTo(this.page.main);
		this.$toolbar = this.$body.find(".cco-toolbar");
		this.$kpis = this.$body.find(".cco-kpis");
		this.$sections = this.$body.find(".cco-sections");
	}

	_build_controls() {
		// Period presets
		const $per = $(`<div class="cco-presets"></div>`).appendTo(this.$toolbar);
		[
			["7", __("7 dias")], ["30", __("30 dias")], ["90", __("90 dias")], ["mes", __("Mês corrente")],
		].forEach(([k, lbl]) => {
			$(`<button class="cco-preset ${this.state.preset === k ? "active" : ""}" data-p="${k}">${lbl}</button>`)
				.appendTo($per)
				.on("click", () => this._set_preset(k));
		});

		// Custom range
		const $range = $(`<div class="cco-range"></div>`).appendTo(this.$toolbar);
		this.f_de = this._date_ctrl($range, __("De"), this.state.de, (v) => { this.state.de = v; this.state.preset = "custom"; this._sync_presets(); this.refresh(); });
		this.f_ate = this._date_ctrl($range, __("Até"), this.state.ate, (v) => { this.state.ate = v; this.state.preset = "custom"; this._sync_presets(); this.refresh(); });

		// Scope filters
		const $filters = $(`<div class="cco-filters"></div>`).appendTo(this.$toolbar);
		this.f_deleg = this._link_filter($filters, "Delegacao", __("Delegação"), "delegacao");
		this.f_cli = this._link_filter($filters, "Customer", __("Cliente"), "cliente");
		this.f_posto = this._link_filter($filters, "Posto De Vigilancia", __("Posto"), "posto");

		// Search + refresh
		const $tail = $(`
			<div class="cco-tail">
				<div class="cco-search"><span>&#128269;</span><input type="text" placeholder="${__("Filtrar tabelas...")}"/></div>
				<span class="cco-stamp"></span>
				<button class="cco-refresh" title="${__("Actualizar")}">&#10227;</button>
			</div>
		`).appendTo(this.$toolbar);
		this.$stamp = $tail.find(".cco-stamp");
		this.$search = $tail.find("input");
		this.$search.on("input", frappe.utils.debounce(() => { this.state.busca = this.$search.val(); this._render_sections(); }, 250));
		$tail.find(".cco-refresh").on("click", () => this.refresh());
	}

	_date_ctrl($parent, label, val, onset) {
		const $w = $(`<div class="cco-date"><label>${label}</label><div class="cco-date-i"></div></div>`).appendTo($parent);
		const ctrl = frappe.ui.form.make_control({
			df: { fieldtype: "Date", label: "" },
			parent: $w.find(".cco-date-i").get(0),
			render_input: true,
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
			parent: $wrap.get(0),
			render_input: true,
		});
		return ctrl;
	}

	_set_preset(k) {
		this.state.preset = k;
		const today = frappe.datetime.get_today();
		if (k === "mes") {
			this.state.de = today.slice(0, 8) + "01";
			this.state.ate = today;
		} else {
			this.state.ate = today;
			this.state.de = frappe.datetime.add_days(today, -(parseInt(k, 10) - 1));
		}
		this.f_de.set_value(this.state.de);
		this.f_ate.set_value(this.state.ate);
		this._sync_presets();
		this.refresh();
	}

	_sync_presets() {
		this.$toolbar.find(".cco-preset").each((i, el) => {
			$(el).toggleClass("active", $(el).data("p") === this.state.preset);
		});
	}

	// ─────────────────────────────────────────────────────────── data + render

	refresh() {
		if (this._loading) return;
		this._loading = true;
		this.$toolbar.addClass("cco-busy");
		frappe.call({
			method: "sigos.cco.cco_dashboard",
			args: {
				de: this.state.de, ate: this.state.ate,
				delegacao: this.state.delegacao, cliente: this.state.cliente, posto: this.state.posto,
			},
			callback: (r) => {
				this._loading = false;
				this.$toolbar.removeClass("cco-busy");
				if (!r.message) return;
				this.data = r.message;
				this._render_kpis();
				this._render_sections();
				this._stamp();
			},
			error: () => { this._loading = false; this.$toolbar.removeClass("cco-busy"); },
		});
	}

	_render_kpis() {
		const k = this.data.kpis;
		const tiles = [
			this._kpi(__("Cobertura média"), k.cobertura_media, k.cobertura_media_prev, true, "%", "k-cob"),
			this._kpi(__("Slots descobertos"), k.gap_slots, k.gap_slots_prev, false, "", "k-gap"),
			this._kpi(__("Ocorrências"), k.ocorrencias, k.ocorrencias_prev, false, "", "k-oc"),
			this._kpi(__("Graves (Alta/Crítica)"), k.ocorrencias_graves, k.ocorrencias_graves_prev, false, "", "k-grave"),
			this._kpi(__("Taxa substituição"), k.taxa_substituicao, k.taxa_substituicao_prev, true, "%", "k-sub"),
			this._kpi(__("Reserva disponível"), k.reserva, null, true, "", "k-res"),
		];
		this.$kpis.html(tiles.join(""));
	}

	_kpi(label, val, prev, higher_better, suffix, cls) {
		let delta = "";
		if (prev !== null && prev !== undefined) {
			const diff = Math.round((val - prev) * 10) / 10;
			if (diff === 0) {
				delta = `<span class="cco-delta flat">&middot; ${__("sem variação")}</span>`;
			} else {
				const up = diff > 0;
				const good = higher_better ? up : !up;
				delta = `<span class="cco-delta ${good ? "good" : "bad"}">${up ? "&#9650;" : "&#9660;"} ${Math.abs(diff)}${suffix} ${__("vs anterior")}</span>`;
			}
		}
		const shown = (val === null || val === undefined) ? "—" : val + suffix;
		return `
			<div class="cco-kpi ${cls}">
				<div class="cco-kpi-lbl">${label}</div>
				<div class="cco-kpi-val">${shown}</div>
				${delta}
			</div>`;
	}

	_render_sections() {
		if (!this.data) return;
		this.$sections.empty();
		this._sec_cobertura();
		this._sec_ocorrencias();
		this._sec_ausencias();
		this._sec_armamento();
	}

	// ─────────────────────────────────────────────────────────────── sections

	_panel(title, sub) {
		return $(`
			<section class="cco-sec">
				<header class="cco-sec-h"><h2>${title}</h2>${sub ? `<span class="cco-sec-sub">${sub}</span>` : ""}</header>
				<div class="cco-sec-b"></div>
			</section>`).appendTo(this.$sections).find(".cco-sec-b").parent();
	}

	_sec_cobertura() {
		const c = this.data.cobertura;
		const $s = this._panel(__("Cobertura & efectivo"), `${__("média")} ${c.media}%`);
		const $grid = $(`<div class="cco-grid"></div>`).appendTo($s.find(".cco-sec-b"));

		const $line = this._mount($grid, __("Taxa de cobertura por dia"), { span: 2 });
		this._chart($line, "line", {
			labels: c.trend.map((d) => this._dlabel(d.data)),
			datasets: [{ name: __("Cobertura %"), values: c.trend.map((d) => d.pct === null ? 0 : d.pct) }],
		}, { colors: ["#2ec36b"], lineOptions: { regionFill: 1, hideDots: 1 }, yMax: 100 });

		const $ef = this._mount($grid, __("Efectivo activo por delegação"));
		this._chart($ef, "bar", {
			labels: c.efectivo_delegacao.map((x) => x.k),
			datasets: [{ name: __("Activos"), values: c.efectivo_delegacao.map((x) => x.n) }],
		}, { colors: ["#3aa0ff"] });

		const $cat = this._mount($grid, __("Efectivo por categoria"));
		this._chart($cat, "donut", {
			labels: c.efectivo_categoria.map((x) => x.k),
			datasets: [{ values: c.efectivo_categoria.map((x) => x.n) }],
		}, { colors: this._palette });

		const $top = this._mount($grid, __("Postos com mais lacunas"), { span: 2 });
		$top.html(this._rank_table(c.top_lacunas, {
			cols: [
				{ key: "nome", label: __("Posto"), main: true, code: "posto", route: "Posto De Vigilancia" },
				{ key: "gaps", label: __("Slots descobertos"), num: true, bar: "danger", max: this._maxBy(c.top_lacunas, "gaps") },
				{ key: "escalados", label: __("Escalados"), num: true },
			],
			empty: __("Sem lacunas no período."),
			search: ["nome", "posto"],
		}));
	}

	_sec_ocorrencias() {
		const o = this.data.ocorrencias;
		const tr = o.tempo_resolucao === null ? "—" : o.tempo_resolucao + " " + __("dias");
		const $s = this._panel(__("Ocorrências"), `${o.total} ${__("no período")} &middot; ${__("resolução média")} ${tr}`);
		const $grid = $(`<div class="cco-grid"></div>`).appendTo($s.find(".cco-sec-b"));

		const $line = this._mount($grid, __("Ocorrências por dia"), { span: 2 });
		this._chart($line, "line", {
			labels: (o.trend || []).map((d) => this._dlabel(d.d)),
			datasets: [{ name: __("Ocorrências"), values: (o.trend || []).map((d) => d.n) }],
		}, { colors: ["#f5a623"], lineOptions: { regionFill: 1, hideDots: 1 } });

		const $grav = this._mount($grid, __("Por gravidade"));
		this._chart($grav, "donut", {
			labels: (o.por_gravidade || []).map((x) => x.k),
			datasets: [{ values: (o.por_gravidade || []).map((x) => x.n) }],
		}, { colors: (o.por_gravidade || []).map((x) => this._grav_color(x.k)) });

		const $tipo = this._mount($grid, __("Por tipo"));
		this._chart($tipo, "bar", {
			labels: (o.por_tipo || []).map((x) => x.k),
			datasets: [{ name: __("Ocorrências"), values: (o.por_tipo || []).map((x) => x.n) }],
		}, { colors: ["#a877ff"] });

		const $est = this._mount($grid, __("Por estado"));
		this._chart($est, "percentage", {
			labels: (o.por_estado || []).map((x) => x.k),
			datasets: [{ values: (o.por_estado || []).map((x) => x.n) }],
		}, { colors: (o.por_estado || []).map((x) => this._estado_color(x.k)) });

		const $tp = this._mount($grid, __("Top postos com ocorrências"));
		$tp.html(this._rank_table(o.top_postos, {
			cols: [
				{ key: "nome", label: __("Posto"), main: true, code: "posto", route: "Posto De Vigilancia" },
				{ key: "n", label: __("N.º"), num: true, bar: "warn", max: this._maxBy(o.top_postos, "n") },
			],
			empty: __("Sem ocorrências."), search: ["nome", "posto"],
		}));

		const $tv = this._mount($grid, __("Top vigilantes com ocorrências"));
		$tv.html(this._rank_table(o.top_vigilantes, {
			cols: [
				{ key: "nome", label: __("Vigilante"), main: true, code: "vigilante", route: "Vigilante" },
				{ key: "n", label: __("N.º"), num: true, bar: "warn", max: this._maxBy(o.top_vigilantes, "n") },
			],
			empty: __("Sem ocorrências associadas a vigilantes."), search: ["nome", "vigilante"],
		}));
	}

	_sec_ausencias() {
		const a = this.data.ausencias;
		const $s = this._panel(__("Ausências & Reserva"), `${a.faltas} ${__("faltas")} &middot; ${__("substituição")} ${a.taxa_substituicao}%`);
		const $grid = $(`<div class="cco-grid"></div>`).appendTo($s.find(".cco-sec-b"));

		const $line = this._mount($grid, __("Faltas por dia"), { span: 2 });
		this._chart($line, "line", {
			labels: (a.trend || []).map((d) => this._dlabel(d.d)),
			datasets: [{ name: __("Faltas"), values: (a.trend || []).map((d) => d.n) }],
		}, { colors: ["#ef4444"], lineOptions: { regionFill: 1, hideDots: 1 } });

		const $tipo = this._mount($grid, __("Ausências por tipo"));
		this._chart($tipo, "bar", {
			labels: (a.por_tipo || []).map((x) => x.k),
			datasets: [{ name: __("Ausências"), values: (a.por_tipo || []).map((x) => x.n) }],
		}, { colors: ["#f5662a"] });

		const $res = this._mount($grid, __("Reserva por delegação"));
		this._chart($res, "bar", {
			labels: (a.reserva.por_delegacao || []).map((x) => x.k),
			datasets: [{ name: __("Reserva"), values: (a.reserva.por_delegacao || []).map((x) => x.n) }],
		}, { colors: ["#16c2c2"] });

		const $tv = this._mount($grid, __("Vigilantes com mais faltas"), { span: 2 });
		$tv.html(this._rank_table(a.top_vigilantes, {
			cols: [
				{ key: "nome", label: __("Vigilante"), main: true, code: "vigilante", route: "Vigilante" },
				{ key: "delegacao", label: __("Delegação") },
				{ key: "n", label: __("Faltas"), num: true, bar: "danger", max: this._maxBy(a.top_vigilantes, "n") },
			],
			empty: __("Sem faltas no período."), search: ["nome", "vigilante", "delegacao"],
		}));
	}

	_sec_armamento() {
		const g = this.data.armamento;
		const $s = this._panel(__("Armamento"), `${g.total} ${__("armas")} &middot; ${g.alocadas} ${__("alocadas")} &middot; ${g.disponiveis} ${__("disponíveis")}`);
		const $grid = $(`<div class="cco-grid"></div>`).appendTo($s.find(".cco-sec-b"));

		const $stat = this._mount($grid, __("Estado do parque"));
		$stat.html(`
			<div class="cco-stats">
				${this._stat(__("Total"), g.total, "#cfe3fb")}
				${this._stat(__("Alocadas"), g.alocadas, "#2ec36b")}
				${this._stat(__("Disponíveis"), g.disponiveis, "#3aa0ff")}
				${this._stat(__("Manutenção"), g.manutencao, "#f5a623")}
				${this._stat(__("Abatidas"), g.abatidas, "#ef4444")}
			</div>`);

		const $deleg = this._mount($grid, __("Armas por delegação (alocadas vs total)"), { span: 2 });
		this._chart($deleg, "bar", {
			labels: (g.por_delegacao || []).map((x) => x.k),
			datasets: [
				{ name: __("Alocadas"), values: (g.por_delegacao || []).map((x) => x.alocadas) },
				{ name: __("Total"), values: (g.por_delegacao || []).map((x) => x.total) },
			],
		}, { colors: ["#2ec36b", "#26425c"] });

		const $tipo = this._mount($grid, __("Por tipo de arma"));
		this._chart($tipo, "donut", {
			labels: (g.por_tipo || []).map((x) => x.k),
			datasets: [{ values: (g.por_tipo || []).map((x) => x.n) }],
		}, { colors: this._palette });
	}

	// ───────────────────────────────────────────────────────── render helpers

	_stat(label, val, color) {
		return `<div class="cco-stat"><div class="cco-stat-v" style="color:${color}">${val}</div><div class="cco-stat-l">${label}</div></div>`;
	}

	_mount($grid, title, opts = {}) {
		const span = opts.span ? ` style="grid-column:span ${opts.span}"` : "";
		return $(`<div class="cco-card"${span}><div class="cco-card-h">${title}</div><div class="cco-card-b"></div></div>`)
			.appendTo($grid).find(".cco-card-b");
	}

	_chart($el, type, data, opts = {}) {
		const has = (data.datasets || []).some((d) => (d.values || []).some((v) => v));
		if (!has) { $el.html(`<div class="cco-nochart">${__("Sem dados")}</div>`); return; }
		const node = $(`<div class="cco-chart"></div>`).appendTo($el).get(0);
		try {
			new frappe.Chart(node, Object.assign({
				data, type, height: opts.height || 220, animate: 0,
				axisOptions: { xIsSeries: type === "line" },
				barOptions: { spaceRatio: 0.4 },
			}, opts));
		} catch (e) {
			$el.html(`<div class="cco-nochart">${__("Gráfico indisponível")}</div>`);
		}
	}

	_rank_table(rows, cfg) {
		rows = rows || [];
		const t = (this.state.busca || "").trim().toLowerCase();
		if (t) rows = rows.filter((r) => (cfg.search || []).some((k) => String(r[k] || "").toLowerCase().includes(t)));
		if (!rows.length) return `<div class="cco-nochart">${cfg.empty || __("Sem dados")}</div>`;
		const head = cfg.cols.map((c) => `<th class="${c.num ? "num" : ""}">${c.label}</th>`).join("");
		const body = rows.map((r) => {
			const tds = cfg.cols.map((c) => {
				let v = r[c.key];
				if (v === null || v === undefined || v === "") v = "—";
				if (c.bar) {
					const pct = c.max ? Math.round((r[c.key] / c.max) * 100) : 0;
					return `<td class="num"><div class="cco-barcell"><span class="cco-bar ${c.bar}" style="width:${pct}%"></span><b>${v}</b></div></td>`;
				}
				if (c.main) {
					const route = r[c.route_key || "_route"] || r[c.code];
					return `<td class="main" data-route="${frappe.utils.escape_html(c.route)}" data-name="${frappe.utils.escape_html(route || "")}">
						<span class="cco-rt-name">${frappe.utils.escape_html(String(v))}</span>
						${r[c.code] && r[c.code] !== v ? `<span class="cco-rt-code">${frappe.utils.escape_html(r[c.code])}</span>` : ""}
					</td>`;
				}
				return `<td class="${c.num ? "num" : ""}">${frappe.utils.escape_html(String(v))}</td>`;
			}).join("");
			return `<tr>${tds}</tr>`;
		}).join("");
		const $w = $(`<table class="cco-rank"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
		$w.find("td.main[data-name]").each((i, el) => {
			if (!$(el).data("name")) return;
			$(el).addClass("clickable").on("click", () =>
				frappe.set_route("Form", $(el).data("route"), $(el).data("name")));
		});
		return $w;
	}

	_maxBy(rows, key) {
		return (rows || []).reduce((m, r) => Math.max(m, r[key] || 0), 0);
	}

	_dlabel(iso) {
		const p = (iso || "").split("-");
		return p.length === 3 ? p[2] + "/" + p[1] : iso;
	}

	get _palette() {
		return ["#3aa0ff", "#2ec36b", "#f5a623", "#a877ff", "#16c2c2", "#ef4444", "#f5662a", "#7c8ea3"];
	}

	_grav_color(g) {
		return { "Crítica": "#ff3b3b", "Alta": "#f5662a", "Média": "#f5a623", "Baixa": "#3aa0ff" }[g] || "#7c8ea3";
	}

	_estado_color(e) {
		return { "Aberta": "#ef4444", "Em Investigação": "#f5a623", "Resolvida": "#2ec36b", "Fechada": "#3aa0ff" }[e] || "#7c8ea3";
	}

	_stamp() {
		const now = frappe.datetime.str_to_user(this.data.gerado_em);
		this.$stamp.text(__("Actualizado") + " " + (now || "").split(" ").slice(1).join(" "));
	}

	// ──────────────────────────────────────────────────────────────────── css

	_inject_css() {
		if (document.getElementById("sigos-cco-css")) return;
		const css = `
.sigos-cco { background:#0b0e13; }
.layout-main-section-wrapper:has(.sigos-cco), .page-body:has(.sigos-cco) { background:#0b0e13; }
.cco-root { color:#c9d4e3; padding:4px 2px 48px; font-feature-settings:"tnum" 1; }
.cco-root .cco-kpi-val, .cco-root .cco-stat-v, .cco-root .cco-rt-code, .cco-root .num b { font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace; }

/* Toolbar */
.cco-toolbar { display:flex; flex-wrap:wrap; gap:10px 14px; align-items:center; padding:10px 12px; background:linear-gradient(180deg,#141a23,#10151d); border:1px solid #1f2935; border-radius:12px; }
.cco-toolbar.cco-busy { opacity:.8; }
.cco-presets { display:flex; gap:4px; background:#10151d; border:1px solid #1f2935; border-radius:9px; padding:3px; }
.cco-preset { background:transparent; border:0; color:#9fb1c6; border-radius:6px; padding:5px 11px; font-size:12px; cursor:pointer; }
.cco-preset:hover { color:#eaf2fb; }
.cco-preset.active { background:#1c2a3a; color:#eaf2fb; }
.cco-range { display:flex; gap:8px; }
.cco-date { display:flex; flex-direction:column; gap:2px; }
.cco-date label { font-size:9.5px; text-transform:uppercase; letter-spacing:.07em; color:#6b7e93; }
.cco-date-i .control-input input, .cco-date-i input { background:#1b2430; color:#eaf2fb; border:1px solid #2a3a4d; height:28px; min-width:120px; }
.cco-filters { display:flex; flex-wrap:wrap; gap:8px; align-items:center; flex:1; }
.cco-filter { min-width:150px; }
.cco-filter .control-input input { background:#1b2430; color:#eaf2fb; border:1px solid #2a3a4d; height:30px; }
.cco-tail { display:flex; align-items:center; gap:12px; margin-left:auto; }
.cco-search { display:flex; align-items:center; gap:6px; background:#1b2430; border:1px solid #2a3a4d; border-radius:8px; padding:0 10px; height:30px; }
.cco-search span { opacity:.6; font-size:13px; }
.cco-search input { background:transparent; border:0; outline:0; color:#eaf2fb; width:170px; }
.cco-stamp { font-size:11px; color:#6b7e93; }
.cco-refresh { width:32px; height:30px; background:#1b2430; color:#c9d4e3; border:1px solid #2a3a4d; border-radius:8px; cursor:pointer; font-size:15px; }
.cco-refresh:hover { border-color:#3aa0ff; color:#eaf2fb; }

/* KPIs */
.cco-kpis { display:grid; grid-template-columns:repeat(6,1fr); gap:12px; margin-top:14px; }
@media (max-width:1100px){ .cco-kpis { grid-template-columns:repeat(3,1fr); } }
@media (max-width:680px){ .cco-kpis { grid-template-columns:repeat(2,1fr); } }
.cco-kpi { background:linear-gradient(180deg,#141a23,#10151d); border:1px solid #1f2935; border-top:3px solid #2a3a4d; border-radius:13px; padding:12px 14px; }
.cco-kpi.k-cob { border-top-color:#2ec36b; } .cco-kpi.k-gap { border-top-color:#ef4444; }
.cco-kpi.k-oc { border-top-color:#f5a623; } .cco-kpi.k-grave { border-top-color:#f5662a; }
.cco-kpi.k-sub { border-top-color:#a877ff; } .cco-kpi.k-res { border-top-color:#16c2c2; }
.cco-kpi-lbl { font-size:11px; color:#8aa0b8; text-transform:uppercase; letter-spacing:.05em; }
.cco-kpi-val { font-size:27px; font-weight:600; color:#eaf2fb; line-height:1.15; margin-top:3px; }
.cco-delta { font-size:11px; display:inline-block; margin-top:3px; }
.cco-delta.good { color:#5be09a; } .cco-delta.bad { color:#ff8a8a; } .cco-delta.flat { color:#6b7e93; }

/* Sections */
.cco-sections { margin-top:18px; display:flex; flex-direction:column; gap:18px; }
.cco-loading { color:#6b7e93; padding:40px; text-align:center; }
.cco-sec-h { display:flex; align-items:baseline; gap:10px; margin-bottom:10px; }
.cco-sec-h h2 { font-size:14px; font-weight:600; color:#eaf2fb; margin:0; text-transform:uppercase; letter-spacing:.06em; }
.cco-sec-sub { font-size:12px; color:#7c8ea3; }
.cco-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:14px; }
@media (max-width:900px){ .cco-grid { grid-template-columns:1fr; } .cco-card[style] { grid-column:auto !important; } }
.cco-card { background:linear-gradient(180deg,#141a23,#10151d); border:1px solid #1f2935; border-radius:14px; padding:12px 14px; min-width:0; }
.cco-card-h { font-size:12px; color:#8aa0b8; text-transform:uppercase; letter-spacing:.05em; margin-bottom:8px; }
.cco-card-b { min-height:40px; }
.cco-chart { margin:-6px -4px -10px; }
.cco-nochart { color:#6b7e93; font-size:12.5px; text-align:center; padding:28px 0; }

/* chart theming */
.cco-card .chart-container text, .cco-card .frappe-chart text { fill:#8aa0b8 !important; }
.cco-card .frappe-chart .axis line, .cco-card .chart-container .axis line { stroke:#1f2935 !important; }
.cco-card .frappe-chart .axis path, .cco-card .chart-container .axis path { stroke:#1f2935 !important; }
.cco-card .chart-container .line-horizontal, .cco-card .frappe-chart line.dashed { stroke:#1c2531 !important; }
.cco-card .graph-svg-tip.comparison, .cco-card .graph-svg-tip { background:#0e131b; border:1px solid #2a3a4d; }

/* stats grid */
.cco-stats { display:grid; grid-template-columns:repeat(5,1fr); gap:8px; }
@media (max-width:520px){ .cco-stats { grid-template-columns:repeat(3,1fr); } }
.cco-stat { background:#10161f; border:1px solid #1c2531; border-radius:10px; padding:10px 8px; text-align:center; }
.cco-stat-v { font-size:22px; font-weight:600; }
.cco-stat-l { font-size:10px; color:#7c8ea3; text-transform:uppercase; letter-spacing:.05em; margin-top:2px; }

/* ranking table */
.cco-rank { width:100%; border-collapse:collapse; font-size:12.5px; }
.cco-rank th { text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:#6b7e93; font-weight:500; padding:4px 8px; border-bottom:1px solid #1f2935; }
.cco-rank th.num, .cco-rank td.num { text-align:right; }
.cco-rank td { padding:6px 8px; border-bottom:1px solid #161e29; color:#c9d4e3; }
.cco-rank tr:last-child td { border-bottom:0; }
.cco-rank td.main { display:flex; flex-direction:column; gap:1px; }
.cco-rank td.main.clickable { cursor:pointer; }
.cco-rank td.main.clickable:hover .cco-rt-name { color:#9fc6ff; }
.cco-rt-name { color:#eaf2fb; }
.cco-rt-code { font-size:10px; color:#6b7e93; }
.cco-barcell { display:flex; align-items:center; justify-content:flex-end; gap:8px; position:relative; }
.cco-barcell .cco-bar { position:absolute; right:0; height:16px; border-radius:4px; opacity:.18; }
.cco-barcell b { position:relative; color:#eaf2fb; font-weight:600; }
.cco-bar.danger { background:#ef4444; } .cco-bar.warn { background:#f5a623; }
`;
		const style = document.createElement("style");
		style.id = "sigos-cco-css";
		style.textContent = css;
		document.head.appendChild(style);
	}
};
