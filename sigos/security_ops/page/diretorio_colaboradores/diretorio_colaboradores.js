// SIGOS - Diretório de Colaboradores. General-purpose employee directory: search/
// filter on the left, full profile (faltas, férias, salário, deduções, disciplinar)
// with one-click document creation on the right. "Operations Daylight" design
// system — same tokens as Painel CCO / Painel Operacional / Painel Estatístico:
// cool light paper, indigo = interaction, green/amber/red = status only.
frappe.provide("sigos");

frappe.pages["diretorio-colaboradores"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Diretório de Colaboradores"),
		single_column: true,
	});
	wrapper.diretorio = new sigos.DiretorioColaboradores(page, wrapper);
};
frappe.pages["diretorio-colaboradores"].on_page_show = function (wrapper) {
	if (wrapper.diretorio) wrapper.diretorio.refresh();
};

const DC_MESES_PT = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

sigos.DiretorioColaboradores = class DiretorioColaboradores {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.state = { search: "", status: "Active", posto: null, regime: null, categoria: null };
		this.selected = null;
		this.activeTab = "faltas";
		this.employees = [];

		this._inject_fonts();
		this._inject_css();
		this._build_shell();
		this._wire();
		this.refresh();
	}

	refresh() {
		this._load_list();
	}

	// ───────────────────────────────────────────────────────── shell + controls
	_build_shell() {
		this.page.main.addClass("sigos-dc");
		this.$body = $(`
			<div class="dc-root">
				<div class="dc-mast">
					<div class="dc-mast-l">
						<div class="dc-mark">${_dc_icon_users()}</div>
						<div>
							<div class="dc-up">${__("Recursos Humanos")}</div>
							<h1 class="dc-h1">${__("Diretório de Colaboradores")}</h1>
						</div>
					</div>
					<div class="dc-mast-r"><span class="dc-count" data-count></span></div>
				</div>
				<div class="dc-layout">
					<div class="dc-list">
						<div class="dc-search">
							${_dc_icon_search()}
							<input type="text" data-search placeholder="${__("Pesquisar por nome ou nº mecanográfico…")}" />
						</div>
						<div class="dc-filters">
							<select class="dc-select" data-filter="status">
								<option value="">${__("Todos os Estados")}</option>
								<option value="Active" selected>${__("Activos")}</option>
								<option value="Inactive">${__("Inactivos")}</option>
								<option value="Suspended">${__("Suspensos")}</option>
								<option value="Left">${__("Saídos")}</option>
							</select>
							<div data-ctrl="posto"></div>
							<div data-ctrl="regime"></div>
							<div data-ctrl="categoria"></div>
						</div>
						<div class="dc-rows" data-rows></div>
					</div>
					<div class="dc-profile" data-profile>
						${_dc_empty_state(__("Selecione um Colaborador"), __("Escolha alguém na lista para ver o perfil completo — faltas, férias, salário, deduções e disciplinar."))}
					</div>
				</div>
			</div>
		`).appendTo(this.page.main);

		this.$rows = this.$body.find("[data-rows]");
		this.$profile = this.$body.find("[data-profile]");
		this.$count = this.$body.find("[data-count]");

		this._mount_filter_controls();
	}

	_mount_filter_controls() {
		const build = (key, options, placeholder) => {
			const ctrl = frappe.ui.form.make_control({
				df: {
					fieldtype: "Link", fieldname: key, options, placeholder,
					onchange: () => { this.state[key] = ctrl.get_value() || null; this._load_list(); },
				},
				parent: this.$body.find(`[data-ctrl="${key}"]`),
				render_input: true,
			});
			return ctrl;
		};
		build("posto", "Posto De Vigilancia", __("Posto…"));
		build("regime", "Regime", __("Regime…"));
		build("categoria", "Categoria Vigilante", __("Categoria…"));
	}

	_wire() {
		let debounce;
		this.$body.find("[data-search]").on("input", (e) => {
			const v = e.target.value;
			clearTimeout(debounce);
			debounce = setTimeout(() => { this.state.search = v.trim(); this._load_list(); }, 300);
		});
		this.$body.find('[data-filter="status"]').on("change", (e) => {
			this.state.status = e.target.value || null;
			this._load_list();
		});
	}

	// ───────────────────────────────────────────────────────────────── list
	_load_list() {
		this.$rows.html(`<div class="dc-list-msg">${__("A carregar…")}</div>`);
		frappe.xcall("sigos.api.get_employee_directory", { filters: this.state }).then((rows) => {
			this.employees = rows || [];
			this._render_rows();
		});
	}

	_render_rows() {
		this.$count.text(__("{0} colaborador(es)", [this.employees.length]));
		if (!this.employees.length) {
			this.$rows.html(`<div class="dc-list-msg">${__("Nenhum colaborador encontrado.")}</div>`);
			return;
		}
		this.$rows.html(this.employees.map((e) => this._row_html(e)).join(""));
		this.$rows.find("[data-emp]").on("click", (ev) => this._select($(ev.currentTarget).attr("data-emp")));
		if (this.selected) this.$rows.find(`[data-emp="${this.selected}"]`).addClass("is-active");
	}

	_row_html(e) {
		const tone = _dc_status_tone(e.status);
		return `
			<button type="button" class="dc-row" data-emp="${frappe.utils.escape_html(e.name)}">
				<span class="dc-ava dc-ring-${tone}">${_dc_iniciais(e.employee_name)}</span>
				<span class="dc-row-txt">
					<span class="dc-row-name">${frappe.utils.escape_html(e.employee_name || e.name)}</span>
					<span class="dc-row-meta">${frappe.utils.escape_html(e.custom_mecanografico || e.name)}${e.custom_posto ? " · " + frappe.utils.escape_html(e.custom_posto) : ""}</span>
				</span>
				<span class="dc-row-dot dc-ring-${tone}"></span>
			</button>`;
	}

	// ─────────────────────────────────────────────────────────────── profile
	_select(name) {
		if (!name) return;
		this.selected = name;
		this.activeTab = "faltas";
		this.$rows.find(".dc-row").removeClass("is-active");
		this.$rows.find(`[data-emp="${name}"]`).addClass("is-active");
		this.$profile.html(`<div class="dc-list-msg">${__("A carregar perfil…")}</div>`);

		Promise.all([
			frappe.xcall("sigos.api.get_employee_hr360", { employee: name }),
			frappe.xcall("sigos.api.get_employee_disciplinar", { employee: name }),
		]).then(([hr, disc]) => {
			if (this.selected !== name) return; // user moved on while this was in flight
			this.profileData = hr;
			this.disciplinar = disc;
			this._render_profile();
		});
	}

	_render_profile() {
		const data = this.profileData;
		const disc = this.disciplinar;
		const tabs = [
			["faltas", __("Faltas")],
			["ferias", __("Férias")],
			["salario", __("Salário")],
			["deducoes", __("Deduções")],
			["disciplinar", __("Disciplinar")],
		];

		this.$profile.html(`
			<div class="dc-pcard">
				<div class="dc-phead">
					<span class="dc-pava dc-ring-${_dc_status_tone(_dc_status_of(this.employees, data.employee))}">${_dc_iniciais(data.employee_name)}</span>
					<div class="dc-phead-txt">
						<h2>${frappe.utils.escape_html(data.employee_name)}</h2>
						<span class="dc-pmeta">${frappe.utils.escape_html(data.employee)}${!data.vigilante ? " · " + __("sem Vigilante associado") : ""}</span>
					</div>
					<a class="dc-open-link" href="${frappe.utils.get_form_link("Employee", data.employee)}" target="_blank">${__("Abrir Employee")} ${_dc_icon_arrow()}</a>
				</div>
				<div class="dc-kpis">
					${_dc_kpi(__("Faltas Este Mês"), data.vigilante ? data.faltas.mes_atual : "—", "aus")}
					${_dc_kpi(__("Saldo de Férias"), _dc_ferias_resumo(data.ferias), "fer")}
					${_dc_kpi(__("Salário Base"), format_currency(data.salario.base_resolvida), "sal")}
					${_dc_kpi(__("Deduções/Empréstimos"), _dc_deducoes_resumo(data), "ded")}
				</div>
				<div class="dc-actions">
					<button type="button" class="dc-act" data-act="salario">${__("Definir Salário")}</button>
					<button type="button" class="dc-act" data-act="deducao">${__("Nova Dedução")}</button>
					<button type="button" class="dc-act" data-act="emprestimo">${__("Novo Empréstimo")}</button>
					<button type="button" class="dc-act" data-act="remuneracao">${__("Novo Provento")}</button>
					<button type="button" class="dc-act" data-act="reclamacao">${__("Nova Reclamação")}</button>
					<button type="button" class="dc-act dc-act-ghost" data-act="participacao">${__("Nova Participação")}</button>
					<button type="button" class="dc-act dc-act-ghost" data-act="processo">${__("Novo Processo Disciplinar")}</button>
				</div>
				<div class="dc-tabs">
					${tabs.map(([k, l]) => `<button type="button" class="dc-tab ${k === this.activeTab ? "is-active" : ""}" data-tab="${k}">${l}</button>`).join("")}
				</div>
				<div class="dc-tab-body" data-tab-body></div>
			</div>
		`);

		this.$profile.find("[data-tab]").on("click", (ev) => {
			this.activeTab = $(ev.currentTarget).attr("data-tab");
			this.$profile.find("[data-tab]").removeClass("is-active");
			$(ev.currentTarget).addClass("is-active");
			this._render_tab_body();
		});
		this.$profile.find("[data-act]").on("click", (ev) => this._run_action($(ev.currentTarget).attr("data-act")));
		this._render_tab_body();
	}

	_render_tab_body() {
		const $b = this.$profile.find("[data-tab-body]");
		const data = this.profileData, disc = this.disciplinar;
		if (this.activeTab === "faltas") return $b.html(_dc_tab_faltas(data));
		if (this.activeTab === "ferias") return $b.html(_dc_tab_ferias(data));
		if (this.activeTab === "salario") return $b.html(_dc_tab_salario(data));
		if (this.activeTab === "deducoes") return $b.html(_dc_tab_deducoes(data));
		if (this.activeTab === "disciplinar") return $b.html(_dc_tab_disciplinar(disc));
	}

	_run_action(act) {
		const data = this.profileData;
		const employee = data.employee, employee_name = data.employee_name, vigilante = data.vigilante;
		const done = () => this._select(employee);

		if (act === "salario") {
			if (!vigilante) return frappe.msgprint(__("Este colaborador não tem um Vigilante (SIGOS) associado."));
			return sigos.quick_docs.definir_salario(vigilante, done);
		}
		if (act === "deducao") return sigos.quick_docs.novo_deducao(employee, employee_name, done);
		if (act === "emprestimo") return sigos.quick_docs.novo_emprestimo(employee, employee_name, done);
		if (act === "remuneracao") return sigos.quick_docs.novo_remuneracao(employee, employee_name, done);
		if (act === "reclamacao") return sigos.quick_docs.nova_reclamacao(employee, employee_name, done);
		if (act === "participacao") {
			if (!vigilante) return frappe.msgprint(__("Este colaborador não tem um Vigilante (SIGOS) associado."));
			return frappe.new_doc("Participacao", { vigilante });
		}
		if (act === "processo") {
			if (!vigilante) return frappe.msgprint(__("Este colaborador não tem um Vigilante (SIGOS) associado."));
			return frappe.new_doc("Processo Disciplinar", { vigilante });
		}
	}

	// ─────────────────────────────────────────────────────────── fonts/css
	_inject_fonts() {
		if (document.getElementById("dc-fonts")) return;
		const l = document.createElement("link");
		l.id = "dc-fonts"; l.rel = "stylesheet";
		l.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";
		document.head.appendChild(l);
	}

	_inject_css() {
		if (document.getElementById("dc-css")) return;
		const css = `
/* SIGOS Diretório de Colaboradores - Operations Daylight. ASCII-only. */
.sigos-dc { background:#F4F6FA; }
.layout-main-section-wrapper:has(.sigos-dc), .page-body:has(.sigos-dc) { background:#F4F6FA; }
.sigos-dc .page-head, .sigos-dc + .page-head { display:none; }
.dc-root {
  --paper:#F4F6FA; --paper2:#FFFFFF; --paper3:#EEF1F6; --ink:#0E1726; --ink2:#5B6B82;
  --ink3:#93A1B5; --line:#E6EAF2; --line2:#D5DCE8; --accent:#4F46E5; --accentInk:#4338CA;
  --wash:rgba(79,70,229,.07); --good:#16A34A; --bad:#E5484D; --amber:#F59E0B; --info:#2F6FED;
  --graphite:#64748B; --goodWash:rgba(22,163,74,.12); --badWash:rgba(229,72,77,.12);
  --amberWash:rgba(245,158,11,.14); --graphiteWash:rgba(100,116,139,.14);
  --display:'Space Grotesk',system-ui,sans-serif; --body:'Inter',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
  --shadow:0 1px 2px rgba(16,23,38,.04), 0 14px 34px -20px rgba(16,23,38,.22);
  --r:14px;
  position:relative; max-width:1280px; margin:0 auto; padding:8px 14px 80px;
  color:var(--ink); font-family:var(--body); font-size:13px; font-feature-settings:"tnum" 1; -webkit-font-smoothing:antialiased;
}
.dc-root * { box-sizing:border-box; }

/* masthead */
.dc-mast { display:flex; justify-content:space-between; align-items:center; padding:18px 4px 16px; gap:16px; flex-wrap:wrap; }
.dc-mast-l { display:flex; align-items:center; gap:14px; }
.dc-mark { width:40px; height:40px; border-radius:12px; display:grid; place-items:center; flex:none; color:#fff;
  background:linear-gradient(150deg,var(--accent),var(--accentInk)); box-shadow:0 6px 16px -6px rgba(79,70,229,.6); }
.dc-mark svg { width:19px; height:19px; }
.dc-up { font-family:var(--body); text-transform:uppercase; letter-spacing:.12em; font-size:10px; color:var(--ink3); font-weight:600; margin-bottom:2px; }
.dc-h1 { font-family:var(--display); font-weight:600; font-size:24px; line-height:1.1; letter-spacing:-.02em; margin:0; color:var(--ink); }
.dc-count { font-size:12px; color:var(--ink3); font-weight:600; }

/* layout: list left, profile right */
.dc-layout { display:grid; grid-template-columns:340px 1fr; gap:16px; align-items:start; }
.dc-list { background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); padding:14px; position:sticky; top:8px; max-height:calc(100vh - 130px); display:flex; flex-direction:column; }
.dc-search { display:flex; align-items:center; gap:8px; background:var(--paper3); border:1px solid var(--line2); border-radius:10px; padding:0 12px; height:36px; flex:none; }
.dc-search svg { width:14px; height:14px; color:var(--ink3); flex:none; }
.dc-search input { border:0; background:transparent; outline:0; font-family:var(--body); font-size:12.5px; color:var(--ink); width:100%; }
.dc-filters { display:flex; flex-direction:column; gap:8px; margin-top:10px; flex:none; }
.dc-select { height:32px; border:1px solid var(--line2); border-radius:9px; background:var(--paper2); color:var(--ink); font-family:var(--body); font-size:12px; padding:0 8px; width:100%; }
.dc-filters .frappe-control { margin:0 !important; }
.dc-filters .control-label, .dc-filters .help-box { display:none !important; }
.dc-filters .control-input input { height:32px !important; border:1px solid var(--line2) !important; border-radius:9px !important; background:var(--paper2) !important; font-family:var(--body) !important; font-size:12px !important; box-shadow:none !important; }
.dc-rows { margin-top:10px; overflow-y:auto; display:flex; flex-direction:column; gap:4px; }
.dc-list-msg { padding:24px 8px; text-align:center; color:var(--ink3); font-size:12.5px; font-style:italic; }
.dc-row { display:flex; align-items:center; gap:10px; width:100%; text-align:left; background:transparent; border:1px solid transparent; border-radius:10px; padding:8px 9px; cursor:pointer; }
.dc-row:hover { background:var(--paper3); }
.dc-row.is-active { background:var(--wash); border-color:rgba(79,70,229,.25); }
.dc-ava { width:30px; height:30px; border-radius:50%; flex:none; display:inline-flex; align-items:center; justify-content:center; font-family:var(--display); font-weight:600; font-size:11px; color:var(--ink); background:var(--paper3); }
.dc-ring-good { box-shadow:0 0 0 2px var(--good); }
.dc-ring-bad { box-shadow:0 0 0 2px var(--bad); }
.dc-ring-amber { box-shadow:0 0 0 2px var(--amber); }
.dc-ring-graphite { box-shadow:0 0 0 2px var(--graphite); }
.dc-row-txt { min-width:0; flex:1; display:flex; flex-direction:column; }
.dc-row-name { font-size:12.5px; font-weight:600; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dc-row-meta { font-family:var(--mono); font-size:10.5px; color:var(--ink3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dc-row-dot { width:7px; height:7px; border-radius:50%; flex:none; background:currentColor; }
.dc-row-dot.dc-ring-good { background:var(--good); box-shadow:none; }
.dc-row-dot.dc-ring-bad { background:var(--bad); box-shadow:none; }
.dc-row-dot.dc-ring-amber { background:var(--amber); box-shadow:none; }
.dc-row-dot.dc-ring-graphite { background:var(--graphite); box-shadow:none; }

/* profile */
.dc-profile { min-height:420px; }
.dc-empty { background:var(--paper2); border:1px dashed var(--line2); border-radius:var(--r); padding:60px 24px; text-align:center; }
.dc-empty-icon { font-family:var(--display); font-size:34px; color:var(--ink3); margin-bottom:10px; }
.dc-empty h3 { font-family:var(--display); font-size:16px; margin:0 0 6px; color:var(--ink); }
.dc-empty p { font-size:12.5px; color:var(--ink3); max-width:340px; margin:0 auto; }

.dc-pcard { background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); padding:18px 20px 20px; }
.dc-phead { display:flex; align-items:center; gap:14px; padding-bottom:16px; border-bottom:1px solid var(--line); }
.dc-pava { width:52px; height:52px; border-radius:50%; flex:none; display:inline-flex; align-items:center; justify-content:center; font-family:var(--display); font-weight:600; font-size:17px; color:var(--ink); background:var(--paper3); }
.dc-phead-txt { flex:1; min-width:0; }
.dc-phead-txt h2 { font-family:var(--display); font-size:19px; font-weight:600; margin:0; letter-spacing:-.01em; color:var(--ink); }
.dc-pmeta { font-family:var(--mono); font-size:11.5px; color:var(--ink3); }
.dc-open-link { font-size:11.5px; font-weight:600; color:var(--accent); text-decoration:none; white-space:nowrap; }
.dc-open-link:hover { color:var(--accentInk); }
.dc-open-link svg { width:10px; height:10px; margin-left:2px; vertical-align:middle; }

.dc-kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-top:16px; }
.dc-kpi { background:var(--paper3); border:1px solid var(--line); border-radius:12px; padding:12px 14px; display:flex; flex-direction:column; gap:4px; min-width:0; }
.dc-kpi-lbl { font-size:9.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink3); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dc-kpi-val { font-family:var(--display); font-weight:600; font-size:22px; line-height:1.1; letter-spacing:-.02em; color:var(--ink); font-feature-settings:"tnum" 1; }
.dc-kpi.tone-aus .dc-kpi-val { color:var(--bad); }
.dc-kpi.tone-fer .dc-kpi-val { color:var(--good); }
.dc-kpi.tone-sal .dc-kpi-val { color:var(--accentInk); }
.dc-kpi.tone-ded .dc-kpi-val { color:var(--amber); }

.dc-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:16px; }
.dc-act { font-family:var(--body); font-size:11.5px; font-weight:600; letter-spacing:.01em; border:1px solid var(--accent); background:var(--accent); color:#fff; padding:8px 14px; border-radius:9px; cursor:pointer; transition:.15s; }
.dc-act:hover { background:var(--accentInk); border-color:var(--accentInk); }
.dc-act-ghost { background:var(--paper2); color:var(--ink2); border-color:var(--line2); }
.dc-act-ghost:hover { border-color:var(--accent); color:var(--accent); background:var(--paper2); }

.dc-tabs { display:flex; flex-wrap:wrap; gap:4px; margin-top:20px; border-bottom:1px solid var(--line); padding-bottom:0; }
.dc-tab { font-family:var(--body); font-size:12px; font-weight:600; color:var(--ink3); background:transparent; border:none; border-bottom:2px solid transparent; padding:8px 4px; margin-right:14px; cursor:pointer; }
.dc-tab:hover { color:var(--ink); }
.dc-tab.is-active { color:var(--accentInk); border-bottom-color:var(--accent); }
.dc-tab-body { margin-top:14px; }

.dc-block + .dc-block { margin-top:18px; }
.dc-block-title { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--ink3); margin-bottom:8px; }
.dc-msg { color:var(--ink3); font-style:italic; font-size:12.5px; padding:6px 0; }

.dc-table { width:100%; border-collapse:collapse; font-size:12.5px; }
.dc-table th { text-align:left; font-size:9.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink3); font-weight:700; padding:6px 10px; border-bottom:1px solid var(--line); }
.dc-table td { padding:8px 10px; border-bottom:1px solid var(--line); color:var(--ink); }
.dc-table tr:hover td { background:var(--paper3); }
.dc-table a { color:var(--accent); text-decoration:none; }
.dc-table a:hover { text-decoration:underline; }
.dc-num { font-family:var(--mono); font-feature-settings:"tnum" 1; text-align:right; white-space:nowrap; }
.dc-table th.dc-num { text-align:right; }

.dc-field-row { display:flex; justify-content:space-between; gap:12px; padding:6px 0; border-bottom:1px solid var(--line); font-size:12.5px; }
.dc-field-row:last-child { border-bottom:0; }
.dc-field-lbl { color:var(--ink3); font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; font-weight:600; }
.dc-field-val { font-family:var(--mono); color:var(--ink); font-feature-settings:"tnum" 1; }

@media (max-width: 860px) {
  .dc-layout { grid-template-columns:1fr; }
  .dc-list { position:static; max-height:none; }
  .dc-kpis { grid-template-columns:repeat(2,1fr); }
}
`;
		const s = document.createElement("style");
		s.id = "dc-css";
		s.textContent = css;
		document.head.appendChild(s);
	}
};

// ─────────────────────────────────────────────────────────────── helpers
function _dc_iniciais(nome) {
	if (!nome) return "?";
	const partes = nome.trim().split(/\s+/);
	const a = partes[0] ? partes[0][0] : "";
	const b = partes.length > 1 ? partes[partes.length - 1][0] : "";
	return (a + b).toUpperCase();
}

function _dc_status_tone(status) {
	if (status === "Active") return "good";
	if (status === "Suspended") return "bad";
	if (status === "Left") return "graphite";
	return "amber"; // Inactive / other
}

function _dc_status_of(employees, name) {
	const e = (employees || []).find((x) => x.name === name);
	return e ? e.status : "Active";
}

function _dc_ferias_resumo(ferias) {
	if (!ferias || !ferias.length) return "—";
	if (ferias.length === 1) return flt(ferias[0].saldo, 1);
	return `${ferias.length} ${__("tipos")}`;
}

function _dc_deducoes_resumo(data) {
	const linhas = (data.deducoes || []).concat(data.emprestimos || []);
	return linhas.length ? String(linhas.length) : "0";
}

function _dc_kpi(label, value, tone) {
	return `<div class="dc-kpi tone-${tone}"><div class="dc-kpi-lbl">${label}</div><div class="dc-kpi-val">${value}</div></div>`;
}

function _dc_empty_state(title, texto) {
	return `<div class="dc-empty"><div class="dc-empty-icon">${_dc_icon_users()}</div><h3>${title}</h3><p>${texto}</p></div>`;
}

function _dc_link(doctype, name, texto) {
	return `<a href="${frappe.utils.get_form_link(doctype, name)}" target="_blank">${frappe.utils.escape_html(texto || name)}</a>`;
}

function _dc_icon_search() {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;
}
function _dc_icon_users() {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`;
}
function _dc_icon_arrow() {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>`;
}

// ─────────────────────────────────────────────────────────── tab builders
function _dc_tab_faltas(data) {
	const rows = (data.faltas && data.faltas.recentes) || [];
	if (!data.vigilante) return `<p class="dc-msg">${__("Sem Vigilante (SIGOS) associado — faltas indisponíveis.")}</p>`;
	if (!rows.length) return `<p class="dc-msg">${__("Sem faltas registadas nos últimos 3 meses.")}</p>`;
	return `<table class="dc-table">
		<thead><tr><th>${__("Data")}</th><th>${__("Turno")}</th><th>${__("Tipo")}</th><th class="dc-num">${__("Peso")}</th><th>${__("Justificação")}</th></tr></thead>
		<tbody>${rows.map((r) => `
			<tr>
				<td>${frappe.datetime.str_to_user(r.data)}</td>
				<td>${frappe.utils.escape_html(r.turno || "—")}</td>
				<td>${frappe.utils.escape_html(r.subtipo_falta || r.tipo_de_ausencia || "—")}</td>
				<td class="dc-num">${r.n_de_faltas}</td>
				<td>${frappe.utils.escape_html(r.tipo_justificacao || "—")}</td>
			</tr>`).join("")}
		</tbody>
	</table>`;
}

function _dc_tab_ferias(data) {
	const rows = data.ferias || [];
	if (!rows.length) return `<p class="dc-msg">${__("Sem alocação de férias activa.")}</p>`;
	return `<table class="dc-table">
		<thead><tr><th>${__("Tipo de Licença")}</th><th class="dc-num">${__("Saldo (dias)")}</th></tr></thead>
		<tbody>${rows.map((r) => `<tr><td>${frappe.utils.escape_html(r.leave_type)}</td><td class="dc-num">${flt(r.saldo, 1)}</td></tr>`).join("")}</tbody>
	</table>`;
}

function _dc_tab_salario(data) {
	const ssa = data.salario.ssa_atual;
	const slips = data.salario.slips_recentes || [];
	let html = `<div class="dc-block">
		<div class="dc-block-title">${__("Estrutura Salarial Actual")}</div>
		${ssa
			? `<div class="dc-field-row"><span class="dc-field-lbl">${__("Estrutura")}</span><span class="dc-field-val">${_dc_link("Salary Structure Assignment", ssa.name, ssa.salary_structure)}</span></div>
			   <div class="dc-field-row"><span class="dc-field-lbl">${__("Base")}</span><span class="dc-field-val">${format_currency(ssa.base)}</span></div>
			   <div class="dc-field-row"><span class="dc-field-lbl">${__("Desde")}</span><span class="dc-field-val">${frappe.datetime.str_to_user(ssa.from_date)}</span></div>`
			: `<p class="dc-msg">${__("Sem Salary Structure Assignment submetida.")}</p>`}
	</div>`;
	html += `<div class="dc-block">
		<div class="dc-block-title">${__("Folhas de Salário Recentes")}</div>
		${slips.length
			? `<table class="dc-table">
				<thead><tr><th>${__("Período")}</th><th class="dc-num">${__("Bruto")}</th><th class="dc-num">${__("Deduções")}</th><th class="dc-num">${__("Líquido")}</th></tr></thead>
				<tbody>${slips.map((s) => `<tr>
					<td>${_dc_link("Salary Slip", s.name, `${frappe.datetime.str_to_user(s.start_date)} – ${frappe.datetime.str_to_user(s.end_date)}`)}</td>
					<td class="dc-num">${format_currency(s.gross_pay)}</td>
					<td class="dc-num">${format_currency(s.total_deduction)}</td>
					<td class="dc-num">${format_currency(s.net_pay)}</td>
				</tr>`).join("")}</tbody>
			</table>`
			: `<p class="dc-msg">${__("Sem folhas de salário submetidas.")}</p>`}
	</div>`;
	return html;
}

function _dc_tab_deducoes(data) {
	const secao = (titulo, rows, cols) => `
		<div class="dc-block">
			<div class="dc-block-title">${titulo}</div>
			${rows.length
				? `<table class="dc-table">
					<thead><tr>${cols.map((c) => `<th class="${c.num ? "dc-num" : ""}">${c.label}</th>`).join("")}</tr></thead>
					<tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? "dc-num" : ""}">${c.render ? c.render(r) : frappe.utils.escape_html(r[c.field] ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody>
				</table>`
				: `<p class="dc-msg">${__("Nenhum(a).")}</p>`}
		</div>`;

	return secao(__("Deduções Activas"), data.deducoes || [], [
		{ label: __("Nome"), render: (r) => _dc_link("Outras Deducoes", r.name, r.name) },
		{ label: __("Tipo"), field: "tipo" },
		{ label: __("Valor Mensal"), num: true, render: (r) => format_currency(r.valor_mensal) },
		{ label: __("Até"), render: (r) => (r.data_de_fim ? frappe.datetime.str_to_user(r.data_de_fim) : "—") },
	]) + secao(__("Empréstimos Activos"), data.emprestimos || [], [
		{ label: __("Nome"), render: (r) => _dc_link("Emprestimo", r.name, r.name) },
		{ label: __("Prestação Mensal"), num: true, render: (r) => format_currency(r.valor_mensal) },
		{ label: __("Até"), render: (r) => (r.data_de_fim ? frappe.datetime.str_to_user(r.data_de_fim) : "—") },
	]) + secao(__("Proventos (recentes)"), data.remuneracoes || [], [
		{ label: __("Nome"), render: (r) => _dc_link("Outras Remuneracoes", r.name, r.name) },
		{ label: __("Tipo"), field: "tipo_de_subsidios" },
		{ label: __("Valor"), num: true, render: (r) => format_currency(r.valor_a_pagar) },
		{ label: __("Estado"), field: "workflow_state" },
	]) + secao(__("Reclamações de Salário (recentes)"), data.reclamacoes || [], [
		{ label: __("Nome"), render: (r) => _dc_link("Reclamacao De Salario", r.name, r.name) },
		{ label: __("Mês a Pagar"), field: "mes_a_ser_pago" },
		{ label: __("Valor"), num: true, render: (r) => format_currency(r.valor_a_reclamar) },
		{ label: __("Estado"), field: "workflow_state" },
	]);
}

function _dc_tab_disciplinar(disc) {
	if (!disc || !disc.vigilante) return `<p class="dc-msg">${__("Sem Vigilante (SIGOS) associado — disciplinar indisponível.")}</p>`;
	const secao = (titulo, rows, cols) => `
		<div class="dc-block">
			<div class="dc-block-title">${titulo}</div>
			${rows.length
				? `<table class="dc-table">
					<thead><tr>${cols.map((c) => `<th>${c.label}</th>`).join("")}</tr></thead>
					<tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${c.render ? c.render(r) : frappe.utils.escape_html(r[c.field] ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody>
				</table>`
				: `<p class="dc-msg">${__("Nenhum(a).")}</p>`}
		</div>`;

	return secao(__("Processos Disciplinares"), disc.processos || [], [
		{ label: __("Data"), render: (r) => frappe.datetime.str_to_user(r.data) },
		{ label: __("Gravidade"), field: "gravidade" },
		{ label: __("Decisão"), field: "decisao" },
		{ label: __("Nome"), render: (r) => _dc_link("Processo Disciplinar", r.name, r.name) },
	]) + secao(__("Participações"), disc.participacoes || [], [
		{ label: __("Data"), render: (r) => frappe.datetime.str_to_user(r.data) },
		{ label: __("Gravidade"), field: "gravidade" },
		{ label: __("Infração"), field: "tipo_de_infracao" },
		{ label: __("Nome"), render: (r) => _dc_link("Participacao", r.name, r.name) },
	]);
}
