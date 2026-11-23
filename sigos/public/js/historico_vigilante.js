// Histórico do Vigilante — everything that happened with a guard (sigos.historico +
// sigos.disciplinar.dossie). One component, two modes:
//   sigos.historico.montar($el, vigilante, { modo: "pagina" })    full page: header, alerts,
//                                                                  KPIs, timeline + side summary
//   sigos.historico.montar($el, vigilante, { modo: "embutido" })   timeline only (Diretório tab)
// sigos.historico.abrir(vigilante) routes to the page. Operations Daylight tokens; CSS is
// ASCII-only and scoped to .hv-root.
frappe.provide("sigos.historico");

(function () {
	const esc = (v) => frappe.utils.escape_html(v == null ? "" : String(v));
	const dt = (d) => (d ? frappe.datetime.str_to_user(String(d).slice(0, 10)) : "—");
	const moeda = (v) => format_currency(v || 0);
	const url = (doctype, name) => `/app/${frappe.router.slug(doctype)}/${encodeURIComponent(name)}`;
	const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro",
		"Outubro", "Novembro", "Dezembro"];
	const MES_CURTO = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
	const DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

	// category icons (24px stroke paths)
	const ICON = {
		operacoes: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"/>',
		assiduidade: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
		disciplinar: '<path d="M12 4l9 16H3L12 4z"/><path d="M12 10v4M12 17h.01"/>',
		carreira: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2"/>',
		salario: '<circle cx="12" cy="12" r="8"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1.1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5v1.5M12 16v1.5"/>',
		material: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/>',
		todos: '<path d="M4 6h16M4 12h16M4 18h10"/>',
	};
	const ico = (k, cls) => `<svg class="${cls || "hv-ico"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[k] || ICON.todos}</svg>`;

	sigos.historico.abrir = (vigilante) => frappe.set_route("historico-vigilante", vigilante);

	sigos.historico.montar = function ($el, vigilante, opts) {
		css();
		const h = new Historico($el, vigilante, opts || {});
		h.iniciar();
		return h;
	};

	class Historico {
		constructor($el, vigilante, opts) {
			this.$el = $el;
			this.vig = vigilante;
			this.pagina = (opts.modo || "pagina") === "pagina";
			this.st = { periodo: "12m", de: null, ate: null, cat: "todos", busca: "", cancelados: false };
			this.abertos = new Set();
		}

		iniciar() {
			this.$el.html(`<div class="hv-root ${this.pagina ? "hv-pagina" : "hv-embutido"}">
				${this.pagina ? '<div data-hv="topo"><div class="hv-skel hv-skel-head"></div><div class="hv-skel hv-skel-kpis"></div></div>' : ""}
				<div class="hv-grid ${this.pagina ? "" : "hv-grid-1"}">
					<div class="hv-main">
						<div class="hv-toolbar" data-hv="toolbar"></div>
						<div data-hv="feed"><div class="hv-skel hv-skel-feed"></div></div>
					</div>
					${this.pagina ? '<aside class="hv-side" data-hv="side"></aside>' : ""}
				</div>
			</div>`);
			this.$r = this.$el.find(".hv-root");
			this._toolbar();
			if (this.pagina) this._carregar_dossie();
			this._carregar();
		}

		// ─── data ─────────────────────────────────────────────────────────
		_intervalo() {
			const hoje = frappe.datetime.get_today();
			if (this.st.periodo === "3m") return { de: frappe.datetime.add_months(hoje, -3), ate: hoje };
			if (this.st.periodo === "12m") return { de: frappe.datetime.add_months(hoje, -12), ate: hoje };
			if (this.st.periodo === "custom") return { de: this.st.de, ate: this.st.ate };
			return { de: null, ate: hoje };
		}

		_carregar() {
			const iv = this._intervalo();
			const pedido = (this._pedido = (this._pedido || 0) + 1);
			this.$r.find('[data-hv="feed"]').css("opacity", 0.5);
			frappe.xcall("sigos.historico.historico_vigilante", {
				vigilante: this.vig, de: iv.de, ate: iv.ate, incluir_cancelados: this.st.cancelados ? 1 : 0,
			}).then((d) => {
				if (pedido !== this._pedido) return;
				d.eventos.sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
				this.dados = d;
				this.$r.find('[data-hv="feed"]').css("opacity", 1);
				this._chips();
				this._feed();
				if (this.pagina) this._side();
			}).catch(() => {
				this.$r.find('[data-hv="feed"]').css("opacity", 1)
					.html(`<div class="hv-vazio">${__("Sem permissão para ver o histórico deste vigilante.")}</div>`);
			});
		}

		_carregar_dossie() {
			frappe.xcall("sigos.disciplinar.dossie.dossie_vigilante", { vigilante: this.vig }).then((d) => {
				if (!d) return;
				this.dossie = d;
				this._topo();
				if (this.dados) this._side();
			}).catch(() => this.$r.find('[data-hv="topo"]').html(""));
			frappe.xcall("sigos.historico.hoje_vigilante", { vigilante: this.vig }).then((h) => {
				this.hoje = h;
				if (this.dossie) this._topo();
			}).catch(() => {});
		}

		// "Hoje" chip: today's turno(s) from the active escala, or folga / sem escala.
		_chipHoje() {
			const h = this.hoje;
			if (!h) return "";
			const trab = (h.turnos || []).filter((t) => !t.e_folga);
			let txt, tom = "";
			if (trab.length) {
				txt = trab.map((t) => [t.turno, t.periodo && t.periodo !== t.turno ? t.periodo : null, t.nome_do_posto || t.posto]
					.filter(Boolean).join(" · ")).join(" + ");
				tom = "on";
			} else if ((h.turnos || []).length) {
				txt = __("Folga");
			} else {
				txt = __("Sem escala");
			}
			const aus = h.ausencia ? ` <span class="hv-hoje-aus">${esc(h.ausencia.tipo || __("Ausência"))}</span>` : "";
			return `<span class="hv-meta hv-hoje ${tom} ${h.ausencia ? "aus" : ""}"><i>${__("Hoje")}</i><b>${esc(txt)}</b>${aus}</span>`;
		}

		// ─── header + KPIs (page mode) ────────────────────────────────────
		_topo() {
			const d = this.dossie, id = d.identificacao || {}, po = d.posto || {}, a = d.assiduidade || {},
				di = d.disciplinar || {}, s = d.salario;
			const ant = id.antiguidade;
			const antTxt = ant ? (ant.anos ? `${ant.anos}a ${ant.meses}m` : `${ant.meses} ${__("meses")}`) : "—";
			const prob = ant && ant.dias <= 92 ? `<span class="hv-chip hv-chip-amber">${__("Período experimental")}</span>` : "";
			const ini = (id.nome || "?").split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
			const ava = id.foto ? `<img src="${esc(id.foto)}" alt="">` : esc(ini);
			const ferias = (d.ferias || []).reduce((t, f) => t + (f.saldo || 0), 0);
			const delta = (a.mes_atual || 0) - (a.mes_anterior || 0);

			const chip = (lbl, val, mono) => val ? `<span class="hv-meta"><i>${lbl}</i><b class="${mono ? "hv-mono" : ""}">${esc(val)}</b></span>` : "";
			const kpi = (cat, lbl, val, sub, tom, sm) => `
				<div class="hv-kpi ${tom ? "hv-kpi-" + tom : ""} ${sm ? "hv-kpi-sm" : ""}">
					<div class="hv-kpi-top"><span class="hv-kpi-ic hv-c-${cat}">${ico(cat)}</span><span class="hv-kpi-l">${lbl}</span></div>
					<div class="hv-kpi-v">${val}</div>
					<div class="hv-kpi-s">${sub || "&nbsp;"}</div>
				</div>`;
			const pill = delta ? `<span class="hv-delta ${delta > 0 ? "up" : "down"}">${delta > 0 ? "+" : ""}${delta}</span>` : "";

			const kpis = [
				kpi("assiduidade", __("Faltas este mês"), `${a.mes_atual || 0}${pill}`, __("{0} no mês anterior", [a.mes_anterior || 0]),
					(a.mes_atual || 0) >= 3 ? "bad" : ""),
				kpi("assiduidade", __("Faltas 12 meses"), a.doze_meses || 0,
					[__("{0} justificada(s)", [a.justificadas_12m || 0]),
				 a.pendentes_12m ? __("{0} em aprovação", [a.pendentes_12m]) : "",
				 __("{0} por justificar", [Math.max((a.doze_meses || 0) - (a.justificadas_12m || 0) - (a.pendentes_12m || 0), 0)])]
					.filter(Boolean).join(" · ")),
				kpi("assiduidade", __("Saldo de férias"), `${Math.round(ferias * 10) / 10}<small> ${__("dias")}</small>`,
					(d.ferias || []).map((f) => esc(f.leave_type)).join(", ")),
				kpi("disciplinar", __("Participações 12m"), di.participacoes_12m || 0,
					__("{0} processo(s) · {1} repreensão(ões)", [(di.processos_anteriores || []).length, di.total_repreensoes || 0]),
					(di.participacoes_12m || 0) >= 3 ? "bad" : ""),
			];
			if (s) {
				kpis.push(kpi("salario", __("Salário base"), moeda(s.base),
					s.ssa ? __("desde {0}", [dt(s.ssa.from_date)]) : "", "", true));
				if (s.divida_total > 0) kpis.push(kpi("salario", __("Dívida restante"), moeda(s.divida_total),
					__("{0} empréstimo(s) · {1} dedução(ões)", [(s.emprestimos || []).length, (s.deducoes || []).length]),
					s.divida_total > 0 ? "amber" : "", true));
			}

			const alertas = (d.situacao || []).map((x) => `
				<div class="hv-alerta hv-alerta-${["abandono", "suspenso"].includes(x.tipo) ? "bad" : "amber"}">
					<b>${esc(x.texto)}</b>${x.detalhe ? `<span>${esc(x.detalhe)}</span>` : ""}
					${x.doc ? `<a href="${url(x.doctype, x.doc)}">${esc(x.doc)}</a>` : ""}
				</div>`).join("");

			this.$r.find('[data-hv="topo"]').html(`
				<div class="hv-head">
					<div class="hv-ava hv-st-${tomStatus(id.status)}">${ava}</div>
					<div class="hv-head-txt">
						<div class="hv-head-l1">
							<h1>${esc(id.nome || this.vig)}</h1>
							<span class="hv-status hv-st-${tomStatus(id.status)}">${esc(id.status || "")}</span>${prob}
						</div>
						<div class="hv-head-l2">
							<span class="hv-mono">${esc(this.vig)}</span>${id.mecanografico ? ` · <span class="hv-mono">${__("Nº")} ${esc(id.mecanografico)}</span>` : ""}
							${id.data_admissao ? ` · ${__("admitido a {0}", [dt(id.data_admissao)])} (${antTxt})` : ""}
						</div>
						<div class="hv-head-l3">
							${this._chipHoje()}
							${chip(po.anterior ? __("Posto (anterior)") : __("Posto"), po.nome_do_posto || po.posto)}
							${chip(__("Regime"), po.regime)}
							${chip(__("Categoria"), id.categoria)}
							${chip(__("Delegação"), id.delegacao)}
							${chip(__("Cliente"), po.cliente)}
							${chip(__("Contacto"), id.contacto, true)}
						</div>
					</div>
					<div class="hv-head-act">
						<a class="hv-btn" href="${url("Vigilante", this.vig)}">${__("Abrir Vigilante")}</a>
						<button class="hv-btn hv-btn-ghost" data-hv="print">${__("Imprimir")}</button>
					</div>
				</div>
				${alertas ? `<div class="hv-alertas">${alertas}</div>` : ""}
				<div class="hv-kpis">${kpis.join("")}</div>`);
			this.$r.find('[data-hv="print"]').on("click", () => {
				this.$r.addClass("hv-print-all");
				window.print();
				setTimeout(() => this.$r.removeClass("hv-print-all"), 500);
			});
		}

		// ─── toolbar ──────────────────────────────────────────────────────
		_toolbar() {
			const per = [["3m", __("3 meses")], ["12m", __("12 meses")], ["tudo", __("Tudo")], ["custom", __("Período…")]];
			const $t = this.$r.find('[data-hv="toolbar"]');
			$t.html(`
				<div class="hv-tb-row">
					<div class="hv-seg">${per.map(([k, l]) => `<button data-per="${k}" class="${k === this.st.periodo ? "on" : ""}">${l}</button>`).join("")}</div>
					<span class="hv-tb-periodo" data-hv="periodo"></span>
					<div class="hv-tb-r">
						<label class="hv-search">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>'}
							<input type="text" placeholder="${__("Procurar no histórico")}" data-hv="busca"></label>
						<label class="hv-toggle"><input type="checkbox" data-hv="canc"><span>${__("Cancelados")}</span></label>
					</div>
				</div>
				<div class="hv-chips" data-hv="chips"></div>`);
			$t.on("click", "[data-per]", (e) => {
				const k = $(e.currentTarget).attr("data-per");
				if (k === "custom") return this._periodo_custom();
				this.st.periodo = k;
				$t.find("[data-per]").removeClass("on");
				$(e.currentTarget).addClass("on");
				this._carregar();
			});
			let tmr;
			$t.on("input", '[data-hv="busca"]', (e) => {
				clearTimeout(tmr);
				tmr = setTimeout(() => { this.st.busca = (e.target.value || "").trim().toLowerCase(); this._feed(); }, 180);
			});
			$t.on("change", '[data-hv="canc"]', (e) => { this.st.cancelados = e.target.checked; this._carregar(); });
			$t.on("click", "[data-cat]", (e) => {
				this.st.cat = $(e.currentTarget).attr("data-cat");
				this._chips();
				this._feed();
			});
		}

		_periodo_custom() {
			const iv = this._intervalo();
			frappe.prompt([
				{ fieldname: "de", fieldtype: "Date", label: __("De"), reqd: 1, default: iv.de || frappe.datetime.add_months(frappe.datetime.get_today(), -12) },
				{ fieldname: "ate", fieldtype: "Date", label: __("Até"), reqd: 1, default: iv.ate || frappe.datetime.get_today() },
			], (v) => {
				this.st.periodo = "custom";
				this.st.de = v.de; this.st.ate = v.ate;
				this.$r.find("[data-per]").removeClass("on");
				this.$r.find('[data-per="custom"]').addClass("on");
				this._carregar();
			}, __("Escolher período"), __("Aplicar"));
		}

		_chips() {
			const d = this.dados;
			if (!d) return;
			const total = d.eventos.length;
			const iv = this._intervalo();
			this.$r.find('[data-hv="periodo"]').text(iv.de ? `${dt(iv.de)} – ${dt(iv.ate)}` : __("Desde a admissão"));
			const chip = (k, l, n) => `<button data-cat="${k}" class="hv-cat ${this.st.cat === k ? "on" : ""} ${!n && k !== "todos" ? "zero" : ""}">
				<span class="hv-cat-ic hv-c-${k}">${ico(k, "hv-ico-s")}</span>${esc(l)}<span class="hv-cat-n">${n}</span></button>`;
			this.$r.find('[data-hv="chips"]').html(chip("todos", __("Tudo"), total) + d.categorias.map((c) => chip(c.key, c.label, c.n)).join(""));
		}

		// ─── feed ─────────────────────────────────────────────────────────
		_filtrados() {
			const q = this.st.busca;
			return (this.dados.eventos || []).filter((e) => {
				if (this.st.cat !== "todos" && e.cat !== this.st.cat) return false;
				if (!q) return true;
				const alvo = [e.titulo, e.sub, e.detalhe, e.name, e.estado].concat((e.itens || []).map((i) => i.texto)).join(" ").toLowerCase();
				return alvo.includes(q);
			});
		}

		_feed() {
			const $f = this.$r.find('[data-hv="feed"]');
			if (!this.dados) return;
			const ev = this._filtrados();
			if (!ev.length) {
				$f.html(`<div class="hv-vazio">${ico(this.st.cat, "hv-ico-xl")}<b>${__("Nada a mostrar")}</b>
					<span>${this.st.busca ? __("Nenhum registo corresponde à pesquisa.") : __("Sem registos nesta categoria e período.")}</span></div>`);
				return;
			}
			const meses = [];
			ev.forEach((e) => {
				const k = e.data.slice(0, 7);
				if (!meses.length || meses[meses.length - 1].k !== k) meses.push({ k, ev: [] });
				meses[meses.length - 1].ev.push(e);
			});
			$f.html(meses.map((m) => {
				const [a, mm] = m.k.split("-");
				return `<section class="hv-mes">
					<header class="hv-mes-h"><span>${MESES[+mm - 1]} <b>${a}</b></span><i>${m.ev.length} ${m.ev.length === 1 ? __("registo") : __("registos")}</i></header>
					<ol class="hv-tl">${m.ev.map((e, i) => this._evento(e, `${m.k}-${i}`)).join("")}</ol>
				</section>`;
			}).join(""));
			$f.off("click.hv").on("click.hv", "[data-abrir]", (e) => {
				const k = $(e.currentTarget).attr("data-abrir");
				this.abertos.has(k) ? this.abertos.delete(k) : this.abertos.add(k);
				$(e.currentTarget).closest(".hv-ev").toggleClass("aberto", this.abertos.has(k));
			});
			$f.on("click.hv", ".hv-ev-det", (e) => $(e.currentTarget).toggleClass("solto"));
		}

		_evento(e, key) {
			const d = frappe.datetime.str_to_obj(e.data);
			const k = `${e.doctype || e.tipo}|${e.name || e.data}|${e.titulo}`;
			const aberto = this.abertos.has(k);
			const titulo = e.doctype && e.name
				? `<a class="hv-ev-t" href="${url(e.doctype, e.name)}">${esc(e.titulo)}</a>` : `<span class="hv-ev-t">${esc(e.titulo)}</span>`;
			const estado = e.estado ? `<span class="hv-pill hv-pill-${e.tom || "info"}">${esc(e.estado)}</span>` : "";
			const valor = e.valor != null && e.cat === "salario"
				? `<span class="hv-valor ${e.valor < 0 ? "neg" : ""}">${moeda(e.valor)}</span>`
				: (e.valor != null && e.tipo === "faltas" ? `<span class="hv-valor hv-valor-f ${e.tom ? "hv-t-" + e.tom : ""}">${e.valor}<small>${__("faltas")}</small></span>` : "");
			const itens = (e.itens || []);
			const temDoc = !!(e.doctype && e.name);
			return `<li class="hv-ev ${e.cancelado ? "canc" : ""} ${e.rascunho ? "rasc" : ""} ${aberto ? "aberto" : ""} ${e.tom ? "hv-t-" + e.tom : ""}">
				<div class="hv-ev-dia"><b>${d.getDate()}</b><span>${DIAS[d.getDay()]}</span></div>
				<div class="hv-ev-no hv-c-${e.cat}">${ico(e.cat, "hv-ico-s")}</div>
				<div class="hv-ev-card">
					<div class="hv-ev-l1">${titulo}${estado}${valor}</div>
					${e.sub ? `<div class="hv-ev-sub">${esc(e.sub)}</div>` : ""}
					${e.detalhe ? `<div class="hv-ev-det" title="${__("Clique para expandir")}">${esc(e.detalhe)}</div>` : ""}
					${(e.resumo || []).length ? `<div class="hv-resumo">${e.resumo.map((r) =>
						`<span class="hv-res hv-res-${r.tom}"><b>${r.n}</b> ${esc(r.label)}</span>`).join("")}</div>` : ""}
					${itens.length ? `<ul class="hv-itens">${itens.map(itemHtml).join("")}</ul>` : ""}
					<div class="hv-ev-foot">
						${temDoc ? `<a class="hv-mono hv-ev-ref" href="${url(e.doctype, e.name)}" target="_blank" rel="noopener" title="${__("Abrir num novo separador")}">${esc(e.name)} &#8599;</a>` : ""}
						${itens.length ? `<button class="hv-mais" data-abrir="${esc(k)}"><span class="a">${__("Ver {0} registo(s)", [itens.length])}</span><span class="f">${__("Fechar")}</span></button>` : ""}
						${temDoc ? `<a class="hv-mais hv-mais-doc" href="${url(e.doctype, e.name)}" target="_blank" rel="noopener">${__("Ver detalhe")} &#8599;</a>` : ""}
					</div>
				</div>
			</li>`;
		}

		// ─── side summary (page mode) ─────────────────────────────────────
		_side() {
			const $s = this.$r.find('[data-hv="side"]');
			const d = this.dossie;
			if (!$s.length) return;
			const blocos = [];

			// faltas per month (last 12, from the feed's monthly groups)
			const porMes = {};
			(this.dados ? this.dados.eventos : []).filter((e) => e.tipo === "faltas").forEach((e) => { porMes[e.data.slice(0, 7)] = e.valor || 0; });
			const hoje = frappe.datetime.str_to_obj(frappe.datetime.get_today());
			const barras = [];
			for (let i = 11; i >= 0; i--) {
				const x = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
				const k = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`;
				barras.push({ l: MES_CURTO[x.getMonth()], v: porMes[k] || 0 });
			}
			const max = Math.max(3, ...barras.map((b) => b.v));
			blocos.push(`<div class="hv-card">
				<h3>${ico("assiduidade", "hv-ico-s")} ${__("Faltas por mês")}</h3>
				<div class="hv-bars">${barras.map((b) => `<div class="hv-bar" title="${b.l}: ${b.v}">
					<span class="hv-bar-v">${b.v || ""}</span>
					<i style="height:${Math.round((b.v / max) * 100)}%" class="${b.v >= 3 ? "bad" : b.v ? "amb" : ""}"></i>
					<span class="hv-bar-l">${b.l}</span></div>`).join("")}</div>
				${this.st.periodo === "3m" ? `<div class="hv-nota">${__("Período de 3 meses: meses anteriores não carregados.")}</div>` : ""}
			</div>`);

			if (d) {
				const di = d.disciplinar || {}, g = di.por_gravidade || {};
				const tg = (g["Baixa"] || 0) + (g["Média"] || 0) + (g["Alta"] || 0);
				const gb = (lbl, n, cls) => `<div class="hv-gb"><span>${lbl}</span><div><i class="${cls}" style="width:${tg ? Math.round(n / tg * 100) : 0}%"></i></div><b>${n}</b></div>`;
				const lim = di.limite_repreensoes || 3, rep = di.repreensoes_desde_processo || 0;
				blocos.push(`<div class="hv-card">
					<h3>${ico("disciplinar", "hv-ico-s")} ${__("Disciplinar")}</h3>
					<div class="hv-mini3">
						<div><b>${di.total_participacoes || 0}</b><span>${__("participações")}</span></div>
						<div><b>${di.total_repreensoes || 0}</b><span>${__("repreensões")}</span></div>
						<div><b>${(di.processos_anteriores || []).length}</b><span>${__("processos")}</span></div>
					</div>
					${tg ? gb(__("Alta"), g["Alta"] || 0, "bad") + gb(__("Média"), g["Média"] || 0, "amb") + gb(__("Baixa"), g["Baixa"] || 0, "low") : ""}
					<div class="hv-gauge"><span>${__("Repreensões desde o último processo")}</span>
						<div class="hv-gauge-t"><i class="${rep >= lim ? "bad" : rep ? "amb" : ""}" style="width:${Math.min(100, rep / lim * 100)}%"></i></div>
						<b>${rep} / ${lim}</b></div>
					${(di.reincidencias || []).length ? `<div class="hv-sub">${__("Reincidências")}</div><ul class="hv-list">${di.reincidencias.slice(0, 5).map((r) =>
						`<li><span>${esc(r.tipo)}</span><b>${r.vezes}×</b></li>`).join("")}</ul>` : ""}
				</div>`);

				if ((d.ferias || []).length) {
					blocos.push(`<div class="hv-card"><h3>${ico("assiduidade", "hv-ico-s")} ${__("Férias e licenças")}</h3>
						<ul class="hv-list">${d.ferias.map((f) => `<li><span>${esc(f.leave_type)}</span><b>${Math.round((f.saldo || 0) * 10) / 10} ${__("dias")}</b></li>`).join("")}</ul></div>`);
				}
				const s = d.salario;
				if (s) {
					blocos.push(`<div class="hv-card"><h3>${ico("salario", "hv-ico-s")} ${__("Salário")}</h3>
						<ul class="hv-list">
							<li><span>${__("Base")}</span><b>${moeda(s.base)}</b></li>
							${(s.folhas || []).map((f) => `<li><a href="${url("Salary Slip", f.name)}">${__("Líquido")} ${MES_CURTO[frappe.datetime.str_to_obj(f.start_date).getMonth()]}</a><b>${moeda(f.net_pay)}</b></li>`).join("")}
							${s.divida_total ? `<li><span>${__("Dívida restante")}</span><b class="hv-t-amber">${moeda(s.divida_total)}</b></li>` : ""}
						</ul></div>`);
				}
			}
			$s.html(blocos.join(""));
		}
	}

	// One line of an event's "Ver N registo(s)" list, as a small card. Links open in a new tab.
	function itemHtml(i) {
		const d = frappe.datetime.str_to_obj(i.data);
		const ln = (dtp, dn, lbl) => `<a class="hv-it-ln" href="${url(dtp, dn)}" target="_blank" rel="noopener">${esc(lbl || dn)} &#8599;</a>`;
		const links = [i.doctype && i.name ? ln(i.doctype, i.name) : "", ...(i.links || []).map((l) => ln(l.doctype, l.name, l.label))]
			.filter(Boolean).join("");
		return `<li class="hv-it ${i.tom ? "hv-t-" + i.tom : ""} ${i.estado_tom ? "hv-it-" + i.estado_tom : ""}">
			<div class="hv-it-dia"><b>${d.getDate()}</b><span>${DIAS[d.getDay()]}</span></div>
			<div class="hv-it-c">
				<div class="hv-it-l1"><span class="hv-it-t">${esc(i.titulo || i.texto || "")}</span>
					${i.valor != null ? `<span class="hv-it-n">${i.valor} ${__("falta(s)")}</span>` : ""}
					${i.estado ? `<span class="hv-pill hv-pill-${i.estado_tom || "neutral"}">${esc(i.estado)}</span>` : ""}</div>
				${(i.meta || []).length ? `<div class="hv-it-meta">${i.meta.map((m) => `<span>${esc(m)}</span>`).join("")}</div>` : ""}
				${i.nota ? `<div class="hv-it-nota">${esc(i.nota)}</div>` : ""}
			</div>
			<div class="hv-it-ls">${links}</div>
		</li>`;
	}

	function tomStatus(s) {
		return { "Activo": "good", "Reserva": "info", "Demitido": "bad", "Abandono de Posto": "bad",
			"Suspenso Preventivamente": "amber", "Doente": "amber", "Inactivo": "neutral" }[s] || "neutral";
	}

	function css() {
		if (document.getElementById("hv-css")) return;
		if (!document.getElementById("hv-fonts")) {
			const l = document.createElement("link");
			l.id = "hv-fonts"; l.rel = "stylesheet";
			l.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";
			document.head.appendChild(l);
		}
		const c = `
/* Historico do Vigilante - Operations Daylight. ASCII-only. */
.hv-root { --paper:#F4F6FA; --card:#FFFFFF; --paper3:#EEF1F6; --ink:#0E1726; --ink2:#5B6B82; --ink3:#93A1B5;
  --line:#E6EAF2; --line2:#D5DCE8; --accent:#4F46E5; --accentInk:#4338CA; --wash:rgba(79,70,229,.08);
  --good:#16A34A; --bad:#E5484D; --amber:#F59E0B; --info:#2F6FED; --graphite:#64748B;
  --shadow:0 1px 2px rgba(16,23,38,.04),0 14px 34px -20px rgba(16,23,38,.22);
  font-family:Inter,system-ui,sans-serif; color:var(--ink); font-size:13px; }
.hv-pagina { background:var(--paper); padding:22px 26px 60px; border-radius:18px; }
.hv-root a { color:inherit; }
.hv-mono { font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:12px; }
.hv-ico { width:18px; height:18px; } .hv-ico-s { width:14px; height:14px; } .hv-ico-xl { width:34px; height:34px; color:var(--ink3); }
.hv-c-operacoes { --c:#4F46E5; } .hv-c-assiduidade { --c:#0284C7; } .hv-c-disciplinar { --c:#9333EA; }
.hv-c-carreira { --c:#0D9488; } .hv-c-salario { --c:#475569; } .hv-c-material { --c:#A16207; } .hv-c-todos { --c:#0E1726; }

.hv-skel { background:linear-gradient(90deg,#EEF1F6 0%,#F7F8FB 50%,#EEF1F6 100%); background-size:200% 100%;
  animation:hvsk 1.2s infinite linear; border-radius:16px; margin-bottom:14px; }
.hv-skel-head { height:118px; } .hv-skel-kpis { height:96px; } .hv-skel-feed { height:340px; }
@keyframes hvsk { from { background-position:200% 0; } to { background-position:-200% 0; } }

.hv-head { display:flex; gap:18px; align-items:flex-start; background:var(--card); border:1px solid var(--line);
  border-radius:18px; padding:20px 22px; box-shadow:var(--shadow); }
.hv-ava { width:68px; height:68px; flex:none; border-radius:20px; display:flex; align-items:center; justify-content:center;
  font-family:"Space Grotesk",sans-serif; font-weight:700; font-size:24px; color:var(--accentInk); background:var(--wash);
  overflow:hidden; box-shadow:0 0 0 3px var(--card),0 0 0 5px var(--ring,var(--line2)); }
.hv-ava img { width:100%; height:100%; object-fit:cover; }
.hv-ava.hv-st-good { --ring:var(--good); } .hv-ava.hv-st-bad { --ring:var(--bad); } .hv-ava.hv-st-amber { --ring:var(--amber); }
.hv-ava.hv-st-info { --ring:var(--info); }
.hv-head-txt { flex:1; min-width:0; }
.hv-head-l1 { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.hv-head-l1 h1 { font-family:"Space Grotesk",sans-serif; font-size:24px; font-weight:700; letter-spacing:-.01em; margin:0; color:var(--ink); }
.hv-head-l2 { color:var(--ink2); margin:4px 0 12px; font-size:12.5px; }
.hv-head-l3 { display:flex; flex-wrap:wrap; gap:8px; }
.hv-meta { display:inline-flex; gap:6px; align-items:baseline; background:var(--paper3); border-radius:9px; padding:5px 10px; }
.hv-meta i { font-style:normal; color:var(--ink3); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
.hv-meta b { font-weight:600; color:var(--ink); }
.hv-hoje { background:var(--wash); box-shadow:inset 0 0 0 1px var(--accentLine, rgba(79,70,229,.25)); }
.hv-hoje i { color:var(--accentInk); }
.hv-hoje.aus { background:rgba(220,38,38,.08); box-shadow:inset 0 0 0 1px rgba(220,38,38,.25); }
.hv-hoje-aus { font-size:11px; font-weight:600; color:#B91C1C; background:rgba(220,38,38,.12); border-radius:99px; padding:1px 8px; }
.hv-status, .hv-chip { font-size:11.5px; font-weight:600; padding:3px 10px; border-radius:99px; background:var(--paper3); color:var(--graphite); }
.hv-status.hv-st-good { background:rgba(22,163,74,.12); color:#15803D; } .hv-status.hv-st-bad { background:rgba(229,72,77,.12); color:#C93338; }
.hv-status.hv-st-amber, .hv-chip-amber { background:rgba(245,158,11,.15); color:#B45309; }
.hv-status.hv-st-info { background:rgba(47,111,237,.12); color:#2559C9; }
.hv-head-act { display:flex; flex-direction:column; gap:8px; }
.hv-btn { display:inline-flex; justify-content:center; align-items:center; border:1px solid var(--accent); background:var(--accent);
  color:#fff !important; border-radius:10px; padding:7px 14px; font-weight:600; font-size:12.5px; cursor:pointer; text-decoration:none !important; white-space:nowrap; }
.hv-btn:hover { background:var(--accentInk); }
.hv-btn-ghost { background:var(--card); color:var(--accentInk) !important; border-color:var(--line2); }
.hv-btn-ghost:hover { background:var(--wash); }

.hv-alertas { display:flex; flex-direction:column; gap:8px; margin-top:12px; }
.hv-alerta { display:flex; gap:12px; align-items:center; flex-wrap:wrap; background:var(--card); border:1px solid var(--line);
  border-left:4px solid var(--amber); border-radius:12px; padding:10px 14px; }
.hv-alerta-bad { border-left-color:var(--bad); }
.hv-alerta span { color:var(--ink2); } .hv-alerta a { margin-left:auto; color:var(--accentInk); font-weight:600; }

.hv-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(168px,1fr)); gap:12px; margin:14px 0 18px; }
.hv-kpi { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:14px 16px; box-shadow:var(--shadow); }
.hv-kpi-top { display:flex; align-items:center; gap:8px; }
.hv-kpi-ic { width:26px; height:26px; border-radius:8px; display:flex; align-items:center; justify-content:center;
  color:var(--c); background:color-mix(in srgb,var(--c) 12%,transparent); }
.hv-kpi-l { color:var(--ink2); font-size:12px; font-weight:500; }
.hv-kpi-v { font-family:"Space Grotesk",sans-serif; font-size:26px; font-weight:700; margin:8px 0 2px; display:flex; align-items:center; gap:8px; }
.hv-kpi-sm .hv-kpi-v { font-size:19px; white-space:nowrap; min-height:31px; }
.hv-kpi-v small { font-size:13px; color:var(--ink2); font-weight:500; }
.hv-kpi-s { color:var(--ink3); font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hv-kpi-bad .hv-kpi-v { color:var(--bad); } .hv-kpi-amber .hv-kpi-v { color:#B45309; }
.hv-delta { font-family:Inter,sans-serif; font-size:11px; font-weight:700; border-radius:99px; padding:2px 7px; }
.hv-delta.up { background:rgba(229,72,77,.12); color:#C93338; } .hv-delta.down { background:rgba(22,163,74,.12); color:#15803D; }

.hv-grid { display:grid; grid-template-columns:minmax(0,1fr) 310px; gap:18px; align-items:start; }
.hv-grid-1 { grid-template-columns:minmax(0,1fr); }
@media (max-width:1100px) { .hv-grid { grid-template-columns:minmax(0,1fr); } }

.hv-toolbar { position:sticky; top:52px; z-index:3; background:var(--card); border:1px solid var(--line); border-radius:16px;
  padding:12px 14px; box-shadow:var(--shadow); margin-bottom:14px; }
.hv-embutido .hv-toolbar { position:static; box-shadow:none; }
.hv-tb-row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.hv-seg { display:inline-flex; background:var(--paper3); border-radius:10px; padding:3px; }
.hv-seg button { border:0; background:transparent; color:var(--ink2); font-weight:600; font-size:12px; padding:5px 12px; border-radius:8px; cursor:pointer; }
.hv-seg button.on { background:var(--card); color:var(--accentInk); box-shadow:0 1px 3px rgba(16,23,38,.12); }
.hv-tb-periodo { color:var(--ink3); font-size:12px; }
.hv-tb-r { margin-left:auto; display:flex; gap:10px; align-items:center; }
.hv-search { display:flex; align-items:center; gap:6px; background:var(--paper3); border-radius:10px; padding:0 10px; margin:0; }
.hv-search svg { width:14px; height:14px; color:var(--ink3); }
.hv-search input { border:0; background:transparent; outline:none; height:30px; width:190px; font-size:12.5px; color:var(--ink); }
.hv-toggle { display:inline-flex; gap:6px; align-items:center; color:var(--ink2); font-size:12px; margin:0; cursor:pointer; }
.hv-toggle input { margin:0; }
.hv-chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
.hv-cat { display:inline-flex; align-items:center; gap:7px; border:1px solid var(--line); background:var(--card); color:var(--ink);
  border-radius:99px; padding:4px 10px 4px 5px; font-size:12px; font-weight:600; cursor:pointer; }
.hv-cat:hover { border-color:var(--line2); background:#FAFBFD; }
.hv-cat.on { border-color:var(--accent); background:var(--wash); color:var(--accentInk); }
.hv-cat.zero { opacity:.5; }
.hv-cat-ic { width:20px; height:20px; border-radius:99px; display:flex; align-items:center; justify-content:center;
  color:var(--c); background:color-mix(in srgb,var(--c) 12%,transparent); }
.hv-cat-n { font-family:"IBM Plex Mono",monospace; font-size:11px; color:var(--ink3); font-weight:500; }

.hv-mes { margin-bottom:6px; }
.hv-mes-h { display:flex; align-items:baseline; gap:10px; padding:10px 4px 8px; }
.hv-mes-h span { font-family:"Space Grotesk",sans-serif; font-weight:600; font-size:15px; background:var(--paper);
  padding:2px 10px 2px 0; }
.hv-embutido .hv-mes-h span { background:transparent; }
.hv-mes-h b { color:var(--ink3); font-weight:600; }
.hv-mes-h i { font-style:normal; color:var(--ink3); font-size:11.5px; }
.hv-tl { list-style:none; margin:0; padding:0; position:relative; }
.hv-tl:before { content:""; position:absolute; left:61px; top:0; bottom:0; width:2px; background:var(--line); }
.hv-ev { display:grid; grid-template-columns:44px 36px minmax(0,1fr); gap:0 8px; align-items:start; padding:0 0 10px; position:relative; }
.hv-ev-dia { text-align:right; padding-top:9px; }
.hv-ev-dia b { display:block; font-family:"Space Grotesk",sans-serif; font-size:18px; line-height:1; }
.hv-ev-dia span { color:var(--ink3); font-size:11px; }
.hv-ev-no { width:28px; height:28px; margin:6px auto 0; border-radius:99px; display:flex; align-items:center; justify-content:center;
  color:var(--c); background:var(--card); box-shadow:0 0 0 2px color-mix(in srgb,var(--c) 35%,transparent),0 0 0 5px var(--paper); position:relative; z-index:1; }
.hv-embutido .hv-ev-no { box-shadow:0 0 0 2px color-mix(in srgb,var(--c) 35%,transparent),0 0 0 5px #fff; }
.hv-ev-card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:10px 14px; transition:border-color .15s,box-shadow .15s; }
.hv-ev-card:hover { border-color:var(--line2); box-shadow:var(--shadow); }
.hv-ev.hv-t-bad .hv-ev-card { border-left:3px solid var(--bad); }
.hv-ev.hv-t-amber .hv-ev-card { border-left:3px solid var(--amber); }
.hv-ev.hv-t-good .hv-ev-card { border-left:3px solid var(--good); }
.hv-ev-l1 { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.hv-ev-t { font-weight:600; font-size:13.5px; color:var(--ink) !important; text-decoration:none !important; }
a.hv-ev-t:hover { color:var(--accentInk) !important; }
.hv-ev-sub { color:var(--ink2); margin-top:2px; font-size:12.5px; }
.hv-ev-det { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; cursor:pointer; margin-top:8px; padding:8px 10px; background:var(--paper3); border-radius:10px; color:var(--ink2); white-space:pre-wrap; font-size:12.5px; }
.hv-itens { display:none; list-style:none; margin:10px 0 0; padding:0; }
.hv-ev-det.solto, .hv-print-all .hv-ev-det { display:block; }
.hv-ev.aberto .hv-itens, .hv-print-all .hv-itens { display:block; }
.hv-it { display:flex; gap:12px; align-items:flex-start; padding:9px 12px; margin-top:6px; background:var(--card); border:1px solid var(--line); border-left:3px solid var(--line2); border-radius:10px; }
.hv-it.hv-it-good { border-left-color:var(--good); } .hv-it.hv-it-amber { border-left-color:var(--amber); } .hv-it.hv-it-bad { border-left-color:var(--bad); }
.hv-it-dia { width:34px; text-align:center; line-height:1.1; flex:none; }
.hv-it-dia b { display:block; font-family:"Space Grotesk",sans-serif; font-size:16px; color:var(--ink); }
.hv-it-dia span { font-size:10.5px; color:var(--ink3); text-transform:uppercase; }
.hv-it-c { flex:1; min-width:0; }
.hv-it-l1 { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.hv-it-t { font-weight:600; color:var(--ink); font-size:13px; }
.hv-it.hv-t-bad .hv-it-t { color:#C93338; }
.hv-it-n { font-family:"IBM Plex Mono",monospace; font-size:12px; color:var(--ink2); }
.hv-it-meta { display:flex; flex-wrap:wrap; gap:6px; margin-top:4px; }
.hv-it-meta span { font-size:11.5px; color:var(--ink2); background:var(--paper3); border-radius:6px; padding:1px 7px; }
.hv-it-nota { margin-top:4px; font-size:12px; color:var(--ink3); font-style:italic; }
.hv-it-ls { display:flex; flex-direction:column; align-items:flex-end; gap:3px; flex:none; }
.hv-it-ln { font-family:"IBM Plex Mono",monospace; font-size:11px; color:var(--accentInk) !important; text-decoration:none !important; }
.hv-it-ln:hover { text-decoration:underline !important; }
.hv-resumo { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.hv-res { font-size:12px; padding:3px 10px; border-radius:99px; background:var(--paper3); color:var(--ink2); }
.hv-res b { font-family:"Space Grotesk",sans-serif; font-size:13px; margin-right:2px; }
.hv-res-good { background:rgba(22,163,74,.12); color:#15803D; } .hv-res-amber { background:rgba(245,158,11,.15); color:#B45309; } .hv-res-bad { background:rgba(229,72,77,.12); color:#C93338; }
.hv-ev-foot { display:flex; align-items:center; gap:10px; margin-top:6px; }
.hv-ev-foot:empty { display:none; }
.hv-ev-ref { color:var(--ink3) !important; font-size:11px; text-decoration:none !important; border-radius:6px; padding:1px 4px; margin-left:-4px; }
.hv-ev-ref:hover { color:var(--accentInk) !important; background:var(--wash); }
.hv-mais { margin-left:auto; border:0; background:transparent; color:var(--accentInk); font-weight:600; font-size:12px; cursor:pointer; padding:0; }
.hv-mais-doc { text-decoration:none !important; color:var(--accentInk) !important; }
.hv-mais-doc + .hv-mais-doc, .hv-mais + .hv-mais-doc { margin-left:12px; }
.hv-mais .f { display:none; } .hv-ev.aberto .hv-mais .a { display:none; } .hv-ev.aberto .hv-mais .f { display:inline; }
.hv-ev.canc .hv-ev-card { opacity:.55; } .hv-ev.canc .hv-ev-t { text-decoration:line-through !important; }
.hv-ev.rasc .hv-ev-card { border-style:dashed; }
.hv-pill { font-size:11px; font-weight:600; padding:2px 8px; border-radius:99px; background:rgba(47,111,237,.1); color:#2559C9; }
.hv-pill-amber { background:rgba(245,158,11,.15); color:#B45309; } .hv-pill-bad { background:rgba(229,72,77,.12); color:#C93338; }
.hv-pill-good { background:rgba(22,163,74,.12); color:#15803D; } .hv-pill-neutral { background:var(--paper3); color:var(--graphite); }
.hv-valor { margin-left:auto; font-family:"Space Grotesk",sans-serif; font-weight:600; font-size:14px; }
.hv-valor.neg { color:#C93338; }
.hv-valor-f small { font-family:Inter,sans-serif; font-size:11px; color:var(--ink3); margin-left:3px; font-weight:500; }
.hv-t-bad { color:#C93338; } .hv-t-amber { color:#B45309; }
.hv-ev .hv-ev-card .hv-t-bad, .hv-ev .hv-ev-card .hv-t-amber { font-weight:600; }
.hv-vazio { display:flex; flex-direction:column; align-items:center; gap:6px; padding:48px 20px; color:var(--ink2);
  background:var(--card); border:1px dashed var(--line2); border-radius:16px; text-align:center; }
.hv-vazio b { color:var(--ink); font-size:14px; }

.hv-side { position:sticky; top:52px; display:flex; flex-direction:column; gap:12px; }
.hv-card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:14px 16px; box-shadow:var(--shadow); }
.hv-card h3 { display:flex; align-items:center; gap:7px; font-family:"Space Grotesk",sans-serif; font-size:14px; font-weight:600; margin:0 0 12px; color:var(--ink); }
.hv-bars { display:flex; align-items:flex-end; gap:5px; height:110px; }
.hv-bar { flex:1; height:100%; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; gap:3px; }
.hv-bar i { display:block; width:100%; min-height:3px; border-radius:5px 5px 2px 2px; background:var(--paper3); }
.hv-bar i.amb { background:var(--amber); } .hv-bar i.bad { background:var(--bad); }
.hv-bar-v { font-size:10px; color:var(--ink2); font-weight:600; min-height:12px; }
.hv-bar-l { font-size:9.5px; color:var(--ink3); }
.hv-nota { color:var(--ink3); font-size:11px; margin-top:8px; }
.hv-mini3 { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin-bottom:12px; }
.hv-mini3 div { background:var(--paper3); border-radius:10px; padding:8px; text-align:center; }
.hv-mini3 b { display:block; font-family:"Space Grotesk",sans-serif; font-size:20px; }
.hv-mini3 span { color:var(--ink2); font-size:11px; }
.hv-gb { display:grid; grid-template-columns:44px 1fr 22px; gap:8px; align-items:center; margin:5px 0; font-size:12px; color:var(--ink2); }
.hv-gb div { height:7px; background:var(--paper3); border-radius:99px; overflow:hidden; }
.hv-gb i { display:block; height:100%; border-radius:99px; background:var(--graphite); }
.hv-gb i.bad { background:var(--bad); } .hv-gb i.amb { background:var(--amber); } .hv-gb i.low { background:#94A3B8; }
.hv-gb b { text-align:right; color:var(--ink); }
.hv-gauge { margin-top:12px; font-size:11.5px; color:var(--ink2); display:grid; grid-template-columns:1fr auto; gap:5px 10px; align-items:center; }
.hv-gauge span { grid-column:1 / -1; }
.hv-gauge-t { height:8px; background:var(--paper3); border-radius:99px; overflow:hidden; }
.hv-gauge-t i { display:block; height:100%; background:var(--accent); border-radius:99px; }
.hv-gauge-t i.amb { background:var(--amber); } .hv-gauge-t i.bad { background:var(--bad); }
.hv-gauge b { color:var(--ink); font-family:"IBM Plex Mono",monospace; }
.hv-sub { color:var(--ink3); text-transform:uppercase; font-size:10.5px; letter-spacing:.05em; margin:14px 0 4px; font-weight:600; }
.hv-list { list-style:none; margin:0; padding:0; }
.hv-list li { display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-bottom:1px solid var(--line); font-size:12.5px; }
.hv-list li:last-child { border-bottom:0; }
.hv-list li span, .hv-list li a { color:var(--ink2); } .hv-list li a:hover { color:var(--accentInk); }
.hv-list li b { font-weight:600; }

@media print {
  .navbar, .page-head, .hv-toolbar, .hv-head-act, .hv-mais, .layout-side-section, .page-actions { display:none !important; }
  .hv-pagina { padding:0; background:#fff; }
  .hv-grid { grid-template-columns:minmax(0,1fr) 260px; }
  .hv-side { position:static; }
  .hv-kpi, .hv-card, .hv-head, .hv-ev-card { box-shadow:none; }
  .hv-ev { break-inside:avoid; }
}
`;
		$(`<style id="hv-css">${c}</style>`).appendTo("head");
	}
})();
