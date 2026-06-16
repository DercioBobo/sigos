// SIGOS - Painel Estatistico (RH). Editorial light dashboard, all-custom (no chart lib).
frappe.provide("sigos");

frappe.pages["painel-estatistico"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({ parent: wrapper, title: __("Painel Estatístico"), single_column: true });
	wrapper.painel_estatistico = new sigos.PainelEstatistico(page);
};
frappe.pages["painel-estatistico"].on_page_show = function (wrapper) {
	if (wrapper.painel_estatistico) wrapper.painel_estatistico.refresh();
};

sigos.PainelEstatistico = class PainelEstatistico {
	constructor(page) {
		this.page = page;
		this.C = {
			accent: "#BC4A22", accentInk: "#8E3315", graphite: "#574E42",
			ink3: "#A99E8B", good: "#5E7A3E", bad: "#A8472E",
			palette: ["#BC4A22", "#574E42", "#5E7A3E", "#C99A52", "#8C6A4F", "#7C8B5A", "#A8472E", "#9E8B6A"],
		};
		this.months = 12;
		this.faltas = [];
		this._fmt = (n) => (Number(n) || 0).toLocaleString("pt-PT");
		this._inject_fonts();
		this._inject_css();
		this._build();
		this._wire();
		this.refresh();
	}

	// ============================================================ DATA
	_call(method, args) {
		return frappe.call({ method: `sigos.painel_rh.${method}`, args: args || {} }).then((r) => r.message || {});
	}

	refresh() {
		this.$root.find(".pe-stamp").text(__("A actualizar..."));
		const jobs = [
			this._call("get_cards").then((d) => this._render_cards(d)),
			this._call("get_composicao", { status: "Activo" }).then((d) => this._render_composicao(d)),
			this._load_movimento(),
			this._call("get_armas").then((d) => this._render_armas(d)),
			this._call("get_faltas", { min_faltas: 8, months: 6 }).then((d) => this._render_faltas(d)),
		];
		Promise.all(jobs).finally(() => {
			const t = frappe.datetime.now_datetime().split(" ")[1].slice(0, 5);
			this.$root.find(".pe-stamp").text(__("Actualizado") + " " + t);
		});
	}

	_load_movimento() {
		return this._call("get_movimento", { months: this.months }).then((d) => this._render_movimento(d));
	}

	// ============================================================ SHELL
	_build() {
		this.page.main.addClass("sigos-pe");
		const d = new Date();
		const dias = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
		const meses = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
		const hoje = `${dias[d.getDay()]}, ${d.getDate()} ${meses[d.getMonth()]} ${d.getFullYear()}`;

		this.$root = $(`
<div class="pe-root">
  <header class="pe-mast pe-rise">
    <div class="pe-mast-l">
      <div class="pe-mark">S</div>
      <div>
        <div class="pe-wordmark"><b>SIGOS</b></div>
        <div class="pe-eyebrow"><span class="pe-tick"></span><span class="pe-up">Painel Estatístico &middot; Recursos Humanos</span></div>
      </div>
    </div>
    <div class="pe-mast-r">
      <div class="pe-date">${hoje}</div>
      <div class="pe-mast-meta">
        <span class="pe-pulse"><i></i><span class="pe-stamp">${__("A carregar...")}</span></span>
        <button class="pe-btn pe-refresh">${__("Actualizar")}</button>
      </div>
    </div>
  </header>
  <div class="pe-rule pe-rise"></div>

  ${this._sec("01", "Resumo Operacional", "Efectivo em serviço")}
  <div class="pe-hero pe-rise">
    ${this._hero_cell("activos", "Vigilantes Activos", true)}
    ${this._hero_cell("postos_activos", "Postos Activos")}
    ${this._hero_cell("reservas", "Em Reserva")}
    ${this._hero_cell("armados", "Vigilantes Armados")}
  </div>
  <div class="pe-strip pe-rise" id="pe-strip"></div>

  ${this._sec("02", "Composição do Efectivo", "Distribuição do activo")}
  <div class="pe-grid2">
    ${this._card("Vigilantes por Categoria", "Efectivo activo", `<div class="pe-rank" id="pe-cat"></div>`)}
    ${this._card("Vigilantes por Regime", "Distribuição de turnos", `<div class="pe-rank" id="pe-reg"></div>`)}
  </div>
  <div class="pe-grid2">
    ${this._card("Distribuição por Sexo", "Composição de género", `<div class="pe-donut-host" id="pe-sexo"></div>`)}
    ${this._card("Vigilantes por Delegação", "Efectivo activo", `<div class="pe-rank" id="pe-deleg"></div>`)}
  </div>

  ${this._sec("03", "Movimento &amp; Rotatividade", "Período seleccionado", this._period_pills())}
  <div class="pe-grid2">
    ${this._card("Admitidos vs Demitidos", "Entradas e saídas mensais", `<div class="pe-legend" id="pe-ad-leg"></div><div class="pe-col" id="pe-admdem"></div><div class="pe-colx" id="pe-admdem-x"></div>`)}
    ${this._card("Rotatividades Mensais", "Movimentações de efectivo", `<div class="pe-col" id="pe-rot"></div><div class="pe-colx" id="pe-rot-x"></div>`)}
  </div>
  <div class="pe-grid2">
    ${this._card("Ausências Mensais", "Faltas registadas (submetidas)", `<div class="pe-area-host" id="pe-aus"></div><div class="pe-colx" id="pe-aus-x"></div>`)}
    ${this._card("Rotatividades por Operação", "Tipo de movimento", `<div class="pe-rank" id="pe-rottipo"></div>`)}
  </div>

  ${this._sec("04", "Armamento &amp; Carteira", "Recursos e clientes")}
  <div class="pe-grid2">
    ${this._card("Armas por Delegação", "Total e destacadas", `<div class="pe-rank" id="pe-armas"></div>`)}
    ${this._card("Top Clientes por Efectivo", "Maiores contratos", `<div class="pe-rank" id="pe-clientes"></div>`)}
  </div>

  ${this._sec("05", "Alertas &amp; Relatórios", "Acção recomendada", "", "alert")}
  <div class="pe-card">
    <div class="pe-alert-head">
      <div><div class="pe-card-title">${__("Vigilantes com mais de 8 Faltas")}</div>
      <div class="pe-card-sub">${__("Últimos 6 meses")}</div></div>
      <span class="pe-badge" id="pe-faltas-badge">&mdash;</span>
    </div>
    <div class="pe-col pe-alert-col" id="pe-faltas-chart"></div>
    <button class="pe-toggle" id="pe-faltas-toggle">
      <span id="pe-faltas-lbl">${__("Ver todos os vigilantes")}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="pe-drawer" id="pe-faltas-drawer">
      <div class="pe-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="text" id="pe-faltas-search" placeholder="${__("Filtrar por nome, posto, delegação...")}">
      </div>
      <table class="pe-table"><thead><tr>
        <th style="width:34px">#</th><th>${__("Vigilante")}</th><th>${__("Nome")}</th>
        <th>${__("Posto")}</th><th>${__("Delegação")}</th><th class="pe-r">${__("Faltas")}</th>
      </tr></thead><tbody id="pe-faltas-body"></tbody></table>
      <div class="pe-drawer-foot"><span id="pe-faltas-count">&mdash;</span><span>${__("Fonte: Cumulativo de Faltas")}</span></div>
    </div>
  </div>
</div>`).appendTo(this.page.main);
	}

	_sec(idx, title, aside, right, cls) {
		return `<div class="pe-sec ${cls === "alert" ? "pe-sec-alert" : ""} pe-rise">
			<span class="pe-sec-idx">${idx}</span><h2 class="pe-sec-title">${title}</h2>
			<span class="pe-sec-line"></span>${right || `<span class="pe-sec-aside">${aside}</span>`}</div>`;
	}
	_hero_cell(id, label, feature) {
		return `<div class="pe-hero-cell ${feature ? "pe-feature" : ""}" id="pe-hero-${id}">
			<div class="pe-hlbl"><span class="pe-up">${label}</span></div>
			<div class="pe-hval pe-num" data-to="0">0</div>
			<div class="pe-hfoot"></div></div>`;
	}
	_card(title, sub, body) {
		return `<div class="pe-card"><div class="pe-card-head"><div>
			<div class="pe-card-title">${title}</div><div class="pe-card-sub">${sub}</div>
			</div></div>${body}</div>`;
	}
	_period_pills() {
		const o = [["6M", 6], ["12M", 12], ["24M", 24]];
		return `<div class="pe-pills">${o.map(([l, m]) =>
			`<button class="pe-pill ${m === this.months ? "on" : ""}" data-m="${m}">${l}</button>`).join("")}</div>`;
	}

	_wire() {
		this.$root.find(".pe-refresh").on("click", () => this.refresh());
		this.$root.on("click", ".pe-pill", (e) => {
			const m = parseInt($(e.currentTarget).data("m"));
			this.$root.find(".pe-pill").removeClass("on");
			$(e.currentTarget).addClass("on");
			this.months = m;
			this._load_movimento();
		});
		// faltas drawer
		const $d = this.$root.find("#pe-faltas-drawer");
		const $chev = this.$root.find("#pe-faltas-toggle svg");
		this.$root.find("#pe-faltas-toggle").on("click", () => {
			const open = $d.toggleClass("open").hasClass("open");
			$chev.css("transform", open ? "rotate(180deg)" : "");
			this.$root.find("#pe-faltas-lbl").text(open ? __("Fechar") : __("Ver todos os vigilantes"));
			if (open) this._render_faltas_rows("");
		});
		this.$root.find("#pe-faltas-search").on("input", (e) => this._render_faltas_rows(e.target.value));
	}

	// ============================================================ RENDERERS
	_render_cards(d) {
		const net = (d.admitidos_mes || 0) - (d.demitidos_mes || 0);
		const armPct = d.activos ? Math.round((d.armados / d.activos) * 100) : 0;
		this._kpi("activos", d.activos, this._delta(net, "este mês"));
		this._kpi("postos_activos", d.postos_activos, `<span class="pe-dsub">de ${this._fmt(d.postos_total)} postos</span>`);
		this._kpi("reservas", d.reservas, `<span class="pe-dsub">disponíveis</span>`);
		this._kpi("armados", d.armados, `<span class="pe-dsub">${armPct}% do efectivo</span>`);

		const strip = [
			["Mulheres", d.mulheres], ["Homens", d.homens], ["Supervisores", d.supervisores],
			["Administrativos", d.administrativos], ["Clientes", d.clientes],
			["Delegações", d.delegacoes], ["Postos", d.postos_total], ["Armas", d.armas],
		];
		this.$root.find("#pe-strip").html(strip.map(([k, v]) =>
			`<div class="pe-strip-i"><span class="pe-k">${k}</span><span class="pe-v pe-num" data-to="${v || 0}">0</span></div>`).join(""));
		this._countup();
	}
	_delta(n, sub) {
		if (!n) return `<span class="pe-delta flat">&plusmn;0</span><span class="pe-dsub">${sub}</span>`;
		const up = n > 0;
		return `<span class="pe-delta ${up ? "up" : "down"}">${up ? "&#9650;" : "&#9660;"} ${Math.abs(n)}</span><span class="pe-dsub">${sub}</span>`;
	}
	_kpi(id, val, foot) {
		const cell = this.$root.find(`#pe-hero-${id}`);
		cell.find(".pe-hval").attr("data-to", val || 0);
		cell.find(".pe-hfoot").html(foot || "");
	}

	_render_composicao(d) {
		this._rank("pe-cat", (d.categoria || []).map((r) => ({ name: r.k, val: r.n })));
		this._rank("pe-reg", (d.regime || []).map((r) => ({ name: r.k, val: r.n })));
		this._rank("pe-deleg", (d.delegacao || []).map((r) => ({ name: r.k, val: r.n })));
		this._donut("pe-sexo", (d.sexo || []).map((r, i) => ({ label: r.k, val: r.n, color: this.C.palette[i % this.C.palette.length] })));
		this._rank("pe-clientes", (d.clientes || []).map((r) => ({ name: r.k, val: r.n })));
	}

	_render_movimento(d) {
		this._dualcol("pe-admdem", d.labels, d.admitidos, d.demitidos);
		this._legend("pe-ad-leg", [["Admitidos", this.C.good], ["Demitidos", this.C.bad]]);
		this._colx("pe-admdem-x", d.labels);
		this._colchart("pe-rot", d.labels, d.rotatividades);
		this._colx("pe-rot-x", d.labels);
		this._area("pe-aus", d.labels, d.ausencias);
		this._colx("pe-aus-x", d.labels);
		this._rank("pe-rottipo", (d.rot_por_tipo || []).map((r) => ({ name: r.k, val: r.n })));
	}

	_render_armas(d) {
		this._rank("pe-armas", (d.por_delegacao || []).map((r) => ({ name: r.k, val: r.n, sub: r.alocadas + " destacadas" })));
	}

	_render_faltas(rows) {
		this.faltas = rows || [];
		this.$root.find("#pe-faltas-badge").text(`${this.faltas.length} ${this.faltas.length === 1 ? "vigilante" : "vigilantes"}`);
		const top = this.faltas.slice(0, 12);
		this._colchart("pe-faltas-chart", top.map((r) => ""), top.map((r) => r.total_faltas), { color: this.C.bad });
		if (this.$root.find("#pe-faltas-drawer").hasClass("open")) this._render_faltas_rows(this.$root.find("#pe-faltas-search").val() || "");
	}
	_render_faltas_rows(q) {
		q = (q || "").toLowerCase().trim();
		const rows = this.faltas.filter((f) => !q ||
			((f.nome_completo || "") + (f.vigilante || "") + (f.posto || "") + (f.delegacao || "")).toLowerCase().includes(q));
		const body = this.$root.find("#pe-faltas-body");
		body.html(rows.length ? rows.map((f, i) => `
			<tr><td class="pe-idx">${i + 1}</td>
			<td><a href="/app/vigilante/${encodeURIComponent(f.vigilante)}" class="pe-link">${f.vigilante}</a></td>
			<td class="pe-name">${f.nome_completo ? frappe.utils.escape_html(f.nome_completo) : "—"}</td>
			<td>${f.posto ? frappe.utils.escape_html(f.posto) : "—"}</td>
			<td>${f.delegacao ? frappe.utils.escape_html(f.delegacao) : "—"}</td>
			<td class="pe-r"><span class="pe-faltas-n">${f.total_faltas}</span></td></tr>`).join("")
			: `<tr><td colspan="6" class="pe-empty">${__("Nenhum vigilante encontrado.")}</td></tr>`);
		this.$root.find("#pe-faltas-count").text(`${rows.length} ${__("de")} ${this.faltas.length}`);
	}

	// ============================================================ CHART PRIMITIVES
	_countup() {
		this.$root.find(".pe-num[data-to]").each((_, el) => {
			const to = +el.getAttribute("data-to"), t0 = performance.now(), dur = 1000, self = this;
			(function tick(t) {
				const p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
				el.textContent = self._fmt(Math.round(to * e));
				if (p < 1) requestAnimationFrame(tick);
			})(t0);
		});
	}

	_rank(id, items) {
		const host = this.$root.find(`#${id}`)[0];
		if (!host) return;
		if (!items.length) { host.innerHTML = `<div class="pe-empty">${__("Sem dados.")}</div>`; return; }
		const mx = Math.max(...items.map((i) => i.val), 1);
		host.innerHTML = items.map((it, i) => `
			<div class="pe-rank-row">
			  <span class="pe-rank-name" title="${frappe.utils.escape_html(it.name || "")}">${it.name ? frappe.utils.escape_html(it.name) : "—"}</span>
			  <div class="pe-rank-track"><div class="pe-rank-bar ${i === 0 ? "first" : ""}" data-w="${(it.val / mx) * 100}"></div></div>
			  <span class="pe-rank-val pe-num">${this._fmt(it.val)}${it.sub ? `<span class="pe-rank-sub">${it.sub}</span>` : ""}</span>
			</div>`).join("");
		this._raf2(() => host.querySelectorAll(".pe-rank-bar").forEach((b, i) =>
			setTimeout(() => (b.style.width = b.dataset.w + "%"), 60 * i)));
	}

	_colchart(id, labels, values, opts) {
		const host = this.$root.find(`#${id}`)[0];
		if (!host) return;
		const color = (opts && opts.color) || null;
		const mx = Math.max(...values, 1), peak = values.indexOf(Math.max(...values));
		host.innerHTML = values.map((v, i) => `
			<div class="pe-colw"><div class="pe-bar ${!color && i === peak ? "accent" : ""}" data-h="${(v / mx) * 100}"
				style="${color ? `background:${color}` : ""}"><span class="pe-bv">${v || ""}</span></div></div>`).join("");
		this._raf2(() => { host.classList.add("in"); host.querySelectorAll(".pe-bar").forEach((b, i) =>
			setTimeout(() => (b.style.height = b.dataset.h + "%"), 35 * i)); });
	}

	_dualcol(id, labels, a, b) {
		const host = this.$root.find(`#${id}`)[0];
		if (!host) return;
		const mx = Math.max(...a, ...b, 1);
		host.innerHTML = labels.map((_, i) => `
			<div class="pe-colw pe-dual">
			  <div class="pe-bar" data-h="${(a[i] / mx) * 100}" style="background:${this.C.good}"></div>
			  <div class="pe-bar" data-h="${(b[i] / mx) * 100}" style="background:${this.C.bad}"></div>
			</div>`).join("");
		this._raf2(() => { host.classList.add("in"); host.querySelectorAll(".pe-bar").forEach((bar, i) =>
			setTimeout(() => (bar.style.height = bar.dataset.h + "%"), 25 * i)); });
	}

	_colx(id, labels) {
		const host = this.$root.find(`#${id}`)[0];
		if (host) host.innerHTML = labels.map((l) => `<span>${l}</span>`).join("");
	}

	_legend(id, items) {
		const host = this.$root.find(`#${id}`)[0];
		if (host) host.innerHTML = items.map(([l, c]) =>
			`<span class="pe-leg-i"><i style="background:${c}"></i>${l}</span>`).join("");
	}

	_area(id, labels, values) {
		const host = this.$root.find(`#${id}`)[0];
		if (!host) return;
		const W = 600, H = 180, pad = 10, n = values.length, mx = Math.max(...values, 1);
		const x = (i) => pad + i * (W - 2 * pad) / (n - 1 || 1);
		const y = (v) => H - pad - (v / mx) * (H - 2 * pad);
		const line = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
		const fill = `M${x(0)},${H - pad} L${line.replace(/ /g, " L")} L${x(n - 1)},${H - pad} Z`;
		const dots = values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="2.5" fill="${this.C.accent}"/>`).join("");
		host.innerHTML = `
		<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="pe-area-svg" style="width:100%;height:180px">
		  <defs><linearGradient id="pe-ag-${id}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stop-color="${this.C.accent}" stop-opacity="0.18"/>
			<stop offset="100%" stop-color="${this.C.accent}" stop-opacity="0"/></linearGradient></defs>
		  <path d="${fill}" fill="url(#pe-ag-${id})"/>
		  <polyline points="${line}" fill="none" stroke="${this.C.accent}" stroke-width="2"
			vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
		  ${dots}
		</svg>`;
	}

	_donut(id, segs) {
		const host = this.$root.find(`#${id}`)[0];
		if (!host) return;
		const total = segs.reduce((s, x) => s + x.val, 0) || 1;
		const R = 52, C = 2 * Math.PI * R;
		let off = 0;
		const rings = segs.map((s) => {
			const len = (s.val / total) * C;
			const seg = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${s.color}" stroke-width="16"
				stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"/>`;
			off += len; return seg;
		}).join("");
		const legend = segs.map((s) => `<div class="pe-dleg-i"><i style="background:${s.color}"></i>
			<span>${s.label}</span><b class="pe-num">${this._fmt(s.val)}</b>
			<em>${Math.round((s.val / total) * 100)}%</em></div>`).join("");
		host.innerHTML = `<div class="pe-donut"><svg viewBox="0 0 140 140" width="140" height="140">${rings}
			<text x="70" y="66" text-anchor="middle" class="pe-donut-c">${this._fmt(total)}</text>
			<text x="70" y="84" text-anchor="middle" class="pe-donut-l">TOTAL</text></svg>
			<div class="pe-dleg">${legend}</div></div>`;
	}

	_raf2(fn) { requestAnimationFrame(() => requestAnimationFrame(fn)); }

	// ============================================================ FONTS + CSS
	_inject_fonts() {
		if (document.getElementById("pe-fonts")) return;
		const l = document.createElement("link");
		l.id = "pe-fonts"; l.rel = "stylesheet";
		l.href = "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500;600&display=swap";
		document.head.appendChild(l);
	}

	_inject_css() {
		if (document.getElementById("pe-css")) return;
		const css = `
/* SIGOS Painel Estatistico - editorial light. ASCII-only. */
.sigos-pe { background:#F4EFE4; }
.layout-main-section-wrapper:has(.sigos-pe), .page-body:has(.sigos-pe) { background:#F4EFE4; }
.sigos-pe .page-head, .sigos-pe + .page-head { display:none; }
.pe-root {
  --paper:#F4EFE4; --paper2:#FBF8F1; --paper3:#EFE8D8; --ink:#1B1712; --ink2:#6A6053;
  --ink3:#A99E8B; --line:#E1D7C4; --line2:#D2C6AF; --accent:#BC4A22; --accentInk:#8E3315;
  --wash:rgba(188,74,34,.08); --good:#5E7A3E; --bad:#A8472E; --graphite:#574E42;
  --serif:'Fraunces',Georgia,serif; --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
  --shadow:0 1px 2px rgba(40,30,15,.05), 0 12px 28px -18px rgba(40,30,15,.18);
  position:relative; max-width:1180px; margin:0 auto; padding:6px 12px 70px;
  color:var(--ink); font-family:var(--mono); font-size:13px; font-feature-settings:"tnum" 1;
}
.pe-root::before { content:""; position:fixed; inset:0; z-index:0; pointer-events:none; mix-blend-mode:multiply; opacity:.5;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.38'/%3E%3C/svg%3E"); }
.pe-root > * { position:relative; z-index:1; }
.pe-num { font-family:var(--serif); font-feature-settings:"tnum" 1; letter-spacing:-.01em; }
.pe-up { font-family:var(--mono); text-transform:uppercase; letter-spacing:.14em; font-size:10px; color:var(--ink3); font-weight:500; }

/* masthead */
.pe-mast { display:flex; justify-content:space-between; align-items:flex-end; padding:18px 4px 16px; }
.pe-mast-l { display:flex; align-items:flex-end; gap:16px; }
.pe-mark { width:44px; height:44px; border:1.5px solid var(--ink); border-radius:50%; display:grid; place-items:center;
  font-family:var(--serif); font-size:20px; font-weight:500; position:relative; flex:none; }
.pe-mark::after { content:""; position:absolute; inset:4px; border:1px solid var(--line2); border-radius:50%; }
.pe-wordmark { font-family:var(--serif); font-weight:400; font-size:34px; line-height:.9; letter-spacing:-.02em; }
.pe-wordmark b { font-weight:600; }
.pe-eyebrow { margin-top:7px; display:flex; gap:10px; align-items:center; }
.pe-tick { width:14px; height:1.5px; background:var(--accent); }
.pe-mast-r { text-align:right; display:flex; flex-direction:column; gap:6px; align-items:flex-end; }
.pe-date { font-family:var(--serif); font-size:15px; }
.pe-mast-meta { display:flex; gap:14px; align-items:center; }
.pe-pulse { display:inline-flex; align-items:center; gap:6px; color:var(--good); font-size:10px; text-transform:uppercase; letter-spacing:.1em; }
.pe-pulse i { width:6px; height:6px; border-radius:50%; background:var(--good); animation:pe-blip 2.4s ease-in-out infinite; }
@keyframes pe-blip { 0%,100%{opacity:1} 50%{opacity:.4} }
.pe-btn { font-family:var(--mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.12em; border:1px solid var(--line2);
  background:var(--paper2); color:var(--ink); padding:7px 13px; border-radius:2px; cursor:pointer; transition:.25s; }
.pe-btn:hover { border-color:var(--accent); color:var(--accentInk); }
.pe-rule { height:1.5px; background:var(--ink); position:relative; }
.pe-rule::after { content:""; position:absolute; left:0; right:0; top:3px; height:1px; background:var(--line2); }

/* sections */
.pe-sec { display:flex; align-items:baseline; gap:14px; margin:40px 4px 18px; }
.pe-sec-idx { font-family:var(--mono); font-size:11px; color:var(--accent); font-weight:600; letter-spacing:.1em; }
.pe-sec-title { font-family:var(--serif); font-size:21px; font-weight:500; letter-spacing:-.01em; margin:0; }
.pe-sec-line { flex:1; height:1px; background:var(--line); align-self:center; }
.pe-sec-aside { font-size:10px; text-transform:uppercase; letter-spacing:.14em; color:var(--ink3); }

/* hero */
.pe-hero { display:grid; grid-template-columns:repeat(4,1fr); background:var(--paper2); border:1px solid var(--line);
  border-radius:4px; box-shadow:var(--shadow); overflow:hidden; }
.pe-hero-cell { padding:24px 26px 22px; position:relative; }
.pe-hero-cell + .pe-hero-cell { border-left:1px solid var(--line); }
.pe-hlbl { display:flex; justify-content:space-between; margin-bottom:16px; }
.pe-hval { font-family:var(--serif); font-weight:300; font-size:50px; line-height:.9; letter-spacing:-.025em; }
.pe-hfoot { display:flex; align-items:center; gap:8px; margin-top:12px; min-height:16px; }
.pe-delta { font-size:11px; font-weight:500; letter-spacing:.02em; }
.pe-delta.up { color:var(--good); } .pe-delta.down { color:var(--bad); } .pe-delta.flat { color:var(--ink3); }
.pe-dsub { font-size:10px; color:var(--ink3); text-transform:uppercase; letter-spacing:.1em; }
.pe-feature .pe-hval { color:var(--accentInk); }
.pe-feature { background:linear-gradient(180deg,var(--wash),transparent); }

/* strip */
.pe-strip { margin-top:14px; background:var(--paper3); border:1px solid var(--line); border-radius:4px;
  display:flex; flex-wrap:wrap; align-items:center; padding:4px 6px; }
.pe-strip-i { display:flex; align-items:baseline; gap:8px; padding:11px 18px; position:relative; flex:1 0 auto; }
.pe-strip-i + .pe-strip-i::before { content:""; position:absolute; left:0; top:13px; bottom:13px; width:1px; background:var(--line2); }
.pe-strip-i .pe-k { font-size:9.5px; text-transform:uppercase; letter-spacing:.13em; color:var(--ink2); }
.pe-strip-i .pe-v { font-family:var(--serif); font-size:19px; font-weight:500; }

/* cards */
.pe-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-bottom:18px; }
.pe-card { background:var(--paper2); border:1px solid var(--line); border-radius:4px; box-shadow:var(--shadow); padding:22px 24px; }
.pe-card-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px; }
.pe-card-title { font-family:var(--serif); font-size:18px; font-weight:500; letter-spacing:-.01em; }
.pe-card-sub { font-size:10px; text-transform:uppercase; letter-spacing:.13em; color:var(--ink3); margin-top:3px; }
.pe-pills { display:flex; gap:3px; background:var(--paper3); border:1px solid var(--line); border-radius:3px; padding:3px; }
.pe-pill { font-family:var(--mono); font-size:10px; letter-spacing:.06em; border:0; background:transparent; color:var(--ink2);
  padding:4px 10px; border-radius:2px; cursor:pointer; transition:.2s; }
.pe-pill:hover { color:var(--ink); } .pe-pill.on { background:var(--ink); color:var(--paper2); }

/* column charts */
.pe-col { display:flex; align-items:flex-end; gap:7px; height:188px; margin-top:24px; padding-bottom:2px; border-bottom:1px solid var(--line); }
.pe-colw { flex:1; display:flex; flex-direction:column; align-items:center; gap:0; height:100%; justify-content:flex-end; }
.pe-colw.pe-dual { flex-direction:row; align-items:flex-end; gap:3px; }
.pe-bar { width:100%; max-width:32px; background:var(--graphite); border-radius:2px 2px 0 0; height:0;
  transition:height 1s cubic-bezier(.2,.9,.25,1); position:relative; }
.pe-colw.pe-dual .pe-bar { max-width:14px; }
.pe-bar.accent { background:var(--accent); }
.pe-bv { position:absolute; top:-18px; left:50%; transform:translateX(-50%); font-family:var(--serif); font-size:11px;
  color:var(--ink2); opacity:0; transition:opacity .4s .6s; }
.pe-bar.accent .pe-bv { color:var(--accentInk); font-weight:600; }
.pe-col.in .pe-bv { opacity:1; }
.pe-colx { display:flex; gap:7px; margin-top:9px; }
.pe-colx span { flex:1; text-align:center; font-size:9px; letter-spacing:.04em; color:var(--ink3); text-transform:uppercase; white-space:nowrap; overflow:hidden; }
.pe-legend { display:flex; gap:16px; margin-top:4px; }
.pe-leg-i { display:flex; align-items:center; gap:6px; font-size:10.5px; text-transform:uppercase; letter-spacing:.1em; color:var(--ink2); }
.pe-leg-i i { width:9px; height:9px; border-radius:2px; }
.pe-alert-col { height:90px; margin-top:18px; } .pe-alert-col .pe-bar { max-width:26px; opacity:.88; }

/* rank charts */
.pe-rank { margin-top:22px; display:flex; flex-direction:column; gap:14px; }
.pe-rank-row { display:grid; grid-template-columns:120px 1fr 78px; align-items:center; gap:14px; }
.pe-rank-name { font-size:11.5px; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pe-rank-track { height:9px; background:var(--paper3); border-radius:5px; overflow:hidden; }
.pe-rank-bar { height:100%; width:0; background:var(--graphite); border-radius:5px; transition:width 1s cubic-bezier(.2,.9,.25,1); }
.pe-rank-bar.first { background:var(--accent); }
.pe-rank-val { font-family:var(--serif); font-size:15px; text-align:right; font-weight:500; display:flex; flex-direction:column; align-items:flex-end; }
.pe-rank-sub { font-family:var(--mono); font-size:8.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink3); font-weight:400; }

/* area chart */
.pe-area-host { margin-top:24px; border-bottom:1px solid var(--line); }

/* donut */
.pe-donut { display:flex; align-items:center; gap:26px; margin-top:24px; }
.pe-donut-c { font-family:var(--serif); font-size:20px; font-weight:500; fill:var(--ink); }
.pe-donut-l { font-family:var(--mono); font-size:7px; letter-spacing:.18em; fill:var(--ink3); }
.pe-dleg { display:flex; flex-direction:column; gap:11px; flex:1; }
.pe-dleg-i { display:grid; grid-template-columns:11px 1fr auto auto; align-items:center; gap:9px; font-size:11.5px; color:var(--ink2); }
.pe-dleg-i i { width:11px; height:11px; border-radius:2px; }
.pe-dleg-i b { font-family:var(--serif); font-size:15px; color:var(--ink); font-weight:500; }
.pe-dleg-i em { font-style:normal; font-size:10px; color:var(--ink3); min-width:34px; text-align:right; }

/* alert drawer */
.pe-alert-head { display:flex; justify-content:space-between; align-items:center; }
.pe-badge { font-family:var(--mono); font-size:10px; letter-spacing:.08em; text-transform:uppercase; background:var(--wash);
  color:var(--accentInk); border:1px solid rgba(188,74,34,.25); padding:5px 11px; border-radius:2px; }
.pe-toggle { width:100%; margin-top:18px; background:transparent; border:1px dashed var(--line2); color:var(--ink2);
  font-family:var(--mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.14em; padding:11px; border-radius:3px;
  cursor:pointer; display:flex; align-items:center; justify-content:center; gap:9px; transition:.25s; }
.pe-toggle:hover { border-color:var(--accent); color:var(--accentInk); }
.pe-toggle svg { width:13px; height:13px; transition:transform .35s; }
.pe-drawer { max-height:0; overflow:hidden; transition:max-height .45s cubic-bezier(.3,.8,.3,1); }
.pe-drawer.open { max-height:1400px; }
.pe-search { display:flex; align-items:center; gap:9px; background:var(--paper3); border:1px solid var(--line); border-radius:3px;
  padding:0 13px; margin:18px 0 4px; height:38px; }
.pe-search svg { width:13px; height:13px; color:var(--ink3); flex:none; }
.pe-search input { flex:1; border:0; background:transparent; outline:0; font-family:var(--mono); font-size:12px; color:var(--ink); }
.pe-table { width:100%; border-collapse:collapse; margin-top:10px; }
.pe-table thead th { font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:.13em; color:var(--ink3);
  font-weight:500; text-align:left; padding:10px 12px; border-bottom:1px solid var(--line2); }
.pe-table th.pe-r, .pe-table td.pe-r { text-align:right; }
.pe-table tbody td { padding:12px; border-bottom:1px solid var(--line); font-size:12.5px; color:var(--ink2); }
.pe-table tbody tr:hover { background:var(--wash); }
.pe-table td.pe-idx { font-family:var(--mono); color:var(--ink3); font-size:11px; }
.pe-table td.pe-name { color:var(--ink); }
.pe-link { color:var(--accentInk); text-decoration:none; border-bottom:1px solid transparent; }
.pe-link:hover { border-color:var(--accentInk); }
.pe-faltas-n { font-family:var(--serif); font-size:15px; font-weight:600; color:var(--bad); }
.pe-drawer-foot { display:flex; justify-content:space-between; padding:14px 12px 2px; color:var(--ink3); font-size:10px; text-transform:uppercase; letter-spacing:.1em; }
.pe-empty { padding:26px; text-align:center; color:var(--ink3); font-size:11px; letter-spacing:.06em; }

/* reveal */
.pe-rise { opacity:0; transform:translateY(12px); animation:pe-rise .7s cubic-bezier(.2,.9,.25,1) forwards; }
.pe-rise:nth-of-type(2){animation-delay:.04s}.pe-rise:nth-of-type(3){animation-delay:.08s}
.pe-rise:nth-of-type(4){animation-delay:.12s}.pe-rise:nth-of-type(5){animation-delay:.16s}
@keyframes pe-rise { to { opacity:1; transform:none; } }

@media (max-width:900px) {
  .pe-grid2 { grid-template-columns:1fr; }
  .pe-hero { grid-template-columns:1fr 1fr; }
  .pe-hero-cell:nth-child(3) { border-left:0; }
  .pe-hero-cell:nth-child(n+3) { border-top:1px solid var(--line); }
}
`;
		const s = document.createElement("style");
		s.id = "pe-css"; s.textContent = css;
		document.head.appendChild(s);
	}
};
