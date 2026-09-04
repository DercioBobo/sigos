// SIGOS - Duplicados De Vigilante. Admin cleanup page for accidental duplicate
// Vigilante records: an auto-detected list (exact mecanografico/numero_documento
// matches, sigos.api.listar_vigilantes_duplicados_exatos) plus a manual picker for
// anything only caught by eye (e.g. a fuzzy-name duplicate). Both funnel into the
// same preview -> confirm flow against sigos.api.fundir_vigilante_duplicado, which
// does the actual merge (Frappe's own rename_doc merge=True — see api.py). Nothing
// is ever touched without an explicit dry-run preview shown first.
// "Operations Daylight" design system, danger-toned (this tool deletes records).
frappe.provide("sigos");

frappe.pages["duplicados-de-vigilante"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Duplicados De Vigilante"),
		single_column: true,
	});
	wrapper.duplicados_vig = new sigos.DuplicadosDeVigilante(page, wrapper);
};
frappe.pages["duplicados-de-vigilante"].on_page_show = function (wrapper) {
	if (wrapper.duplicados_vig) wrapper.duplicados_vig.refresh();
};

sigos.DuplicadosDeVigilante = class DuplicadosDeVigilante {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.pendente = null; // { duplicado, correto } currently previewed

		this._inject_fonts();
		this._inject_css();
		this._build_shell();
		this._wire();
		this.refresh();
	}

	refresh() {
		this._load_auto();
	}

	// ───────────────────────────────────────────────────────── shell
	_build_shell() {
		this.page.main.addClass("sigos-dv");
		this.$body = $(`
			<div class="dv-root">
				<div class="dv-mast">
					<div class="dv-mast-l">
						<div class="dv-mark">${_dv_icon_merge()}</div>
						<div>
							<div class="dv-up">${__("Manutenção")}</div>
							<h1 class="dv-h1">${__("Duplicados De Vigilante")}</h1>
						</div>
					</div>
				</div>

				<div class="dv-banner">
					${__("Fundir consolida um vigilante duplicado no registo correto — reatribui TUDO o que está associado (escala, faltas, participações, salário, funcionário) e remove o duplicado. É irreversível. Pré-visualize sempre antes de confirmar.")}
				</div>

				<div class="dv-section">
					<h2 class="dv-h2">${__("Detectados Automaticamente")}</h2>
					<p class="dv-sub">${__("Mesmo número mecanográfico ou mesmo número de documento — sinal exacto, não aproximado.")}</p>
					<div data-auto-list class="dv-auto-list"></div>
				</div>

				<div class="dv-section">
					<h2 class="dv-h2">${__("Fusão Manual")}</h2>
					<p class="dv-sub">${__("Para um caso que só reparou a olho (ex: nome semelhante) — escolha o duplicado e o registo correto.")}</p>
					<div class="dv-manual">
						<div class="dv-manual-field">
							<label>${__("Duplicado (a remover)")}</label>
							<div data-ctrl="duplicado"></div>
						</div>
						<div class="dv-manual-arrow">→</div>
						<div class="dv-manual-field">
							<label>${__("Correto (a manter)")}</label>
							<div data-ctrl="correto"></div>
						</div>
						<button type="button" class="dv-btn dv-btn-ghost" data-preview>${__("Pré-visualizar")}</button>
					</div>
					<div data-preview-panel></div>
				</div>
			</div>
		`).appendTo(this.page.main);

		this.$auto = this.$body.find("[data-auto-list]");
		this.$preview = this.$body.find("[data-preview-panel]");

		this._ctrls = {};
		["duplicado", "correto"].forEach((key) => {
			this._ctrls[key] = frappe.ui.form.make_control({
				df: {
					fieldtype: "Link", fieldname: key, options: "Vigilante",
					placeholder: __("Vigilante…"),
				},
				parent: this.$body.find(`[data-ctrl="${key}"]`),
				render_input: true,
			});
		});
	}

	_wire() {
		this.$body.find("[data-preview]").on("click", () => {
			const dup = this._ctrls.duplicado.get_value();
			const cor = this._ctrls.correto.get_value();
			if (!dup || !cor) {
				frappe.show_alert({ message: __("Escolha os dois vigilantes."), indicator: "orange" });
				return;
			}
			if (dup === cor) {
				frappe.show_alert({ message: __("Duplicado e correto não podem ser o mesmo registo."), indicator: "orange" });
				return;
			}
			this._preview(dup, cor);
		});
	}

	// ───────────────────────────────────────────────────────── auto-detected list
	_load_auto() {
		this.$auto.html(`<div class="dv-msg">${__("A procurar…")}</div>`);
		frappe.xcall("sigos.api.listar_vigilantes_duplicados_exatos").then((grupos) => {
			this.grupos = grupos || [];
			this._render_auto();
		});
	}

	_render_auto() {
		if (!this.grupos.length) {
			this.$auto.html(`<div class="dv-msg dv-msg-ok">${__("Nenhum duplicado exacto encontrado.")}</div>`);
			return;
		}
		const esc = frappe.utils.escape_html;
		const rotulo = { mecanografico: __("Mesmo Nº Mecanográfico"), numero_documento: __("Mesmo Documento") };

		this.$auto.html(this.grupos.map((g, gi) => {
			const correcto = g.membros[0]; // oldest record — pre-selected as the one to keep
			const outros = g.membros.slice(1);
			return `
				<div class="dv-group">
					<div class="dv-group-head">
						<span class="dv-badge">${rotulo[g.tipo] || g.tipo}</span>
						<span class="dv-group-valor">${esc(g.valor)}</span>
						<span class="dv-group-n">${__("{0} registos", [g.membros.length])}</span>
					</div>
					<div class="dv-group-body">
						${g.membros.map((m) => `
							<div class="dv-member ${m.name === correcto.name ? "is-correto" : ""}">
								<span class="dv-member-tag">${m.name === correcto.name ? __("mais antigo") : ""}</span>
								<span class="dv-member-nome">${esc(m.nome_completo || m.name)}</span>
								<span class="dv-member-meta">${esc(m.name)} · ${esc(m.status || "")}${m.delegacao ? " · " + esc(m.delegacao) : ""}</span>
							</div>
						`).join("")}
					</div>
					<div class="dv-group-actions">
						${outros.map((m) => `
							<button type="button" class="dv-btn dv-btn-sm" data-fundir data-dup="${esc(m.name)}" data-cor="${esc(correcto.name)}">
								${__("Fundir {0} → {1}", [m.name, correcto.name])}
							</button>
						`).join("")}
					</div>
				</div>`;
		}).join(""));

		this.$auto.find("[data-fundir]").on("click", (ev) => {
			const $b = $(ev.currentTarget);
			const dup = $b.attr("data-dup"), cor = $b.attr("data-cor");
			this._ctrls.duplicado.set_value(dup);
			this._ctrls.correto.set_value(cor);
			this._preview(dup, cor);
			this.$preview[0].scrollIntoView({ behavior: "smooth", block: "start" });
		});
	}

	// ───────────────────────────────────────────────────────── preview + confirm
	_preview(dup, cor) {
		this.pendente = null;
		this.$preview.html(`<div class="dv-msg">${__("A carregar pré-visualização…")}</div>`);
		frappe.xcall("sigos.api.fundir_vigilante_duplicado", { duplicado: dup, correto: cor }).then((r) => {
			this.pendente = { duplicado: dup, correto: cor, relatorio: r };
			this._render_preview(r);
		});
	}

	_render_preview(r) {
		const esc = frappe.utils.escape_html;
		const card = (titulo, d, tone) => `
			<div class="dv-card dv-card-${tone}">
				<div class="dv-card-tag">${titulo}</div>
				<div class="dv-card-nome">${esc(d.nome_completo || d.name)}</div>
				<div class="dv-card-meta">${esc(d.name)} · ${esc(d.status || "")}</div>
				<div class="dv-card-meta">${__("Funcionário")}: ${d.funcionario ? esc(d.funcionario) : `<span class="dv-dim">${__("nenhum")}</span>`}</div>
			</div>`;

		const ligacoes = Object.assign({}, r.vigilante_ligacoes, r.employee_ligacoes);
		const linhas = Object.entries(ligacoes);
		const tabela = linhas.length
			? `<table class="dv-lig-table">
				<thead><tr><th>${__("Onde")}</th><th class="dv-num">${__("Registos")}</th></tr></thead>
				<tbody>${linhas.map(([k, n]) => `<tr><td class="dv-mono">${esc(k)}</td><td class="dv-num">${n}</td></tr>`).join("")}</tbody>
			</table>`
			: `<div class="dv-msg dv-msg-ok">${__("Nada associado — remoção simples, sem dados a transferir.")}</div>`;

		this.$preview.html(`
			<div class="dv-preview">
				<div class="dv-preview-cards">
					${card(__("Duplicado — será removido"), r.duplicado, "bad")}
					<div class="dv-preview-arrow">→</div>
					${card(__("Correto — vai receber tudo"), r.correto, "good")}
				</div>
				<div class="dv-preview-lig">
					<div class="dv-preview-lig-title">${__("O que será transferido para o registo correto:")}</div>
					${tabela}
				</div>
				<button type="button" class="dv-btn dv-btn-danger" data-confirmar>${__("Confirmar Fusão Irreversível")}</button>
			</div>
		`);

		this.$preview.find("[data-confirmar]").on("click", () => this._confirmar());
	}

	_confirmar() {
		if (!this.pendente) return;
		const { duplicado, correto } = this.pendente;
		frappe.confirm(
			__("Tem a certeza? <b>{0}</b> será removido e tudo o que lhe está associado passa para <b>{1}</b>. Esta ação não pode ser desfeita.", [duplicado, correto]),
			() => {
				frappe.xcall("sigos.api.fundir_vigilante_duplicado", { duplicado, correto, confirmar: 1 }).then(() => {
					frappe.show_alert({
						message: __("Vigilante {0} fundido em {1}.", [duplicado, correto]),
						indicator: "green",
					}, 6);
					this.pendente = null;
					this.$preview.empty();
					this._ctrls.duplicado.set_value("");
					this._ctrls.correto.set_value("");
					this._load_auto();
				});
			}
		);
	}

	// ─────────────────────────────────────────────────────────── fonts/css
	_inject_fonts() {
		if (document.getElementById("dv-fonts")) return;
		const l = document.createElement("link");
		l.id = "dv-fonts"; l.rel = "stylesheet";
		l.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";
		document.head.appendChild(l);
	}

	_inject_css() {
		if (document.getElementById("dv-css")) return;
		const css = `
/* SIGOS Duplicados De Vigilante - Operations Daylight, danger-toned. ASCII-only. */
.sigos-dv { background:#F4F6FA; }
.layout-main-section-wrapper:has(.sigos-dv), .page-body:has(.sigos-dv) { background:#F4F6FA; }
.sigos-dv .page-head, .sigos-dv + .page-head { display:none; }
.dv-root {
  --paper:#F4F6FA; --paper2:#FFFFFF; --paper3:#EEF1F6; --ink:#0E1726; --ink2:#5B6B82;
  --ink3:#93A1B5; --line:#E6EAF2; --line2:#D5DCE8; --accent:#E5484D; --accentInk:#C6383D;
  --wash:rgba(229,72,77,.08); --good:#16A34A; --goodWash:rgba(22,163,74,.10);
  --bad:#E5484D; --badWash:rgba(229,72,77,.10); --amber:#F59E0B; --amberWash:rgba(245,158,11,.14);
  --display:'Space Grotesk',system-ui,sans-serif; --body:'Inter',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
  --shadow:0 1px 2px rgba(16,23,38,.04), 0 14px 34px -20px rgba(16,23,38,.22);
  --r:14px;
  position:relative; max-width:980px; margin:0 auto; padding:8px 14px 80px;
  color:var(--ink); font-family:var(--body); font-size:13px; font-feature-settings:"tnum" 1; -webkit-font-smoothing:antialiased;
}
.dv-root * { box-sizing:border-box; }

.dv-mast { display:flex; align-items:center; padding:18px 4px 4px; }
.dv-mast-l { display:flex; align-items:center; gap:14px; }
.dv-mark { width:40px; height:40px; border-radius:12px; display:grid; place-items:center; flex:none; color:#fff;
  background:linear-gradient(150deg,var(--accent),var(--accentInk)); box-shadow:0 6px 16px -6px rgba(229,72,77,.55); }
.dv-mark svg { width:19px; height:19px; }
.dv-up { font-family:var(--body); text-transform:uppercase; letter-spacing:.12em; font-size:10px; color:var(--ink3); font-weight:600; margin-bottom:2px; }
.dv-h1 { font-family:var(--display); font-weight:600; font-size:24px; line-height:1.1; letter-spacing:-.02em; margin:0; color:var(--ink); }

.dv-banner { margin:14px 4px 22px; padding:12px 16px; border-radius:12px; background:var(--amberWash);
  border:1px solid rgba(245,158,11,.35); color:#8a6d1a; font-size:12.5px; line-height:1.5; }

.dv-section { margin-bottom:26px; }
.dv-h2 { font-family:var(--display); font-weight:600; font-size:16px; margin:0 0 2px; color:var(--ink); }
.dv-sub { font-size:12px; color:var(--ink3); margin:0 0 12px; }

.dv-msg { padding:26px 12px; text-align:center; color:var(--ink3); font-size:12.5px; font-style:italic;
  background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); }
.dv-msg-ok { color:var(--good); font-style:normal; font-weight:600; }

.dv-auto-list { display:flex; flex-direction:column; gap:12px; }
.dv-group { background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); overflow:hidden; }
.dv-group-head { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid var(--line); background:var(--paper3); }
.dv-badge { font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--accentInk); background:var(--wash); border-radius:6px; padding:3px 8px; }
.dv-group-valor { font-family:var(--mono); font-size:12px; color:var(--ink); }
.dv-group-n { margin-left:auto; font-size:11px; color:var(--ink3); }
.dv-group-body { padding:6px 14px; }
.dv-member { display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px dashed var(--line); font-size:12.5px; }
.dv-member:last-child { border-bottom:0; }
.dv-member-tag { font-size:9px; text-transform:uppercase; letter-spacing:.04em; font-weight:700; color:var(--good); width:74px; flex:none; }
.dv-member-nome { font-weight:600; color:var(--ink); }
.dv-member-meta { color:var(--ink3); margin-left:auto; }
.dv-group-actions { display:flex; flex-wrap:wrap; gap:8px; padding:10px 14px; background:var(--paper3); border-top:1px solid var(--line); }

.dv-manual { display:flex; align-items:flex-end; gap:14px; flex-wrap:wrap; background:var(--paper2); border:1px solid var(--line);
  border-radius:var(--r); box-shadow:var(--shadow); padding:14px; margin-bottom:14px; }
.dv-manual-field { display:flex; flex-direction:column; gap:4px; min-width:220px; flex:1 1 220px; }
.dv-manual-field label { font-size:10px; text-transform:uppercase; letter-spacing:.06em; font-weight:700; color:var(--ink3); }
.dv-manual-arrow { font-size:18px; color:var(--ink3); padding-bottom:8px; }
.dv-manual .frappe-control { margin:0 !important; }
.dv-manual .control-label, .dv-manual .help-box { display:none !important; }
.dv-manual .control-input input { height:34px !important; border:1px solid var(--line2) !important; border-radius:9px !important; background:var(--paper2) !important; font-family:var(--body) !important; font-size:12px !important; box-shadow:none !important; }

.dv-btn { font-family:var(--body); font-size:12px; font-weight:600; letter-spacing:.01em; border:1px solid var(--accent); background:var(--accent); color:#fff; padding:9px 16px; border-radius:9px; cursor:pointer; }
.dv-btn:hover { background:var(--accentInk); border-color:var(--accentInk); }
.dv-btn-ghost { background:transparent; color:var(--accentInk); }
.dv-btn-ghost:hover { background:var(--wash); }
.dv-btn-sm { padding:6px 11px; font-size:11.5px; }
.dv-btn-danger { background:var(--bad); border-color:var(--bad); width:100%; padding:12px; font-size:13px; }
.dv-btn-danger:hover { background:var(--accentInk); border-color:var(--accentInk); }

.dv-preview { margin-top:14px; background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); padding:16px; }
.dv-preview-cards { display:flex; align-items:center; gap:14px; margin-bottom:16px; }
.dv-preview-arrow { font-size:20px; color:var(--ink3); flex:none; }
.dv-card { flex:1; border-radius:12px; padding:12px 14px; border:1px solid var(--line); }
.dv-card-bad { background:var(--badWash); border-color:rgba(229,72,77,.3); }
.dv-card-good { background:var(--goodWash); border-color:rgba(22,163,74,.3); }
.dv-card-tag { font-size:9.5px; text-transform:uppercase; letter-spacing:.05em; font-weight:700; color:var(--ink3); margin-bottom:4px; }
.dv-card-nome { font-family:var(--display); font-weight:600; font-size:15px; color:var(--ink); }
.dv-card-meta { font-size:11.5px; color:var(--ink2); margin-top:2px; }
.dv-dim { color:var(--ink3); font-style:italic; }

.dv-preview-lig-title { font-size:12px; font-weight:600; color:var(--ink2); margin-bottom:8px; }
.dv-lig-table { width:100%; border-collapse:collapse; font-size:12px; margin-bottom:16px; }
.dv-lig-table th { text-align:left; font-size:9.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--ink3); font-weight:700; padding:6px 8px; border-bottom:1px solid var(--line); }
.dv-lig-table td { padding:6px 8px; border-bottom:1px solid var(--line); }
.dv-mono { font-family:var(--mono); font-size:11.5px; color:var(--ink2); }
.dv-num { text-align:right; font-family:var(--mono); font-feature-settings:"tnum" 1; }
.dv-lig-table th.dv-num { text-align:right; }

@media (max-width: 640px) {
  .dv-preview-cards { flex-direction:column; }
  .dv-preview-arrow { transform:rotate(90deg); }
}
`;
		const s = document.createElement("style");
		s.id = "dv-css";
		s.textContent = css;
		document.head.appendChild(s);
	}
};

// ─────────────────────────────────────────────────────────────── helpers
function _dv_icon_merge() {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 3v6a3 3 0 0 1-3 3H6"></path><path d="m9 15-3-3 3-3"></path><circle cx="18" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle></svg>`;
}
