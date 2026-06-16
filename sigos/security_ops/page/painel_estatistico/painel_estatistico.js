// SIGOS - Painel Estatistico (RH). "Operations Daylight": bright control surface,
// all-custom charts (no chart lib). Light-only. Shares the design system with Painel CCO.
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
			accent: "#4F46E5", accentInk: "#4338CA", graphite: "#64748B", ink3: "#93A1B5",
			good: "#16A34A", bad: "#E5484D", amber: "#F59E0B", info: "#2F6FED",
			palette: ["#4F46E5", "#2F6FED", "#16A34A", "#F59E0B", "#E5484D", "#0EA5A3", "#8B5CF6", "#64748B"],
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
      <div class="pe-mast-id">
        <div class="pe-eyebrow"><span class="pe-up">Recursos Humanos</span></div>
        <h1 class="pe-h1">Painel RH</h1>
        <div class="pe-date">${hoje}</div>
      </div>
    </div>
    <div class="pe-mast-r">
      <span class="pe-pulse"><i></i><span class="pe-stamp">${__("A carregar...")}</span></span>
      <button class="pe-btn pe-refresh">${__("Actualizar")}</button>
    </div>
  </header>

  ${this._sec("Resumo Operacional", "Efectivo em serviço")}
  <div class="pe-hero pe-rise">
    ${this._hero_cell("activos", "Vigilantes Activos", true)}
    ${this._hero_cell("postos_activos", "Postos Activos")}
    ${this._hero_cell("reservas", "Em Reserva")}
    ${this._hero_cell("armados", "Vigilantes Armados")}
  </div>
  <div class="pe-strip pe-rise" id="pe-strip"></div>

  ${this._sec("Composição do Efectivo", "Distribuição do activo")}
  <div class="pe-grid2">
    ${this._card("Vigilantes por Categoria", "Efectivo activo", `<div class="pe-rank" id="pe-cat"></div>`)}
    ${this._card("Vigilantes por Regime", "Distribuição de turnos", `<div class="pe-rank" id="pe-reg"></div>`)}
  </div>
  <div class="pe-grid2">
    ${this._card("Distribuição por Sexo", "Composição de género", `<div class="pe-donut-host" id="pe-sexo"></div>`)}
    ${this._card("Vigilantes por Delegação", "Efectivo activo", `<div class="pe-rank" id="pe-deleg"></div>`)}
  </div>

  ${this._sec("Movimento &amp; Rotatividade", "Período seleccionado", this._period_pills())}
  <div class="pe-grid2">
    ${this._card("Admitidos vs Demitidos", "Entradas e saídas mensais", `<div class="pe-legend" id="pe-ad-leg"></div><div class="pe-col" id="pe-admdem"></div><div class="pe-colx" id="pe-admdem-x"></div>`)}
    ${this._card("Rotatividades Mensais", "Movimentações de efectivo", `<div class="pe-col" id="pe-rot"></div><div class="pe-colx" id="pe-rot-x"></div>`)}
  </div>
  <div class="pe-grid2">
    ${this._card("Ausências Mensais", "Faltas registadas (submetidas)", `<div class="pe-area-host" id="pe-aus"></div><div class="pe-colx" id="pe-aus-x"></div>`)}
    ${this._card("Rotatividades por Operação", "Tipo de movimento", `<div class="pe-rank" id="pe-rottipo"></div>`)}
  </div>

  ${this._sec("Armamento &amp; Carteira", "Recursos e clientes")}
  <div class="pe-grid2">
    ${this._card("Armas por Delegação", "Total e destacadas", `<div class="pe-rank" id="pe-armas"></div>`)}
    ${this._card("Top Clientes por Efectivo", "Maiores contratos", `<div class="pe-rank" id="pe-clientes"></div>`)}
  </div>

  ${this._sec("Alertas &amp; Relatórios", "Acção recomendada")}
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

	_sec(title, aside, right) {
		return `<div class="pe-sec pe-rise">
			<span class="pe-sec-bar"></span><h2 class="pe-sec-title">${title}</h2>
			<span class="pe-sec-line"></span>${right || `<span class="pe-sec-aside">${aside}</span>`}</div>`;
	}
	_hero_cell(id, label, feature) {
		return `<div class="pe-kpi ${feature ? "feature" : ""}" id="pe-hero-${id}">
			<div class="pe-kpi-top"><span class="pe-up pe-kpi-lbl">${label}</span><span class="pe-kpi-delta"></span></div>
			<div class="pe-kpi-mid"><div class="pe-kpi-val pe-num" data-to="0">0</div></div>
			<div class="pe-kpi-foot"></div></div>`;
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
		this._kpi("activos", d.activos, this._delta_chip(net), "este mês");
		this._kpi("postos_activos", d.postos_activos, "", `de ${this._fmt(d.postos_total)} postos`);
		this._kpi("reservas", d.reservas, "", "disponíveis");
		this._kpi("armados", d.armados, "", `${armPct}% do efectivo`);

		const strip = [
			["Mulheres", d.mulheres], ["Homens", d.homens], ["Supervisores", d.supervisores],
			["Administrativos", d.administrativos], ["Clientes", d.clientes],
			["Delegações", d.delegacoes], ["Postos", d.postos_total], ["Armas", d.armas],
		];
		this.$root.find("#pe-strip").html(strip.map(([k, v]) =>
			`<div class="pe-strip-i"><span class="pe-k">${k}</span><span class="pe-v pe-num" data-to="${v || 0}">0</span></div>`).join(""));
		this._countup();
	}
	_delta_chip(n) {
		if (!n) return `<span class="pe-delta flat">&plusmn;0</span>`;
		const up = n > 0;
		return `<span class="pe-delta ${up ? "up" : "down"}">${up ? "&#9650;" : "&#9660;"} ${Math.abs(n)}</span>`;
	}
	_kpi(id, val, deltaHtml, sub) {
		const cell = this.$root.find(`#pe-hero-${id}`);
		cell.find(".pe-kpi-val").attr("data-to", val || 0);
		cell.find(".pe-kpi-delta").html(deltaHtml || "");
		cell.find(".pe-kpi-foot").html(sub ? `<span class="pe-kpi-sub">${sub}</span>` : "");
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
		this._area("pe-aus", d.labels, d.ausencias, { color: this.C.bad });
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
			const to = +el.getAttribute("data-to"), t0 = performance.now(), dur = 950, self = this;
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

	_area(id, labels, values, opts) {
		const host = this.$root.find(`#${id}`)[0];
		if (!host) return;
		const color = (opts && opts.color) || this.C.accent;
		const W = 600, H = 180, pad = 10, n = values.length, mx = Math.max(...values, 1);
		const x = (i) => pad + i * (W - 2 * pad) / (n - 1 || 1);
		const y = (v) => H - pad - (v / mx) * (H - 2 * pad);
		const line = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
		const fill = `M${x(0)},${H - pad} L${line.replace(/ /g, " L")} L${x(n - 1)},${H - pad} Z`;
		const dots = values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="2.5" fill="${color}"/>`).join("");
		host.innerHTML = `
		<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="pe-area-svg" style="width:100%;height:180px">
		  <defs><linearGradient id="pe-ag-${id}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stop-color="${color}" stop-opacity="0.18"/>
			<stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
		  <path d="${fill}" fill="url(#pe-ag-${id})"/>
		  <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2"
			vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
		  ${dots}
		</svg>`;
	}

	_donut(id, segs) {
		const host = this.$root.find(`#${id}`)[0];
		if (!host) return;
		segs = (segs || []).filter((s) => s.val > 0);
		if (!segs.length) { host.innerHTML = `<div class="pe-empty">${__("Sem dados.")}</div>`; return; }
		const total = segs.reduce((s, x) => s + x.val, 0) || 1;
		const R = 52, C = 2 * Math.PI * R;
		let off = 0;
		const rings = segs.map((s) => {
			const len = (s.val / total) * C;
			const seg = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${s.color}" stroke-width="15"
				stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"/>`;
			off += len; return seg;
		}).join("");
		const legend = segs.map((s) => `<div class="pe-dleg-i"><i style="background:${s.color}"></i>
			<span>${frappe.utils.escape_html(s.label || "—")}</span><b class="pe-num">${this._fmt(s.val)}</b>
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
		l.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";
		document.head.appendChild(l);
	}

	_inject_css() {
		if (document.getElementById("pe-css")) return;
		const css = `
/* SIGOS Painel RH - Operations Daylight. ASCII-only. */
.sigos-pe { background:#F4F6FA; }
.layout-main-section-wrapper:has(.sigos-pe), .page-body:has(.sigos-pe) { background:#F4F6FA; }
.sigos-pe .page-head, .sigos-pe + .page-head { display:none; }
.pe-root {
  --paper:#F4F6FA; --paper2:#FFFFFF; --paper3:#EEF1F6; --ink:#0E1726; --ink2:#5B6B82;
  --ink3:#93A1B5; --line:#E6EAF2; --line2:#D5DCE8; --accent:#4F46E5; --accentInk:#4338CA;
  --wash:rgba(79,70,229,.07); --good:#16A34A; --bad:#E5484D; --amber:#F59E0B;
  --graphite:#64748B; --goodWash:rgba(22,163,74,.12); --badWash:rgba(229,72,77,.12);
  --display:'Space Grotesk',system-ui,sans-serif; --body:'Inter',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
  --shadow:0 1px 2px rgba(16,23,38,.04), 0 14px 34px -20px rgba(16,23,38,.22);
  --r:16px;
  position:relative; max-width:1200px; margin:0 auto; padding:8px 14px 80px;
  color:var(--ink); font-family:var(--body); font-size:13px; font-feature-settings:"tnum" 1; -webkit-font-smoothing:antialiased;
}
.pe-num { font-family:var(--display); font-feature-settings:"tnum" 1; letter-spacing:-.01em; }
.pe-up { font-family:var(--body); text-transform:uppercase; letter-spacing:.12em; font-size:10px; color:var(--ink3); font-weight:600; }

/* masthead */
.pe-mast { display:flex; justify-content:space-between; align-items:flex-start; padding:20px 4px 14px; gap:16px; flex-wrap:wrap; }
.pe-mast-l { display:flex; align-items:flex-start; gap:15px; }
.pe-mark { width:42px; height:42px; border-radius:13px; display:grid; place-items:center; flex:none;
  background:linear-gradient(150deg,var(--accent),var(--accentInk)); color:#fff; font-family:var(--display); font-size:21px; font-weight:600;
  box-shadow:0 6px 16px -6px rgba(79,70,229,.6); }
.pe-eyebrow { margin-bottom:4px; }
.pe-h1 { font-family:var(--display); font-weight:600; font-size:27px; line-height:1; letter-spacing:-.02em; margin:0; color:var(--ink); }
.pe-date { font-family:var(--body); font-size:13px; color:var(--ink2); margin-top:7px; font-weight:500; }
.pe-mast-r { display:flex; gap:10px; align-items:center; }
.pe-pulse { display:inline-flex; align-items:center; gap:7px; color:var(--ink3); font-size:10px; text-transform:uppercase; letter-spacing:.08em; font-weight:600; }
.pe-pulse i { width:7px; height:7px; border-radius:50%; background:var(--good); box-shadow:0 0 0 3px var(--goodWash); animation:pe-blip 2.4s ease-in-out infinite; }
@keyframes pe-blip { 0%,100%{opacity:1} 50%{opacity:.45} }
.pe-btn { font-family:var(--body); font-size:11px; font-weight:600; letter-spacing:.02em; border:1px solid var(--line2);
  background:var(--paper2); color:var(--ink2); padding:8px 14px; border-radius:10px; cursor:pointer; transition:.2s; box-shadow:var(--shadow); }
.pe-btn:hover { background:var(--accent); color:#fff; border-color:var(--accent); }

/* sections */
.pe-sec { display:flex; align-items:center; gap:13px; margin:40px 4px 18px; }
.pe-sec-bar { width:4px; height:20px; border-radius:3px; background:var(--accent); flex:none; }
.pe-sec-title { font-family:var(--display); font-size:19px; font-weight:600; letter-spacing:-.01em; margin:0; }
.pe-sec-line { flex:1; height:1px; background:var(--line); }
.pe-sec-aside { font-size:11px; color:var(--ink3); font-weight:500; }

/* hero KPI cards */
.pe-hero { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; }
.pe-kpi { background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); padding:18px 19px 16px; display:flex; flex-direction:column; min-width:0; }
.pe-kpi.feature { border-color:transparent; box-shadow:0 1px 2px rgba(16,23,38,.04), 0 18px 40px -22px rgba(79,70,229,.45); position:relative; }
.pe-kpi.feature::before { content:""; position:absolute; inset:0; border-radius:var(--r); padding:1px; background:linear-gradient(150deg,var(--accent),transparent 60%); -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0); -webkit-mask-composite:xor; mask-composite:exclude; pointer-events:none; }
.pe-kpi-top { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; min-height:16px; }
.pe-kpi-lbl { flex:1; min-width:0; font-size:9.5px; letter-spacing:.08em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pe-kpi-val { font-family:var(--display); font-weight:600; font-size:40px; line-height:.92; letter-spacing:-.025em; color:var(--ink); }
.pe-kpi.feature .pe-kpi-val { color:var(--accentInk); }
.pe-kpi-foot { margin-top:12px; min-height:14px; }
.pe-kpi-sub { font-size:10px; color:var(--ink3); text-transform:uppercase; letter-spacing:.07em; font-weight:600; }
.pe-delta { font-family:var(--body); font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; white-space:nowrap; flex:none; }
.pe-delta.up { color:var(--good); background:var(--goodWash); }
.pe-delta.down { color:var(--bad); background:var(--badWash); }
.pe-delta.flat { color:var(--ink3); background:var(--paper3); }
@media (max-width:980px){ .pe-hero { grid-template-columns:repeat(2,1fr); } }

/* strip */
.pe-strip { margin-top:14px; background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow);
  display:flex; flex-wrap:wrap; align-items:center; padding:4px 6px; }
.pe-strip-i { display:flex; align-items:baseline; gap:9px; padding:13px 20px; position:relative; flex:1 0 auto; }
.pe-strip-i + .pe-strip-i::before { content:""; position:absolute; left:0; top:14px; bottom:14px; width:1px; background:var(--line); }
.pe-strip-i .pe-k { font-size:9.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink3); font-weight:600; }
.pe-strip-i .pe-v { font-family:var(--display); font-size:19px; font-weight:600; }

/* cards */
.pe-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-bottom:18px; }
.pe-card { background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); padding:22px 24px; }
.pe-card-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px; }
.pe-card-title { font-family:var(--display); font-size:16px; font-weight:600; letter-spacing:-.01em; }
.pe-card-sub { font-size:11px; color:var(--ink3); margin-top:3px; font-weight:500; }
.pe-pills { display:flex; gap:3px; background:var(--paper3); border:1px solid var(--line); border-radius:11px; padding:3px; }
.pe-pill { font-family:var(--body); font-size:11px; font-weight:600; border:0; background:transparent; color:var(--ink2);
  padding:6px 12px; border-radius:8px; cursor:pointer; transition:.18s; }
.pe-pill:hover { color:var(--ink); } .pe-pill.on { background:var(--paper2); color:var(--accent); box-shadow:0 1px 3px rgba(16,23,38,.12); }

/* column charts */
.pe-col { display:flex; align-items:flex-end; gap:7px; height:188px; margin-top:24px; padding-bottom:2px; border-bottom:1px solid var(--line); }
.pe-colw { flex:1; display:flex; flex-direction:column; align-items:center; gap:0; height:100%; justify-content:flex-end; }
.pe-colw.pe-dual { flex-direction:row; align-items:flex-end; gap:3px; }
.pe-bar { width:100%; max-width:30px; background:var(--graphite); border-radius:5px 5px 0 0; height:0;
  transition:height 1s cubic-bezier(.2,.9,.25,1); position:relative; }
.pe-colw.pe-dual .pe-bar { max-width:13px; }
.pe-bar.accent { background:var(--accent); }
.pe-bv { position:absolute; top:-18px; left:50%; transform:translateX(-50%); font-family:var(--display); font-size:11px; font-weight:600;
  color:var(--ink2); opacity:0; transition:opacity .4s .6s; }
.pe-bar.accent .pe-bv { color:var(--accent); }
.pe-col.in .pe-bv { opacity:1; }
.pe-colx { display:flex; gap:7px; margin-top:9px; }
.pe-colx span { flex:1; text-align:center; font-size:9px; letter-spacing:.02em; color:var(--ink3); text-transform:uppercase; white-space:nowrap; overflow:hidden; font-weight:500; }
.pe-legend { display:flex; gap:16px; margin-top:4px; }
.pe-leg-i { display:flex; align-items:center; gap:6px; font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink2); font-weight:600; }
.pe-leg-i i { width:10px; height:10px; border-radius:3px; }
.pe-alert-col { height:90px; margin-top:18px; } .pe-alert-col .pe-bar { max-width:24px; opacity:.9; }

/* rank charts */
.pe-rank { margin-top:22px; display:flex; flex-direction:column; gap:14px; }
.pe-rank-row { display:grid; grid-template-columns:120px 1fr 88px; align-items:center; gap:14px; }
.pe-rank-name { font-size:12px; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:500; }
.pe-rank-track { height:9px; background:var(--paper3); border-radius:6px; overflow:hidden; }
.pe-rank-bar { height:100%; width:0; background:var(--graphite); border-radius:6px; transition:width 1s cubic-bezier(.2,.9,.25,1); }
.pe-rank-bar.first { background:var(--accent); }
.pe-rank-val { font-family:var(--display); font-size:15px; text-align:right; font-weight:600; display:flex; flex-direction:column; align-items:flex-end; }
.pe-rank-sub { font-family:var(--body); font-size:8.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink3); font-weight:600; }

/* area chart */
.pe-area-host { margin-top:24px; border-bottom:1px solid var(--line); }

/* donut */
.pe-donut { display:flex; align-items:center; gap:26px; margin-top:24px; flex-wrap:wrap; }
.pe-donut-c { font-family:var(--display); font-size:20px; font-weight:600; fill:var(--ink); }
.pe-donut-l { font-family:var(--body); font-size:7px; font-weight:600; letter-spacing:.18em; fill:var(--ink3); }
.pe-dleg { display:flex; flex-direction:column; gap:11px; flex:1; min-width:150px; }
.pe-dleg-i { display:grid; grid-template-columns:11px 1fr auto auto; align-items:center; gap:9px; font-size:12px; color:var(--ink2); }
.pe-dleg-i i { width:11px; height:11px; border-radius:3px; }
.pe-dleg-i b { font-family:var(--display); font-size:15px; color:var(--ink); font-weight:600; }
.pe-dleg-i em { font-style:normal; font-size:10px; color:var(--ink3); min-width:34px; text-align:right; font-weight:500; }

/* alert drawer */
.pe-alert-head { display:flex; justify-content:space-between; align-items:center; }
.pe-badge { font-family:var(--body); font-size:10px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; background:var(--badWash);
  color:var(--bad); border:1px solid rgba(229,72,77,.25); padding:5px 11px; border-radius:999px; }
.pe-toggle { width:100%; margin-top:18px; background:var(--paper3); border:1px solid var(--line); color:var(--ink2);
  font-family:var(--body); font-size:11px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; padding:11px; border-radius:10px;
  cursor:pointer; display:flex; align-items:center; justify-content:center; gap:9px; transition:.25s; }
.pe-toggle:hover { border-color:var(--accent); color:var(--accent); }
.pe-toggle svg { width:13px; height:13px; transition:transform .35s; }
.pe-drawer { max-height:0; overflow:hidden; transition:max-height .45s cubic-bezier(.3,.8,.3,1); }
.pe-drawer.open { max-height:1400px; }
.pe-search { display:flex; align-items:center; gap:9px; background:var(--paper3); border:1px solid var(--line); border-radius:10px;
  padding:0 13px; margin:18px 0 4px; height:38px; }
.pe-search svg { width:13px; height:13px; color:var(--ink3); flex:none; }
.pe-search input { flex:1; border:0; background:transparent; outline:0; font-family:var(--body); font-size:12px; color:var(--ink); }
.pe-table { width:100%; border-collapse:collapse; margin-top:10px; }
.pe-table thead th { font-family:var(--body); font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink3);
  font-weight:600; text-align:left; padding:10px 12px; border-bottom:1px solid var(--line2); }
.pe-table th.pe-r, .pe-table td.pe-r { text-align:right; }
.pe-table tbody td { padding:12px; border-bottom:1px solid var(--line); font-size:12.5px; color:var(--ink2); }
.pe-table tbody tr:hover { background:var(--wash); }
.pe-table td.pe-idx { font-family:var(--mono); color:var(--ink3); font-size:11px; }
.pe-table td.pe-name { color:var(--ink); font-weight:500; }
.pe-link { font-family:var(--mono); color:var(--accent); text-decoration:none; border-bottom:1px solid transparent; }
.pe-link:hover { border-color:var(--accent); }
.pe-faltas-n { font-family:var(--display); font-size:15px; font-weight:600; color:var(--bad); }
.pe-drawer-foot { display:flex; justify-content:space-between; padding:14px 12px 2px; color:var(--ink3); font-size:10px; text-transform:uppercase; letter-spacing:.08em; font-weight:500; }
.pe-empty { padding:26px; text-align:center; color:var(--ink3); font-size:12px; }

/* reveal */
.pe-rise { opacity:0; transform:translateY(12px); animation:pe-rise .6s cubic-bezier(.2,.9,.25,1) forwards; }
.pe-rise:nth-of-type(2){animation-delay:.04s}.pe-rise:nth-of-type(3){animation-delay:.08s}
.pe-rise:nth-of-type(4){animation-delay:.12s}.pe-rise:nth-of-type(5){animation-delay:.16s}
@keyframes pe-rise { to { opacity:1; transform:none; } }
@media (prefers-reduced-motion:reduce){ .pe-rise{ animation:none; opacity:1; transform:none; } .pe-bar,.pe-rank-bar{ transition:none; } }

@media (max-width:900px) {
  .pe-grid2 { grid-template-columns:1fr; }
}
`;
		const s = document.createElement("style");
		s.id = "pe-css"; s.textContent = css;
		document.head.appendChild(s);
	}
};
