// SIGOS - Saúde SIGOS. Everything that needs attention, by area, with fixes one row
// at a time or in bulk. Checks + permissions live server-side (sigos/saude): the page
// only shows what the user's roles allow. "Operations Daylight" design system.
frappe.provide("sigos");

frappe.pages["saude-sigos"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Saúde SIGOS"),
		single_column: true,
	});
	wrapper.saude_sigos = new sigos.SaudeSigos(page, wrapper);
};
frappe.pages["saude-sigos"].on_page_show = function (wrapper) {
	if (wrapper.saude_sigos) wrapper.saude_sigos.refresh();
};

const SG_API = "sigos.saude.";
const SG_NIVEIS = {
	critico: { label: "Crítico", peso: 3 },
	aviso:   { label: "Aviso", peso: 2 },
	info:    { label: "Informação", peso: 1 },
};
const SG_PAGINA = 100;

sigos.SaudeSigos = class SaudeSigos {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.dados = null;
		this.grupo = "resumo";
		this.delegacao = "";
		this.abertos = new Set();
		this.linhas = {};      // chave -> rows
		this.sel = {};         // chave -> Set(name)
		this.verIgnorados = {};
		this.busca = {};
		this.limite = {};
		this.carregados = false;

		this._inject_fonts();
		this._inject_css();
		this._build_shell();
		this._wire();
		frappe.realtime.on("sigos_saude_lote", (r) => this._fim_lote(r));
	}

	refresh() {
		this._load(false);
	}

	// ───────────────────────────────────────────────────────── shell
	_build_shell() {
		this.page.main.addClass("sigos-sg");
		this.$body = $(`
			<div class="sg-root">
				<div class="sg-mast">
					<div class="sg-mast-l">
						<div class="sg-mark">${_sg_icon_pulse()}</div>
						<div>
							<div class="sg-up">${__("SIGOS")}</div>
							<h1 class="sg-h1">${__("Saúde SIGOS")}</h1>
						</div>
					</div>
					<div class="sg-mast-r">
						<select class="sg-select" data-delegacao><option value="">${__("Todas as delegações")}</option></select>
						<span class="sg-when" data-when></span>
						<button type="button" class="sg-btn sg-btn-ghost" data-actualizar>${__("Actualizar")}</button>
					</div>
				</div>
				<div class="sg-kpis" data-kpis></div>
				<div class="sg-layout">
					<nav class="sg-side" data-side></nav>
					<main class="sg-main" data-main><div class="sg-msg">${__("A carregar…")}</div></main>
				</div>
			</div>
		`).appendTo(this.page.main);
		this.$kpis = this.$body.find("[data-kpis]");
		this.$side = this.$body.find("[data-side]");
		this.$main = this.$body.find("[data-main]");
	}

	_wire() {
		this.$body.find("[data-actualizar]").on("click", () => this._load(true));
		this.$body.find("[data-delegacao]").on("change", (e) => {
			this.delegacao = e.target.value;
			this.linhas = {};
			this.sel = {};
			this._load(false);
		});
		this.$side.on("click", "[data-grupo]", (e) => {
			this.grupo = $(e.currentTarget).attr("data-grupo");
			this._render();
		});
		this.$kpis.on("click", "[data-nivel]", () => {
			this.grupo = "resumo";
			this._render();
		});

		const $m = this.$main;
		$m.on("click", "[data-toggle]", (e) => {
			if ($(e.target).closest("button, a, input").length) return;
			const c = $(e.currentTarget).attr("data-toggle");
			if (this.abertos.has(c)) this.abertos.delete(c);
			else { this.abertos.add(c); this._carregar_linhas(c); }
			this._render_main();
		});
		$m.on("change", "[data-sel-all]", (e) => {
			const c = $(e.currentTarget).attr("data-sel-all");
			const s = this._sel(c);
			if (e.target.checked) this._filtradas(c).forEach((r) => s.add(r.name));
			else s.clear();
			this._render_card(c);
		});
		$m.on("change", "[data-sel]", (e) => {
			const $el = $(e.currentTarget);
			const c = $el.attr("data-chave"), n = $el.attr("data-sel");
			const s = this._sel(c);
			if (e.target.checked) s.add(n); else s.delete(n);
			this._render_card(c);
		});
		$m.on("click", "[data-fix]", (e) => {
			const $b = $(e.currentTarget);
			const c = $b.attr("data-chave");
			const nome = $b.attr("data-nome");
			this._corrigir(c, $b.attr("data-fix"), nome ? [nome] : Array.from(this._sel(c)));
		});
		$m.on("click", "[data-ignorar]", (e) => {
			const $b = $(e.currentTarget);
			const c = $b.attr("data-chave");
			const nome = $b.attr("data-nome");
			this._ignorar(c, nome ? [nome] : Array.from(this._sel(c)));
		});
		$m.on("click", "[data-restaurar]", (e) => {
			const $b = $(e.currentTarget);
			this._restaurar($b.attr("data-chave"), [$b.attr("data-restaurar")]);
		});
		$m.on("click", "[data-ver-ignorados]", (e) => {
			const c = $(e.currentTarget).attr("data-ver-ignorados");
			this.verIgnorados[c] = !this.verIgnorados[c];
			this.sel[c] = new Set();
			this._carregar_linhas(c, true);
		});
		$m.on("click", "[data-mais]", (e) => {
			const c = $(e.currentTarget).attr("data-mais");
			this.limite[c] = (this.limite[c] || SG_PAGINA) + SG_PAGINA;
			this._render_card(c);
		});
		let deb;
		$m.on("input", "[data-busca]", (e) => {
			const c = $(e.currentTarget).attr("data-busca");
			const v = e.target.value;
			clearTimeout(deb);
			deb = setTimeout(() => {
				this.busca[c] = v.trim().toLowerCase();
				this._render_card(c, true);
			}, 200);
		});
	}

	// ───────────────────────────────────────────────────────── data
	_load(actualizar) {
		this.$body.find("[data-actualizar]").prop("disabled", true);
		const fim = () => this.$body.find("[data-actualizar]").prop("disabled", false);
		frappe.call({
			method: SG_API + "resumo",
			args: { delegacao: this.delegacao || null, actualizar: actualizar ? 1 : 0 },
		}).then((r) => {
			fim();
			this.dados = r.message;
			this.carregados = true;
			if (actualizar) this.linhas = {};
			this._render();
			// Re-load the rows of the open cards (counts may have changed).
			this.abertos.forEach((c) => this._carregar_linhas(c, true));
		}, fim);
	}

	_carregar_linhas(chave, forcar) {
		if (this.linhas[chave] && !forcar) return;
		frappe.call({
			method: SG_API + "linhas",
			args: { chave, delegacao: this.delegacao || null, ignorados: this.verIgnorados[chave] ? 1 : 0 },
		}).then((r) => {
			this.linhas[chave] = r.message || [];
			const validos = new Set(this.linhas[chave].map((x) => x.name));
			this._sel(chave).forEach((n) => { if (!validos.has(n)) this._sel(chave).delete(n); });
			this._render_card(chave);
		});
	}

	_sel(c) {
		if (!this.sel[c]) this.sel[c] = new Set();
		return this.sel[c];
	}

	_verif(c) {
		return (this.dados.verificacoes || []).find((v) => v.chave === c);
	}

	_filtradas(c) {
		const q = this.busca[c] || "";
		const rows = this.linhas[c] || [];
		if (!q) return rows;
		return rows.filter((r) =>
			[r.titulo, r.codigo, r.detalhe, r.delegacao, r.name].join(" ").toLowerCase().includes(q));
	}

	// ───────────────────────────────────────────────────────── render
	_render() {
		if (!this.dados) return;
		const $sel = this.$body.find("[data-delegacao]");
		const atual = this.delegacao;
		$sel.find("option:not(:first)").remove();
		(this.dados.delegacoes || []).forEach((d) => {
			$sel.append(`<option value="${_sg_esc(d)}">${_sg_esc(d)}</option>`);
		});
		$sel.val(atual);
		this.$body.find("[data-when]").text(__("Actualizado às {0}", [frappe.datetime.now_time().slice(0, 5)]));
		this._render_kpis();
		this._render_side();
		this._render_main();
	}

	_render_kpis() {
		const tot = { critico: 0, aviso: 0, info: 0 };
		const verifs = this.dados.verificacoes || [];
		verifs.forEach((v) => { if (v.total && v.nivel) tot[v.nivel] += v.total; });
		const okCount = verifs.filter((v) => !v.total && !v.erro).length;
		const cards = ["critico", "aviso", "info"].map((n) => `
			<div class="sg-kpi tone-${n}" data-nivel="${n}">
				<div class="sg-kpi-lbl"><i class="sg-dot tone-${n}"></i>${__(SG_NIVEIS[n].label)}</div>
				<div class="sg-kpi-val">${tot[n]}</div>
				<div class="sg-kpi-sub">${__("ocorrências")}</div>
			</div>`).join("");
		this.$kpis.html(cards + `
			<div class="sg-kpi tone-good">
				<div class="sg-kpi-lbl"><i class="sg-dot tone-good"></i>${__("Sem problemas")}</div>
				<div class="sg-kpi-val">${okCount}<span class="sg-kpi-of">/${verifs.length}</span></div>
				<div class="sg-kpi-sub">${__("verificações")}</div>
			</div>`);
	}

	_resumo_grupo(g) {
		const vs = (this.dados.verificacoes || []).filter((v) => v.grupo === g);
		const total = vs.reduce((a, v) => a + (v.total || 0), 0);
		const nivel = vs.reduce((m, v) => (v.total && v.nivel && (!m || SG_NIVEIS[v.nivel].peso > SG_NIVEIS[m].peso)) ? v.nivel : m, null);
		return { total, nivel, erro: vs.some((v) => v.erro) };
	}

	_render_side() {
		const totalGeral = (this.dados.verificacoes || []).reduce((a, v) => a + (v.total || 0), 0);
		const item = (chave, titulo, total, nivel, icone) => `
			<button type="button" class="sg-nav ${this.grupo === chave ? "is-active" : ""}" data-grupo="${chave}">
				<span class="sg-nav-ic">${icone}</span>
				<span class="sg-nav-t">${_sg_esc(titulo)}</span>
				${total ? `<span class="sg-badge tone-${nivel || "info"}">${total}</span>` : `<span class="sg-ok">${_sg_icon_check()}</span>`}
			</button>`;
		let html = item("resumo", __("Resumo"), totalGeral, this._pior(), _sg_icon_grid());
		html += `<div class="sg-nav-sep">${__("Áreas")}</div>`;
		(this.dados.grupos || []).forEach((g) => {
			const r = this._resumo_grupo(g.chave);
			html += item(g.chave, g.titulo, r.total, r.nivel, _sg_icon_grupo(g.chave));
		});
		this.$side.html(html);
	}

	_pior() {
		return (this.dados.verificacoes || []).reduce((m, v) =>
			(v.total && v.nivel && (!m || SG_NIVEIS[v.nivel].peso > SG_NIVEIS[m].peso)) ? v.nivel : m, null);
	}

	_render_main() {
		if (!this.dados) return;
		const verifs = this.dados.verificacoes || [];
		let lista, titulo, sub;
		if (this.grupo === "resumo") {
			lista = verifs.filter((v) => v.total || v.erro).sort((a, b) =>
				(SG_NIVEIS[b.nivel || "info"].peso - SG_NIVEIS[a.nivel || "info"].peso) || (b.total - a.total));
			titulo = __("Resumo");
			sub = lista.length ? __("Tudo o que precisa de atenção, do mais grave para o menos grave.")
				: __("Nada a assinalar.");
		} else {
			const g = (this.dados.grupos || []).find((x) => x.chave === this.grupo);
			lista = verifs.filter((v) => v.grupo === this.grupo).sort((a, b) =>
				((b.total ? 1 : 0) - (a.total ? 1 : 0)) ||
				(SG_NIVEIS[b.nivel || b.severidade].peso - SG_NIVEIS[a.nivel || a.severidade].peso));
			titulo = g ? g.titulo : "";
			sub = "";
		}
		const nomeGrupo = {};
		(this.dados.grupos || []).forEach((g) => { nomeGrupo[g.chave] = g.titulo; });
		let html = `<div class="sg-main-h"><h2>${_sg_esc(titulo)}</h2>${sub ? `<p>${sub}</p>` : ""}</div>`;
		if (!lista.length) {
			html += `<div class="sg-empty">${_sg_icon_check()}<div>${__("Sem problemas por agora.")}</div></div>`;
		}
		lista.forEach((v) => {
			html += `<section class="sg-card" data-card="${v.chave}">${this._card_html(v, this.grupo === "resumo" ? nomeGrupo[v.grupo] : null)}</section>`;
		});
		this.$main.html(html);
	}

	_render_card(c, manterBusca) {
		const v = this._verif(c);
		const $card = this.$main.find(`[data-card="${c}"]`);
		if (!v || !$card.length) return;
		let foco = null;
		if (manterBusca) {
			const el = $card.find("[data-busca]")[0];
			if (el && document.activeElement === el) foco = el.selectionStart;
		}
		$card.html(this._card_html(v, this.grupo === "resumo" ? ((this.dados.grupos || []).find((g) => g.chave === v.grupo) || {}).titulo : null));
		if (foco !== null) {
			const el = $card.find("[data-busca]")[0];
			el.focus();
			el.setSelectionRange(foco, foco);
		}
	}

	_card_html(v, grupoTag) {
		const aberto = this.abertos.has(v.chave);
		const nivel = v.total ? (v.nivel || v.severidade) : null;
		const estado = v.erro
			? `<span class="sg-badge tone-critico">${__("Erro")}</span>`
			: v.total ? `<span class="sg-badge tone-${nivel}">${v.total}</span>`
				: `<span class="sg-ok">${_sg_icon_check()}</span>`;
		const podeAbrir = v.total || v.ignorados || v.erro;
		let html = `
			<header class="sg-card-h ${podeAbrir ? "" : "is-flat"} ${aberto ? "is-open" : ""}" ${podeAbrir ? `data-toggle="${v.chave}"` : ""}>
				<i class="sg-sev tone-${nivel || "ok"}"></i>
				<div class="sg-card-tt">
					<div class="sg-card-t">${_sg_esc(v.titulo)}${grupoTag ? `<span class="sg-tag">${_sg_esc(grupoTag)}</span>` : ""}</div>
					<div class="sg-card-d">${_sg_esc(v.descricao)}</div>
				</div>
				${v.ignorados ? `<span class="sg-ign-n" title="${__("Ignorados")}">${v.ignorados} ${__("ignorado(s)")}</span>` : ""}
				${estado}
				${podeAbrir ? `<span class="sg-caret">${_sg_icon_caret()}</span>` : ""}
			</header>`;
		if (!aberto) return html;
		if (v.erro) return html + `<div class="sg-card-b"><div class="sg-note tone-critico">${_sg_esc(v.erro)}</div></div>`;

		const rows = this.linhas[v.chave];
		if (!rows) return html + `<div class="sg-card-b"><div class="sg-msg sg-msg-sm">${__("A carregar…")}</div></div>`;

		const ign = !!this.verIgnorados[v.chave];
		const filtradas = this._filtradas(v.chave);
		const limite = this.limite[v.chave] || SG_PAGINA;
		const sel = this._sel(v.chave);
		const fixes = ign ? [] : (v.correcoes || []);
		const emMassa = fixes.filter((f) => f.em_massa);
		const todasSel = filtradas.length && filtradas.every((r) => sel.has(r.name));

		html += `<div class="sg-card-b">
			<div class="sg-bar">
				<div class="sg-search">${_sg_icon_search()}<input type="text" data-busca="${v.chave}" value="${_sg_esc(this.busca[v.chave] || "")}" placeholder="${__("Filtrar…")}"></div>
				<div class="sg-bar-r">
					${sel.size ? `<span class="sg-selcount">${__("{0} seleccionado(s)", [sel.size])}</span>` : ""}
					${sel.size ? emMassa.map((f) => `<button type="button" class="sg-btn sg-btn-sm ${f.perigosa ? "sg-btn-warn" : ""}" data-chave="${v.chave}" data-fix="${f.chave}">${_sg_esc(f.rotulo)}</button>`).join("") : ""}
					${sel.size && !ign ? `<button type="button" class="sg-btn sg-btn-sm sg-btn-ghost" data-chave="${v.chave}" data-ignorar>${__("Ignorar")}</button>` : ""}
					${v.ignorados || ign ? `<button type="button" class="sg-link" data-ver-ignorados="${v.chave}">${ign ? __("Ver abertos") : __("Ver ignorados")}</button>` : ""}
				</div>
			</div>`;

		if (!filtradas.length) {
			html += `<div class="sg-msg sg-msg-sm">${ign ? __("Nenhum ignorado.") : __("Sem linhas.")}</div></div>`;
			return html;
		}

		html += `<div class="sg-table-wrap"><table class="sg-table"><thead><tr>
			<th class="sg-chk">${ign ? "" : `<input type="checkbox" data-sel-all="${v.chave}" ${todasSel ? "checked" : ""}>`}</th>
			<th>${__("Referência")}</th><th>${__("Nome")}</th><th>${__("Detalhe")}</th><th>${__("Delegação")}</th><th></th>
		</tr></thead><tbody>`;
		filtradas.slice(0, limite).forEach((r) => {
			const link = frappe.utils.get_form_link(r.link_doctype, r.link_name);
			const nivelR = r.nivel && r.nivel !== v.severidade ? `<i class="sg-dot tone-${r.nivel}" title="${__(SG_NIVEIS[r.nivel].label)}"></i>` : "";
			let accoes;
			if (ign) {
				const e = r.excecao || {};
				accoes = `<span class="sg-muted" title="${_sg_esc(e.motivo || "")}">${e.ate ? __("até {0}", [frappe.datetime.str_to_user(e.ate)]) : __("sempre")}</span>
					<button type="button" class="sg-link" data-chave="${v.chave}" data-restaurar="${_sg_esc(r.name)}">${__("Restaurar")}</button>`;
			} else {
				accoes = fixes.map((f) => `<button type="button" class="sg-btn sg-btn-xs ${f.perigosa ? "sg-btn-warn" : "sg-btn-ghost"}" data-chave="${v.chave}" data-fix="${f.chave}" data-nome="${_sg_esc(r.name)}">${_sg_esc(f.rotulo)}</button>`).join("")
					+ `<button type="button" class="sg-icon-btn" title="${__("Ignorar")}" data-chave="${v.chave}" data-ignorar data-nome="${_sg_esc(r.name)}">${_sg_icon_eye_off()}</button>`;
			}
			html += `<tr class="${sel.has(r.name) ? "is-sel" : ""}">
				<td class="sg-chk">${ign ? "" : `<input type="checkbox" data-chave="${v.chave}" data-sel="${_sg_esc(r.name)}" ${sel.has(r.name) ? "checked" : ""}>`}</td>
				<td class="sg-code"><a href="${link}" target="_blank" rel="noopener">${_sg_esc(r.codigo || r.name)}</a></td>
				<td class="sg-strong">${nivelR}${_sg_esc(r.titulo)}</td>
				<td class="sg-det">${_sg_esc(r.detalhe)}</td>
				<td class="sg-muted">${_sg_esc(r.delegacao || "")}</td>
				<td class="sg-act">${accoes}</td>
			</tr>`;
		});
		html += `</tbody></table></div>`;
		if (filtradas.length > limite) {
			html += `<button type="button" class="sg-more" data-mais="${v.chave}">${__("Mostrar mais ({0} restantes)", [filtradas.length - limite])}</button>`;
		}
		return html + `</div>`;
	}

	// ───────────────────────────────────────────────────────── actions
	_corrigir(chave, fixChave, nomes) {
		const v = this._verif(chave);
		const f = (v.correcoes || []).find((x) => x.chave === fixChave);
		if (!f || !nomes.length) return;
		const n = nomes.length;
		const intro = `<div class="sg-dlg-intro"><b>${_sg_esc(v.titulo)}</b> · ${n === 1 ? _sg_esc(this._titulo(chave, nomes[0])) : __("{0} linhas", [n])}${f.confirmar ? `<br><span class="sg-muted">${_sg_esc(f.confirmar)}</span>` : ""}</div>`;
		const d = new frappe.ui.Dialog({
			title: f.rotulo,
			fields: [{ fieldtype: "HTML", fieldname: "intro", options: intro }].concat(f.campos || []),
			primary_action_label: n === 1 ? f.rotulo : __("{0} ({1})", [f.rotulo, n]),
			primary_action: (vals) => {
				d.get_primary_btn().prop("disabled", true);
				delete vals.intro;
				frappe.call({
					method: SG_API + "executar",
					args: { chave, correcao: fixChave, nomes, params: vals },
					freeze: true,
					freeze_message: __("A executar…"),
				}).then((r) => {
					d.hide();
					this._resultado(f.rotulo, r.message || {});
				}, () => d.get_primary_btn().prop("disabled", false));
			},
		});
		if (f.perigosa) d.get_primary_btn().addClass("btn-danger").removeClass("btn-primary");
		d.show();
	}

	_resultado(rotulo, r) {
		if (r.enfileirado) {
			frappe.show_alert({ message: __("{0}: {1} linhas em execução em segundo plano.", [rotulo, r.enfileirado]), indicator: "blue" }, 7);
			return;
		}
		const ok = r.ok || [], falhas = r.falhas || [], fora = r.fora || [];
		if (ok.length === 1 && ok[0].rota && !falhas.length) {
			frappe.set_route(ok[0].rota);
			return;
		}
		if (!falhas.length && !fora.length) {
			frappe.show_alert({ message: __("{0}: {1} feito(s).", [rotulo, ok.length]), indicator: "green" }, 5);
		} else {
			let html = `<p>${__("{0} feito(s), {1} com erro.", [ok.length, falhas.length])}</p>`;
			if (falhas.length) {
				html += `<table class="table table-bordered table-sm"><tbody>${falhas.map((x) =>
					`<tr><td style="white-space:nowrap">${_sg_esc(x.name)}</td><td>${_sg_esc(x.erro)}</td></tr>`).join("")}</tbody></table>`;
			}
			if (fora.length) html += `<p class="text-muted">${__("Já não precisavam de correcção: {0}", [fora.map(_sg_esc).join(", ")])}</p>`;
			frappe.msgprint({ title: rotulo, message: html, indicator: falhas.length ? "orange" : "green" });
		}
		this._apos_accao();
	}

	_fim_lote(r) {
		const falhas = (r.falhas || []).length;
		frappe.show_alert({
			message: __("{0}: {1} feito(s), {2} com erro.", [r.correcao, r.ok, falhas]),
			indicator: falhas ? "orange" : "green",
		}, 8);
		this._apos_accao();
	}

	_apos_accao() {
		this.sel = {};
		this.linhas = {};
		this._load(false);
	}

	_ignorar(chave, nomes) {
		if (!nomes.length) return;
		const d = new frappe.ui.Dialog({
			title: __("Ignorar"),
			fields: [
				{ fieldtype: "HTML", fieldname: "intro", options: `<div class="sg-dlg-intro">${nomes.length === 1 ? _sg_esc(this._titulo(chave, nomes[0])) : __("{0} linhas", [nomes.length])}</div>` },
				{ fieldtype: "Small Text", fieldname: "motivo", label: __("Motivo"), reqd: 1 },
				{ fieldtype: "Date", fieldname: "ate", label: __("Até"), description: __("Vazio = sempre.") },
			],
			primary_action_label: __("Ignorar"),
			primary_action: (vals) => {
				frappe.call({ method: SG_API + "ignorar", args: { chave, nomes, motivo: vals.motivo, ate: vals.ate || null } })
					.then(() => {
						d.hide();
						frappe.show_alert({ message: __("Ignorado."), indicator: "blue" }, 4);
						this._apos_accao();
					});
			},
		});
		d.show();
	}

	_restaurar(chave, nomes) {
		frappe.call({ method: SG_API + "restaurar", args: { chave, nomes } }).then(() => this._apos_accao());
	}

	_titulo(chave, nome) {
		const r = (this.linhas[chave] || []).find((x) => x.name === nome);
		return r ? `${r.codigo || r.name} · ${r.titulo}` : nome;
	}

	// ───────────────────────────────────────────────────────── styles
	_inject_fonts() {
		if (document.getElementById("as-fonts")) return;
		const l = document.createElement("link");
		l.id = "as-fonts"; l.rel = "stylesheet";
		l.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";
		document.head.appendChild(l);
	}

	_inject_css() {
		if (document.getElementById("sg-css")) return;
		const css = `
/* SIGOS Saude - Operations Daylight. ASCII-only. */
.sigos-sg { background:#F4F6FA; }
.layout-main-section-wrapper:has(.sigos-sg), .page-body:has(.sigos-sg) { background:#F4F6FA; }
.sigos-sg .page-head, .sigos-sg + .page-head { display:none; }
.sg-root {
  --paper:#F4F6FA; --paper2:#FFFFFF; --paper3:#EEF1F6; --ink:#0E1726; --ink2:#5B6B82;
  --ink3:#93A1B5; --line:#E6EAF2; --line2:#D5DCE8; --accent:#4F46E5; --accentInk:#4338CA;
  --wash:rgba(79,70,229,.07); --good:#16A34A; --bad:#E5484D; --amber:#B7791F; --amberDot:#F59E0B; --info:#2F6FED;
  --graphite:#64748B; --goodWash:rgba(22,163,74,.10); --badWash:rgba(229,72,77,.09);
  --amberWash:rgba(245,158,11,.13); --infoWash:rgba(47,111,237,.09);
  --display:'Space Grotesk',system-ui,sans-serif; --body:'Inter',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
  --shadow:0 1px 2px rgba(16,23,38,.04), 0 14px 34px -20px rgba(16,23,38,.22);
  --r:14px;
  position:relative; max-width:1440px; margin:0 auto; padding:8px 14px 80px;
  color:var(--ink); font-family:var(--body); font-size:13px; font-feature-settings:"tnum" 1; -webkit-font-smoothing:antialiased;
}
.sg-root * { box-sizing:border-box; }

.sg-mast { display:flex; justify-content:space-between; align-items:center; padding:18px 4px 16px; gap:16px; flex-wrap:wrap; }
.sg-mast-l { display:flex; align-items:center; gap:14px; }
.sg-mast-r { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.sg-mark { width:40px; height:40px; border-radius:12px; display:grid; place-items:center; flex:none; color:#fff;
  background:linear-gradient(150deg,var(--accent),var(--accentInk)); box-shadow:0 6px 16px -6px rgba(79,70,229,.6); }
.sg-mark svg { width:20px; height:20px; }
.sg-up { text-transform:uppercase; letter-spacing:.12em; font-size:10px; color:var(--ink3); font-weight:600; margin-bottom:2px; }
.sg-h1 { font-family:var(--display); font-weight:600; font-size:24px; line-height:1.1; letter-spacing:-.02em; margin:0; color:var(--ink); }
.sg-when { font-size:11.5px; color:var(--ink3); }
.sg-select { height:34px; border:1px solid var(--line2); border-radius:10px; background:var(--paper2); padding:0 10px; font-family:var(--body); font-size:12.5px; color:var(--ink); }

.sg-kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:16px; }
.sg-kpi { background:var(--paper2); border:1px solid var(--line); border-radius:12px; padding:13px 15px; display:flex; flex-direction:column; gap:4px; box-shadow:var(--shadow); min-width:0; }
.sg-kpi[data-nivel] { cursor:pointer; }
.sg-kpi[data-nivel]:hover { border-color:var(--accent); }
.sg-kpi-lbl { display:flex; align-items:center; gap:7px; font-size:9.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink3); font-weight:600; }
.sg-kpi-val { font-family:var(--display); font-weight:600; font-size:24px; line-height:1.15; letter-spacing:-.02em; }
.sg-kpi-of { font-size:14px; color:var(--ink3); font-weight:500; }
.sg-kpi-sub { font-size:11px; color:var(--ink3); }
.sg-kpi.tone-critico .sg-kpi-val { color:var(--bad); }
.sg-kpi.tone-aviso .sg-kpi-val { color:var(--amber); }
.sg-kpi.tone-info .sg-kpi-val { color:var(--info); }
.sg-kpi.tone-good .sg-kpi-val { color:var(--good); }

.sg-dot { width:8px; height:8px; border-radius:50%; background:var(--ink3); display:inline-block; flex:none; }
.sg-dot.tone-critico { background:var(--bad); }
.sg-dot.tone-aviso { background:var(--amberDot); }
.sg-dot.tone-info { background:var(--info); }
.sg-dot.tone-good { background:var(--good); }

.sg-layout { display:grid; grid-template-columns:248px minmax(0,1fr); gap:16px; align-items:start; }
.sg-side { position:sticky; top:64px; background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); padding:8px; display:flex; flex-direction:column; gap:2px; }
.sg-nav { display:flex; align-items:center; gap:10px; width:100%; border:0; background:transparent; border-radius:9px; padding:8px 10px; font-family:var(--body); font-size:13px; color:var(--ink2); cursor:pointer; text-align:left; }
.sg-nav:hover { background:var(--paper3); color:var(--ink); }
.sg-nav.is-active { background:var(--wash); color:var(--accentInk); font-weight:600; }
.sg-nav-ic { width:18px; height:18px; display:grid; place-items:center; color:var(--ink3); flex:none; }
.sg-nav.is-active .sg-nav-ic { color:var(--accent); }
.sg-nav-ic svg { width:16px; height:16px; }
.sg-nav-t { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sg-nav-sep { font-size:9.5px; text-transform:uppercase; letter-spacing:.1em; color:var(--ink3); font-weight:600; padding:12px 10px 4px; }

.sg-badge { display:inline-flex; align-items:center; justify-content:center; min-width:24px; height:20px; padding:0 7px; border-radius:999px; font-family:var(--mono); font-size:11px; font-weight:600; background:var(--paper3); color:var(--ink2); flex:none; }
.sg-badge.tone-critico { background:var(--badWash); color:var(--bad); }
.sg-badge.tone-aviso { background:var(--amberWash); color:var(--amber); }
.sg-badge.tone-info { background:var(--infoWash); color:var(--info); }
.sg-ok { display:inline-grid; place-items:center; width:20px; height:20px; color:var(--good); flex:none; }
.sg-ok svg { width:15px; height:15px; }

.sg-main { min-width:0; display:flex; flex-direction:column; gap:10px; }
.sg-main-h { padding:2px 4px 4px; }
.sg-main-h h2 { font-family:var(--display); font-weight:600; font-size:18px; margin:0; letter-spacing:-.01em; }
.sg-main-h p { margin:2px 0 0; color:var(--ink3); font-size:12px; }
.sg-empty { background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); padding:40px; text-align:center; color:var(--ink2); display:flex; flex-direction:column; align-items:center; gap:8px; }
.sg-empty svg { width:28px; height:28px; color:var(--good); }

.sg-card { background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); overflow:hidden; }
.sg-card-h { display:flex; align-items:center; gap:12px; padding:13px 16px; cursor:pointer; }
.sg-card-h:hover { background:var(--paper); }
.sg-card-h.is-flat { cursor:default; }
.sg-card-h.is-flat:hover { background:transparent; }
.sg-card-h.is-open { border-bottom:1px solid var(--line); }
.sg-sev { width:4px; align-self:stretch; border-radius:4px; background:var(--line2); flex:none; }
.sg-sev.tone-critico { background:var(--bad); }
.sg-sev.tone-aviso { background:var(--amberDot); }
.sg-sev.tone-info { background:var(--info); }
.sg-sev.tone-ok { background:var(--good); opacity:.5; }
.sg-card-tt { flex:1; min-width:0; }
.sg-card-t { font-weight:600; font-size:13.5px; color:var(--ink); display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.sg-card-d { font-size:12px; color:var(--ink3); margin-top:2px; }
.sg-tag { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--graphite); background:var(--paper3); border-radius:6px; padding:2px 7px; }
.sg-ign-n { font-size:11px; color:var(--ink3); white-space:nowrap; }
.sg-caret { display:inline-grid; place-items:center; width:18px; height:18px; color:var(--ink3); transition:transform .15s; flex:none; }
.sg-caret svg { width:12px; height:12px; }
.sg-card-h.is-open .sg-caret { transform:rotate(90deg); color:var(--accent); }

.sg-card-b { padding:10px 12px 12px; background:var(--paper); }
.sg-bar { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
.sg-bar-r { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.sg-search { display:flex; align-items:center; gap:8px; background:var(--paper2); border:1px solid var(--line2); border-radius:10px; padding:0 12px; height:32px; min-width:200px; flex:0 1 280px; }
.sg-search svg { width:14px; height:14px; color:var(--ink3); flex:none; }
.sg-search input { border:0; background:transparent; outline:0; font-family:var(--body); font-size:12.5px; color:var(--ink); width:100%; }
.sg-selcount { font-size:12px; color:var(--accentInk); font-weight:600; }

.sg-table-wrap { background:var(--paper2); border:1px solid var(--line); border-radius:10px; overflow-x:auto; }
.sg-table { width:100%; border-collapse:collapse; font-size:12.5px; min-width:760px; }
.sg-table th { text-align:left; font-size:9.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink3); font-weight:700; padding:9px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
.sg-table td { padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:middle; }
.sg-table tr:last-child td { border-bottom:0; }
.sg-table tr:hover td { background:var(--paper); }
.sg-table tr.is-sel td { background:var(--wash); }
.sg-chk { width:34px; }
.sg-chk input { cursor:pointer; }
.sg-code { font-family:var(--mono); font-size:11.5px; white-space:nowrap; }
.sg-code a { color:var(--accent); text-decoration:none; font-weight:500; }
.sg-code a:hover { text-decoration:underline; }
.sg-strong { font-weight:500; color:var(--ink); display:table-cell; }
.sg-strong .sg-dot { margin-right:7px; vertical-align:middle; }
.sg-det { color:var(--ink2); }
.sg-muted { color:var(--ink3); white-space:nowrap; }
.sg-act { text-align:right; white-space:nowrap; }
.sg-act > * { margin-left:4px; vertical-align:middle; }

.sg-btn { font-family:var(--body); font-size:12px; font-weight:600; border:1px solid var(--accent); background:var(--accent); color:#fff; padding:8px 14px; border-radius:9px; cursor:pointer; }
.sg-btn:hover { background:var(--accentInk); border-color:var(--accentInk); }
.sg-btn:disabled { opacity:.6; cursor:default; }
.sg-btn-sm { padding:5px 11px; font-size:11.5px; }
.sg-btn-xs { padding:3px 9px; font-size:11px; border-radius:7px; }
.sg-btn-ghost { background:var(--paper2); color:var(--accentInk); border-color:var(--line2); }
.sg-btn-ghost:hover { background:var(--wash); border-color:var(--accent); color:var(--accentInk); }
.sg-btn-warn { background:var(--paper2); color:var(--bad); border-color:rgba(229,72,77,.4); }
.sg-btn-warn:hover { background:var(--badWash); border-color:var(--bad); color:var(--bad); }
.sg-icon-btn { border:0; background:transparent; width:26px; height:26px; border-radius:7px; color:var(--ink3); cursor:pointer; display:inline-grid; place-items:center; }
.sg-icon-btn:hover { background:var(--paper3); color:var(--ink); }
.sg-icon-btn svg { width:14px; height:14px; }
.sg-link { border:0; background:transparent; color:var(--accent); font-family:var(--body); font-size:12px; font-weight:600; cursor:pointer; padding:2px 4px; }
.sg-link:hover { text-decoration:underline; }
.sg-more { display:block; width:100%; margin-top:8px; border:1px dashed var(--line2); background:transparent; border-radius:9px; padding:7px; color:var(--ink2); font-family:var(--body); font-size:12px; cursor:pointer; }
.sg-more:hover { border-color:var(--accent); color:var(--accent); }

.sg-msg { padding:40px 12px; text-align:center; color:var(--ink3); font-size:12.5px; font-style:italic; }
.sg-msg-sm { padding:14px; }
.sg-note { font-size:12px; padding:9px 12px; border-radius:9px; background:var(--paper2); border:1px solid var(--line); }
.sg-note.tone-critico { border-color:rgba(229,72,77,.3); background:var(--badWash); color:var(--bad); }
.sg-dlg-intro { font-size:13px; margin-bottom:6px; }

@media (max-width: 980px) {
  .sg-layout { grid-template-columns:1fr; }
  .sg-side { position:static; flex-direction:row; flex-wrap:wrap; }
  .sg-nav { width:auto; }
  .sg-nav-sep { display:none; }
  .sg-kpis { grid-template-columns:repeat(2,1fr); }
}
@media (max-width: 600px) {
  .sg-root { padding:8px 4px 60px; }
  .sg-search { flex:1 1 100%; }
}
`;
		const s = document.createElement("style");
		s.id = "sg-css";
		s.textContent = css;
		document.head.appendChild(s);
	}
};

// ─────────────────────────────────────────────────────────────── helpers
function _sg_esc(v) {
	return frappe.utils.escape_html(v == null ? "" : String(v));
}
function _sg_svg(p) {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}
function _sg_icon_pulse() { return _sg_svg(`<polyline points="3 12 7 12 10 5 14 19 17 12 21 12"></polyline>`); }
function _sg_icon_grid() { return _sg_svg(`<rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect>`); }
function _sg_icon_check() { return _sg_svg(`<circle cx="12" cy="12" r="9"></circle><polyline points="8 12.5 11 15.5 16 9.5"></polyline>`); }
function _sg_icon_caret() { return _sg_svg(`<polyline points="9 6 15 12 9 18"></polyline>`); }
function _sg_icon_search() { return _sg_svg(`<circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>`); }
function _sg_icon_eye_off() { return _sg_svg(`<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path><line x1="1" y1="1" x2="23" y2="23"></line>`); }
function _sg_icon_grupo(g) {
	const p = {
		operacoes: `<path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"></path>`,
		abandono: `<circle cx="12" cy="12" r="9"></circle><line x1="12" y1="7" x2="12" y2="13"></line><line x1="12" y1="16.5" x2="12" y2="17"></line>`,
		doenca: `<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8z"></path>`,
		disciplinar: `<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="14 3 14 9 20 9"></polyline><line x1="8" y1="14" x2="16" y2="14"></line>`,
		salarios: `<rect x="2" y="6" width="20" height="12" rx="2"></rect><circle cx="12" cy="12" r="2.5"></circle>`,
		rh: `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>`,
		armamento: `<rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>`,
		faturacao: `<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"></path><line x1="9" y1="8" x2="15" y2="8"></line><line x1="9" y1="12" x2="15" y2="12"></line>`,
	}[g] || `<circle cx="12" cy="12" r="9"></circle>`;
	return _sg_svg(p);
}
