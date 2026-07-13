// SIGOS - Ajuste de Salários. HR bulk salary-assignment worklist: filter/search
// the workforce, see current vs resolved base side by side, select a subset and
// bulk-apply via sigos.api.aplicar_salario_base(vigilantes=...). "Operations
// Daylight" design system — same tokens as Diretório de Colaboradores / Painel CCO.
frappe.provide("sigos");

frappe.pages["ajuste-de-salarios"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Ajuste de Salários"),
		single_column: true,
	});
	wrapper.ajuste_salarios = new sigos.AjusteDeSalarios(page, wrapper);
};
frappe.pages["ajuste-de-salarios"].on_page_show = function (wrapper) {
	if (wrapper.ajuste_salarios) wrapper.ajuste_salarios.refresh();
};

sigos.AjusteDeSalarios = class AjusteDeSalarios {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.state = {
			search: "", status: "Activo", delegacao: null, categoria: null,
			regime_do_vigilante: null, posto_de_vigilancia: null,
			so_sem_ssa: 0, so_com_override: 0, so_divergentes: 0,
		};
		this.rows = [];
		this.stats = {};
		this.selected = new Set();

		this._inject_fonts();
		this._inject_css();
		this._build_shell();
		this._wire();
		this.refresh();
	}

	refresh() {
		this.selected.clear();
		this._load();
	}

	// ───────────────────────────────────────────────────────── shell + controls
	_build_shell() {
		this.page.main.addClass("sigos-as");
		this.$body = $(`
			<div class="as-root">
				<div class="as-mast">
					<div class="as-mast-l">
						<div class="as-mark">${_as_icon_coin()}</div>
						<div>
							<div class="as-up">${__("Recursos Humanos")}</div>
							<h1 class="as-h1">${__("Ajuste de Salários")}</h1>
						</div>
					</div>
					<div class="as-mast-r"><span class="as-count" data-count></span></div>
				</div>

				<div class="as-kpis" data-kpis></div>

				<div class="as-toolbar">
					<div class="as-search">
						${_as_icon_search()}
						<input type="text" data-search placeholder="${__("Pesquisar por nome ou nº mecanográfico…")}" />
					</div>
					<select class="as-select" data-filter="status">
						<option value="Activo" selected>${__("Activos")}</option>
						<option value="Reserva">${__("Reserva")}</option>
						<option value="Todos">${__("Todos os Estados")}</option>
					</select>
					<div data-ctrl="delegacao"></div>
					<div data-ctrl="categoria"></div>
					<div data-ctrl="regime_do_vigilante"></div>
					<div data-ctrl="posto_de_vigilancia"></div>
				</div>

				<div class="as-table-wrap" data-table></div>

				<div class="as-actionbar" data-actionbar>
					<span class="as-actionbar-txt" data-actionbar-txt></span>
					<button type="button" class="as-btn" data-apply>${__("Aplicar Salário Base")}</button>
				</div>
			</div>
		`).appendTo(this.page.main);

		this.$kpis = this.$body.find("[data-kpis]");
		this.$table = this.$body.find("[data-table]");
		this.$count = this.$body.find("[data-count]");
		this.$actionbar = this.$body.find("[data-actionbar]");

		this._mount_filter_controls();
	}

	_mount_filter_controls() {
		this._ctrls = {};
		["delegacao", "categoria", "regime_do_vigilante", "posto_de_vigilancia"].forEach((key) => {
			const opts = { delegacao: "Delegacao", categoria: "Categoria Vigilante",
				regime_do_vigilante: "Regime", posto_de_vigilancia: "Posto De Vigilancia" }[key];
			const placeholder = { delegacao: __("Delegação…"), categoria: __("Categoria…"),
				regime_do_vigilante: __("Regime…"), posto_de_vigilancia: __("Posto…") }[key];
			this._ctrls[key] = frappe.ui.form.make_control({
				df: {
					fieldtype: "Link", fieldname: key, options: opts, placeholder,
					onchange: () => {
						this.state[key] = this._ctrls[key].get_value() || null;
						this._load();
					},
				},
				parent: this.$body.find(`[data-ctrl="${key}"]`),
				render_input: true,
			});
		});
	}

	_wire() {
		let debounce;
		this.$body.find("[data-search]").on("input", (e) => {
			const v = e.target.value;
			clearTimeout(debounce);
			debounce = setTimeout(() => { this.state.search = v.trim(); this._load(); }, 300);
		});
		this.$body.find('[data-filter="status"]').on("change", (e) => {
			this.state.status = e.target.value;
			this._load();
		});
		this.$body.find("[data-apply]").on("click", () => this._apply());
	}

	// ───────────────────────────────────────────────────────────────── data
	_load() {
		this.$table.html(`<div class="as-msg">${__("A carregar…")}</div>`);
		frappe.xcall("sigos.api.get_ajuste_salarios", { filters: this.state }).then((r) => {
			this.rows = (r && r.rows) || [];
			this.stats = (r && r.stats) || {};
			this._render_kpis();
			this._render_table();
			this._render_actionbar();
		});
	}

	_render_kpis() {
		const s = this.stats;
		const tile = (key, label, value, tone, toggleable) => {
			const active = toggleable && this.state[`so_${key}`] ? "is-active" : "";
			return `<div class="as-kpi tone-${tone} ${active}" ${toggleable ? `data-toggle="${key}"` : ""}>
				<div class="as-kpi-lbl">${label}</div>
				<div class="as-kpi-val">${value}</div>
			</div>`;
		};
		this.$kpis.html([
			tile("total", __("Total"), s.total ?? 0, "neu", false),
			tile("sem_salario", __("Sem Salário Definido"), s.sem_salario ?? 0, "bad", false),
			tile("sem_ssa", __("Sem SSA"), s.sem_ssa ?? 0, "amber", true),
			tile("com_override", __("Com Override"), s.com_override ?? 0, "info", true),
			tile("divergentes", __("Divergentes"), s.divergentes ?? 0, "sal", true),
		].join(""));
		this.$count.text(__("{0} vigilante(s)", [s.total ?? 0]));
		this.$kpis.find("[data-toggle]").on("click", (ev) => {
			const key = `so_${$(ev.currentTarget).attr("data-toggle")}`;
			this.state[key] = this.state[key] ? 0 : 1;
			this._load();
		});
	}

	_render_table() {
		if (!this.rows.length) {
			this.$table.html(`<div class="as-msg">${__("Nenhum vigilante encontrado.")}</div>`);
			return;
		}
		this.$table.html(`
			<table class="as-table">
				<thead><tr>
					<th class="as-chk"><input type="checkbox" data-select-all /></th>
					<th>${__("Nome")}</th>
					<th>${__("Mecanográfico")}</th>
					<th>${__("Delegação")}</th>
					<th>${__("Categoria")}</th>
					<th>${__("Regime")}</th>
					<th>${__("Posto / Contrato")}</th>
					<th class="as-num">${__("Salário Actual")}</th>
					<th class="as-num">${__("Salário Resolvido")}</th>
					<th class="as-num">${__("Diferença")}</th>
				</tr></thead>
				<tbody>${this.rows.map((r) => this._row_html(r)).join("")}</tbody>
			</table>
		`);
		this.$table.find("[data-select-all]").on("change", (e) => this._toggle_all(e.target.checked));
		this.$table.find("[data-row-chk]").on("change", (ev) => {
			const name = $(ev.currentTarget).attr("data-row-chk");
			if (ev.currentTarget.checked) this.selected.add(name); else this.selected.delete(name);
			this._render_actionbar();
		});
		this.$table.find("[data-open]").on("click", (ev) => {
			const name = $(ev.currentTarget).attr("data-open");
			const row = this.rows.find((x) => x.name === name);
			sigos.quick_docs.definir_salario(name, () => this._load(), row ? row.salario_base_manual : null);
		});
	}

	_row_html(r) {
		const diffTone = r.diferenca > 0 ? "good" : (r.diferenca < 0 ? "bad" : "muted");
		const diffSign = r.diferenca > 0 ? "+" : "";
		return `
			<tr>
				<td class="as-chk"><input type="checkbox" data-row-chk="${frappe.utils.escape_html(r.name)}" ${this.selected.has(r.name) ? "checked" : ""} /></td>
				<td><a href="javascript:void(0)" data-open="${frappe.utils.escape_html(r.name)}">${frappe.utils.escape_html(r.nome_completo || r.name)}</a>${r.tem_override ? ` <span class="as-badge">${__("override")}</span>` : ""}</td>
				<td class="as-mono">${frappe.utils.escape_html(r.mecanografico || "—")}</td>
				<td>${frappe.utils.escape_html(r.delegacao || "—")}</td>
				<td>${frappe.utils.escape_html(r.categoria || "—")}</td>
				<td>${frappe.utils.escape_html(r.regime_do_vigilante || "—")}</td>
				<td>${frappe.utils.escape_html(r.posto_de_vigilancia || r.projecto || "—")}</td>
				<td class="as-num">${format_currency(r.salario_atual)}</td>
				<td class="as-num">${format_currency(r.salario_resolvido)}</td>
				<td class="as-num as-tone-${diffTone}">${diffSign}${format_currency(r.diferenca)}</td>
			</tr>`;
	}

	_toggle_all(checked) {
		this.rows.forEach((r) => { if (checked) this.selected.add(r.name); else this.selected.delete(r.name); });
		this.$table.find("[data-row-chk]").prop("checked", checked);
		this._render_actionbar();
	}

	// ────────────────────────────────────────────────────────────── action bar
	_render_actionbar() {
		const n = this.selected.size;
		if (!n) { this.$actionbar.removeClass("is-open"); return; }
		let aumentos = 0, reducoes = 0, iguais = 0;
		this.rows.forEach((r) => {
			if (!this.selected.has(r.name)) return;
			if (r.diferenca > 0) aumentos++;
			else if (r.diferenca < 0) reducoes++;
			else iguais++;
		});
		this.$actionbar.find("[data-actionbar-txt]").text(
			__("{0} seleccionado(s) — {1} aumento(s) · {2} redução(ões) · {3} sem alteração", [n, aumentos, reducoes, iguais])
		);
		this.$actionbar.addClass("is-open");
	}

	_apply() {
		const nomes = [...this.selected];
		if (!nomes.length) return;
		const reducoes = this.rows.filter((r) => this.selected.has(r.name) && r.diferenca < 0).length;

		const run = () => {
			frappe.xcall("sigos.api.aplicar_salario_base", { vigilantes: nomes }).then(() => this.refresh());
		};
		if (reducoes) {
			frappe.confirm(
				__("<b>{0}</b> dos vigilantes seleccionados vão sofrer uma <b>redução</b> de salário base. Confirmar mesmo assim?", [reducoes]),
				run,
			);
		} else {
			run();
		}
	}

	// ─────────────────────────────────────────────────────────── fonts/css
	_inject_fonts() {
		if (document.getElementById("as-fonts")) return;
		const l = document.createElement("link");
		l.id = "as-fonts"; l.rel = "stylesheet";
		l.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";
		document.head.appendChild(l);
	}

	_inject_css() {
		if (document.getElementById("as-css")) return;
		const css = `
/* SIGOS Ajuste de Salarios - Operations Daylight. ASCII-only. */
.sigos-as { background:#F4F6FA; }
.layout-main-section-wrapper:has(.sigos-as), .page-body:has(.sigos-as) { background:#F4F6FA; }
.sigos-as .page-head, .sigos-as + .page-head { display:none; }
.as-root {
  --paper:#F4F6FA; --paper2:#FFFFFF; --paper3:#EEF1F6; --ink:#0E1726; --ink2:#5B6B82;
  --ink3:#93A1B5; --line:#E6EAF2; --line2:#D5DCE8; --accent:#4F46E5; --accentInk:#4338CA;
  --wash:rgba(79,70,229,.07); --good:#16A34A; --bad:#E5484D; --amber:#F59E0B; --info:#2F6FED;
  --graphite:#64748B; --goodWash:rgba(22,163,74,.12); --badWash:rgba(229,72,77,.12);
  --amberWash:rgba(245,158,11,.14);
  --display:'Space Grotesk',system-ui,sans-serif; --body:'Inter',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
  --shadow:0 1px 2px rgba(16,23,38,.04), 0 14px 34px -20px rgba(16,23,38,.22);
  --r:14px;
  position:relative; max-width:1360px; margin:0 auto; padding:8px 14px 100px;
  color:var(--ink); font-family:var(--body); font-size:13px; font-feature-settings:"tnum" 1; -webkit-font-smoothing:antialiased;
}
.as-root * { box-sizing:border-box; }

.as-mast { display:flex; justify-content:space-between; align-items:center; padding:18px 4px 16px; gap:16px; flex-wrap:wrap; }
.as-mast-l { display:flex; align-items:center; gap:14px; }
.as-mark { width:40px; height:40px; border-radius:12px; display:grid; place-items:center; flex:none; color:#fff;
  background:linear-gradient(150deg,var(--accent),var(--accentInk)); box-shadow:0 6px 16px -6px rgba(79,70,229,.6); }
.as-mark svg { width:19px; height:19px; }
.as-up { font-family:var(--body); text-transform:uppercase; letter-spacing:.12em; font-size:10px; color:var(--ink3); font-weight:600; margin-bottom:2px; }
.as-h1 { font-family:var(--display); font-weight:600; font-size:24px; line-height:1.1; letter-spacing:-.02em; margin:0; color:var(--ink); }
.as-count { font-size:12px; color:var(--ink3); font-weight:600; }

.as-kpis { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; margin-bottom:16px; }
.as-kpi { background:var(--paper2); border:1px solid var(--line); border-radius:12px; padding:12px 14px; display:flex; flex-direction:column; gap:4px; min-width:0; box-shadow:var(--shadow); }
.as-kpi[data-toggle] { cursor:pointer; }
.as-kpi[data-toggle]:hover { border-color:var(--accent); }
.as-kpi.is-active { border-color:var(--accent); background:var(--wash); }
.as-kpi-lbl { font-size:9.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink3); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.as-kpi-val { font-family:var(--display); font-weight:600; font-size:24px; line-height:1.1; letter-spacing:-.02em; color:var(--ink); font-feature-settings:"tnum" 1; }
.as-kpi.tone-bad .as-kpi-val { color:var(--bad); }
.as-kpi.tone-amber .as-kpi-val { color:var(--amber); }
.as-kpi.tone-info .as-kpi-val { color:var(--info); }
.as-kpi.tone-sal .as-kpi-val { color:var(--accentInk); }

.as-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); padding:10px 12px; margin-bottom:16px; }
.as-search { display:flex; align-items:center; gap:8px; background:var(--paper3); border:1px solid var(--line2); border-radius:10px; padding:0 12px; height:34px; min-width:240px; flex:1 1 240px; }
.as-search svg { width:14px; height:14px; color:var(--ink3); flex:none; }
.as-search input { border:0; background:transparent; outline:0; font-family:var(--body); font-size:12.5px; color:var(--ink); width:100%; }
.as-select { height:34px; border:1px solid var(--line2); border-radius:9px; background:var(--paper2); color:var(--ink); font-family:var(--body); font-size:12px; padding:0 8px; }
.as-toolbar .frappe-control { margin:0 !important; min-width:150px; }
.as-toolbar .control-label, .as-toolbar .help-box { display:none !important; }
.as-toolbar .control-input input { height:34px !important; border:1px solid var(--line2) !important; border-radius:9px !important; background:var(--paper2) !important; font-family:var(--body) !important; font-size:12px !important; box-shadow:none !important; }

.as-table-wrap { background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); overflow-x:auto; }
.as-msg { padding:40px 12px; text-align:center; color:var(--ink3); font-size:12.5px; font-style:italic; }
.as-table { width:100%; border-collapse:collapse; font-size:12.5px; min-width:920px; }
.as-table th { text-align:left; font-size:9.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink3); font-weight:700; padding:10px; border-bottom:1px solid var(--line); white-space:nowrap; }
.as-table td { padding:9px 10px; border-bottom:1px solid var(--line); color:var(--ink); white-space:nowrap; }
.as-table tr:hover td { background:var(--paper3); }
.as-table a { color:var(--accent); text-decoration:none; font-weight:600; }
.as-table a:hover { text-decoration:underline; }
.as-chk { width:30px; }
.as-num { font-family:var(--mono); font-feature-settings:"tnum" 1; text-align:right; }
.as-table th.as-num { text-align:right; }
.as-mono { font-family:var(--mono); font-size:11.5px; color:var(--ink3); }
.as-tone-good { color:var(--good); }
.as-tone-bad { color:var(--bad); }
.as-tone-muted { color:var(--ink3); }
.as-badge { font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--accentInk); background:var(--wash); border-radius:6px; padding:2px 6px; margin-left:4px; }

.as-actionbar { position:sticky; bottom:12px; margin-top:16px; display:none; align-items:center; justify-content:space-between; gap:16px;
  background:var(--ink); color:#fff; border-radius:12px; padding:12px 18px; box-shadow:0 14px 34px -12px rgba(16,23,38,.5); }
.as-actionbar.is-open { display:flex; }
.as-actionbar-txt { font-size:12.5px; font-weight:600; }
.as-btn { font-family:var(--body); font-size:12px; font-weight:600; letter-spacing:.01em; border:1px solid var(--accent); background:var(--accent); color:#fff; padding:9px 16px; border-radius:9px; cursor:pointer; }
.as-btn:hover { background:var(--accentInk); border-color:var(--accentInk); }

@media (max-width: 960px) {
  .as-kpis { grid-template-columns:repeat(2,1fr); }
}
`;
		const s = document.createElement("style");
		s.id = "as-css";
		s.textContent = css;
		document.head.appendChild(s);
	}
};

// ─────────────────────────────────────────────────────────────── helpers
function _as_icon_search() {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;
}
function _as_icon_coin() {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v10"></path><path d="M15 9.5c0-1.4-1.34-2.5-3-2.5s-3 1-3 2.3 1.5 1.9 3 2.2 3 .9 3 2.2-1.34 2.3-3 2.3-3-1.1-3-2.5"></path></svg>`;
}
