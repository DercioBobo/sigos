// SIGOS - Vigilantes de Hoje. All-in-one CCO roster board: everyone scheduled for a
// date+periodo (working AND on folga), contact-to-call, categoria, quick profile —
// marking an absence is just one action here, not the page's only purpose. Writes go
// through the same Ausencias/Tabela Ausencia model the classic quick-add dialog uses
// (sigos.api.marcar_ausencia_rapida finds-or-creates the day's sheet and upserts one
// row, then a plain doc.save() reuses ALL of Ausencias.validate() for free).
// Operations Daylight chrome (indigo interaction, Space Grotesk/Inter/IBM Plex Mono)
// + Ausencias/Rotatividade's amber "a marcar" / green "guardado" accents. Defaults
// LIGHT regardless of OS theme (own localStorage toggle, same idiom as Painel CCO).
frappe.provide("sigos");

frappe.pages["vigilantes-hoje"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({ parent: wrapper, title: __("Vigilantes de Hoje"), single_column: true });
	wrapper.vigilantes_hoje = new sigos.VigilantesHoje(page, wrapper);
};
frappe.pages["vigilantes-hoje"].on_page_show = function (wrapper) {
	if (wrapper.vigilantes_hoje) wrapper.vigilantes_hoje.refresh();
};

const VH_TIPOS = ["Falta", "Atraso", "Saída Antecipada", "Suspensão", "Licença", "Outro"];
const VH_ACCOES = ["Sem Ação", "Substituto", "Dobra de Turno", "Meia Dobra", "Adiantamento de Turno", "Horas Extras"];
const VH_ACCAO_CAMPO = {
	"Substituto": "vigilante_substituto",
	"Dobra de Turno": "vigilante_a_dobrar",
	"Meia Dobra": "vigilante_a_meia_dobra",
	"Adiantamento de Turno": "vigilante_a_adiantar",
	"Horas Extras": "vigilante_a_horas_extras",
};
const VH_SEVERIDADE = { "Falta": 0, "Suspensão": 0, "Atraso": 1, "Saída Antecipada": 1, "Outro": 1, "Licença": 2, "Folga": 3, "Presente": 4 };
const VH_PROBLEMA = new Set(["Falta", "Suspensão", "Atraso", "Saída Antecipada"]);

// Table view columns — label + a value-extractor used both to render the cell
// and to sort by that column (click header to sort, click again to reverse).
const VH_TBL_COLS = [
	{ key: "nome", label: "Vigilante", val: (r) => (r.nome_completo || r.vigilante || "").toLowerCase() },
	{ key: "posto", label: "Posto", val: (r) => (r.nome_do_posto || r.posto || "").toLowerCase() },
	{ key: "turno", label: "Turno", val: (r) => (r.turno || "").toLowerCase() },
	{ key: "regime", label: "Regime", val: (r) => (r.regime || "").toLowerCase() },
	{ key: "estado", label: "Estado", val: (r) => VH_SEVERIDADE[r._status] ?? 4 },
	{ key: "accao", label: "Acção", val: (r) => (r.ja_proxima_accao || "").toLowerCase() },
	{ key: "contacto", label: "Contacto", val: (r) => r.contacto || "" },
];

sigos.VigilantesHoje = class VigilantesHoje {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.state = {
			data: frappe.datetime.get_today(),
			periodo: "Manhã",
			grupo_delegados: null,
			busca: "",
			statusFiltro: null,
			postoFiltro: null,
		};
		this.expandedRowKey = null;
		this.userToggledPostos = new Map();
		this.rows = [];
		this.settingsFlags = {};
		this._dialogOpen = false;

		this.THEME_KEY = "sigos_vhoje_theme";
		this.theme = localStorage.getItem(this.THEME_KEY) || "light";
		this.VIEW_KEY = "sigos_vhoje_view";
		this.viewMode = localStorage.getItem(this.VIEW_KEY) || "table";
		this.tableSort = { campo: null, dir: "asc" };

		this._inject_fonts();
		this._inject_css();
		this._build();
		this._wire();
		this._apply_theme();

		frappe.call({
			method: "sigos.api.get_sigos_settings_flags",
			callback: (r) => { this.settingsFlags = r.message || {}; },
		});
		this.refresh();
		this._start_polling();
	}

	// A board meant to stay open all day should actually stay live. Skips a tick
	// while a mark/details dialog is open (don't yank focus mid-edit), while the
	// tab is backgrounded, or if the user has since navigated to a different page
	// (the class instance is kept alive across nav per on_page_show, so the timer
	// would otherwise keep polling forever in the background).
	_start_polling() {
		if (this._pollTimer) clearInterval(this._pollTimer);
		this._pollTimer = setInterval(() => {
			if (this._dialogOpen) return;
			if (document.visibilityState !== "visible") return;
			if (frappe.get_route()[0] !== "vigilantes-hoje") return;
			this.refresh();
		}, 75000);
	}

	// ============================================================ DATA
	refresh() {
		if (this._loading) return;
		this._loading = true;
		this.$root.find(".vh-stamp").text(__("A actualizar…"));
		frappe.call({
			method: "sigos.api.get_vigilantes_da_escala",
			args: {
				data: this.state.data,
				periodo: this.state.periodo,
				grupo_delegados: this.state.grupo_delegados,
				incluir_folga: 1,
			},
			callback: (r) => {
				this._loading = false;
				this.rows = r.message || [];
				this._populate_posto_filter();
				this._render();
				const agora = new Date().toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
				this.$root.find(".vh-stamp").text(__("Actualizado às {0}", [agora]));
			},
			error: () => {
				this._loading = false;
				this.$root.find(".vh-stamp").text(__("Erro ao actualizar"));
			},
		});
	}

	// Deterministic colour per posto (same hash idea as _avatar_html) — tied to
	// the posto's identity, not its position in the table, so it stays correct
	// even when the table is sorted by a different column and posto rows scatter.
	_posto_color(nome) {
		const s = (nome || "").trim();
		if (!s) return "transparent";
		let h = 0;
		for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
		return `hsl(${h}, 62%, 52%)`;
	}

	_status_de(row) {
		if (row.e_folga) return "Folga";
		if (row.ja_ausencia_row) return row.ja_tipo_de_ausencia || "Outro";
		return "Presente";
	}

	// ============================================================ RENDER
	_render() {
		this._close_menu(); // an open row menu would otherwise float orphaned over stale DOM
		const q = (this.state.busca || "").trim().toLowerCase();
		this.rows.forEach((r) => { r._status = this._status_de(r); });
		const filtradas = this.rows.filter((r) => {
			if (this.state.statusFiltro && r._status !== this.state.statusFiltro) return false;
			if (this.state.postoFiltro && (r.nome_do_posto || r.posto) !== this.state.postoFiltro) return false;
			if (!q) return true;
			return (r.nome_completo || "").toLowerCase().includes(q)
				|| (r.mecanografico || "").toLowerCase().includes(q)
				|| (r.nome_do_posto || r.posto || "").toLowerCase().includes(q);
		});

		const grupos = new Map();
		filtradas.forEach((r) => {
			const key = r.posto || "sem_posto";
			if (!grupos.has(key)) grupos.set(key, { label: r.nome_do_posto || r.posto || __("Sem Posto"), rows: [] });
			grupos.get(key).rows.push(r);
		});
		grupos.forEach((g) => {
			g.rows.sort((a, b) => {
				const s = (VH_SEVERIDADE[a._status] ?? 4) - (VH_SEVERIDADE[b._status] ?? 4);
				return s !== 0 ? s : (a.nome_completo || "").localeCompare(b.nome_completo || "");
			});
		});

		const total = filtradas.length;
		const registados = filtradas.filter((r) => !!r.ja_ausencia_row).length;
		const faltasHoje = filtradas.filter((r) => r._status === "Falta").length;
		this.$root.find(".vh-sum-total b").text(total);
		this.$root.find(".vh-sum-done b").text(registados);
		this.$root.find(".vh-sum-faltas b").text(faltasHoje);

		const $wrap = this.$root.find(".vh-roster").empty();
		const $empty = this.$root.find(".vh-empty");
		$empty.toggleClass("show", grupos.size === 0);
		if (grupos.size === 0) {
			$empty.text(this.rows.length === 0
				? __("Nenhum vigilante escalado para esta data e período.")
				: __("Nenhum vigilante ou posto corresponde à pesquisa."));
		}

		const gruposOrdenados = [...grupos.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
		if (this.viewMode === "table") this._render_table($wrap, gruposOrdenados);
		else this._render_cards($wrap, gruposOrdenados);
	}

	_grupo_aberto(key, rows) {
		const temProblema = rows.some((r) => VH_PROBLEMA.has(r._status));
		return this.userToggledPostos.has(key) ? this.userToggledPostos.get(key) : temProblema;
	}

	_grupo_cov_chip(rows) {
		// A faltas count is a fact (someone filed it) — "X presentes" would imply
		// confirmed attendance we don't actually have (no check-in mechanism;
		// "not marked absent" isn't the same as "seen present").
		const nFalta = rows.filter((r) => r._status === "Falta").length;
		return nFalta ? `<span class="vh-group-cov critical">${nFalta} falta${nFalta > 1 ? "s" : ""}</span>` : "";
	}

	// ---- Cards view ------------------------------------------------------
	_render_cards($wrap, gruposOrdenados) {
		gruposOrdenados.forEach(([key, g]) => {
			const aberto = this._grupo_aberto(key, g.rows);
			const $det = $(`
				<details class="vh-group" ${aberto ? "open" : ""}>
					<summary>
						${this._icon("chev", "vh-chev")}
						<span>${frappe.utils.escape_html(g.label)}</span>
						<span class="vh-group-aside">
							${this._grupo_cov_chip(g.rows)}
							<span class="vh-group-n">${g.rows.length}</span>
						</span>
					</summary>
					<div class="vh-rows"></div>
				</details>
			`).appendTo($wrap);

			$det.on("toggle", () => {
				this.userToggledPostos.set(key, $det.prop("open"));
			});

			const $rows = $det.find(".vh-rows");
			g.rows.forEach((row) => this._render_row($rows, row));
		});
	}

	_render_row($parent, row) {
		const key = row.escala_row;
		const status = row._status;
		const metaLine = status === "Folga"
			? `<span class="vh-folga-lbl">${__("Folga hoje")}</span><span class="dot">·</span>${frappe.utils.escape_html(row.regime || "")}<span class="dot">·</span>${frappe.utils.escape_html(row.delegacao || "")}`
			: `<b>${frappe.utils.escape_html(row.turno || "")}</b><span class="dot">·</span>${frappe.utils.escape_html(row.regime || "")}<span class="dot">·</span>${frappe.utils.escape_html(row.delegacao || "")}`;
		const tel = (row.contacto || "").replace(/\s/g, "");
		const aberto = this.expandedRowKey === key;
		const temAccao = row.ja_proxima_accao && row.ja_proxima_accao !== "Sem Ação";
		const accaoLine = temAccao
			? `<div class="vh-accao-chip">↳ ${frappe.utils.escape_html(row.ja_proxima_accao)}${row.ja_actor_nome ? `: <b>${frappe.utils.escape_html(row.ja_actor_nome)}</b>` : ""}</div>`
			: "";

		const $row = $(`
			<div class="vh-row" data-status="${status}" data-saved="${row.ja_ausencia_row ? "true" : "false"}" data-open="${aberto ? "true" : "false"}">
				<div class="vh-rowhead" tabindex="0">
					<span class="vh-ring"></span>
					<div class="vh-info">
						<div class="vh-idline">
							<span class="vh-name">${frappe.utils.escape_html(row.nome_completo || row.vigilante)}</span>
							<span class="vh-mec">${frappe.utils.escape_html(row.mecanografico || "")}</span>
							${row.categoria ? `<span class="vh-cat">${frappe.utils.escape_html(row.categoria)}</span>` : ""}
							${row.em_licenca ? `<span class="vh-flag">${this._icon("flag")} ${__("Licença aprovada")}</span>` : ""}
						</div>
						<div class="vh-meta">${metaLine}</div>
						${accaoLine}
					</div>
					<div class="vh-right">
						${tel ? `<a class="vh-call" href="tel:${tel}" title="${__("Ligar a {0}", [frappe.utils.escape_html(row.nome_completo || "")])}">${this._icon("phone")}${frappe.utils.escape_html(row.contacto)}</a>` : ""}
						<div class="vh-status">
							<span class="vh-status-txt">${status === "Presente" ? __("Presente") : __(status)}</span>
							<span class="vh-check">${row.ja_ausencia_row ? this._icon("check") : ""}</span>
							<span class="vh-rowchev">${this._icon("chev")}</span>
						</div>
					</div>
				</div>
				<div class="vh-panel"></div>
			</div>
		`).appendTo($parent);

		$row.find(".vh-rowhead").on("click", () => this._toggle_row(key));
		$row.find(".vh-rowhead").on("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._toggle_row(key); }
		});
		$row.find(".vh-call").on("click", (e) => e.stopPropagation());

		if (aberto) this._render_panel($row.find(".vh-panel"), row);
	}

	_toggle_row(key) {
		this.expandedRowKey = this.expandedRowKey === key ? null : key;
		this._render();
	}

	// ---- Table view --------------------------------------------------------
	// Real columns (Vigilante / Mecanográfico / Categoria / Posto / Turno / Regime
	// / Estado / Acção), each a separate <td> — nothing stacked inside one cell.
	// Sortable: click a header to sort by that column (asc → desc → back to the
	// default posto/severity order); click a different header to switch column.
	// Every row action (incl. Ligar) lives in the "⋯" menu.
	_render_table($wrap, gruposOrdenados) {
		let rows;
		if (this.tableSort.campo) {
			const col = VH_TBL_COLS.find((c) => c.key === this.tableSort.campo);
			const dir = this.tableSort.dir === "desc" ? -1 : 1;
			rows = gruposOrdenados.flatMap(([, g]) => g.rows).sort((a, b) => {
				const va = col.val(a), vb = col.val(b);
				if (va < vb) return -1 * dir;
				if (va > vb) return 1 * dir;
				return (a.nome_completo || "").localeCompare(b.nome_completo || "");
			});
		} else {
			rows = gruposOrdenados.flatMap(([, g]) => g.rows);
		}

		const $scroll = $('<div class="vh-tbl-scroll"></div>').appendTo($wrap);
		const $theadRow = $('<tr></tr>');
		VH_TBL_COLS.forEach((col) => {
			const activo = this.tableSort.campo === col.key;
			const icone = activo ? (this.tableSort.dir === "desc" ? "▼" : "▲") : "⇅";
			const $th = $(`
				<th class="vh-tbl-sortable${activo ? " active" : ""}" data-key="${col.key}">
					<span>${__(col.label)}</span>
					<span class="vh-tbl-sort-ico">${icone}</span>
				</th>
			`);
			$th.on("click", () => this._ordenar_tabela(col.key));
			$theadRow.append($th);
		});
		$theadRow.append("<th></th>");

		const $table = $('<table class="vh-tbl"><thead></thead><tbody></tbody></table>').appendTo($scroll);
		$table.find("thead").append($theadRow);
		const $tbody = $table.find("tbody");
		rows.forEach((row) => this._render_table_row($tbody, row));
	}

	_ordenar_tabela(key) {
		if (this.tableSort.campo !== key) {
			this.tableSort = { campo: key, dir: "asc" };
		} else if (this.tableSort.dir === "asc") {
			this.tableSort.dir = "desc";
		} else {
			this.tableSort = { campo: null, dir: "asc" };
		}
		this._render();
	}

	_render_table_row($tbody, row) {
		const status = row._status;
		const postoNome = row.nome_do_posto || row.posto || "";
		const temAccao = row.ja_proxima_accao && row.ja_proxima_accao !== "Sem Ação";
		const accaoLine = temAccao
			? `↳ ${frappe.utils.escape_html(row.ja_proxima_accao)}${row.ja_actor_nome ? `: <b>${frappe.utils.escape_html(row.ja_actor_nome)}</b>` : ""}`
			: "—";
		const tel = (row.contacto || "").replace(/\s/g, "");

		const $tr = $(`
			<tr class="vh-tbl-row" data-status="${status}" style="--pc:${this._posto_color(postoNome)}">
				<td class="vh-tbl-name vh-tbl-stripe">
					${row.em_licenca ? `<span class="vh-tbl-lic" title="${__("Licença aprovada")}">${this._icon("flag")}</span>` : ""}
					${frappe.utils.escape_html(row.nome_completo || row.vigilante)}
				</td>
				<td><span class="vh-tbl-posto-dot"></span>${frappe.utils.escape_html(postoNome || "—")}</td>
				<td>${status === "Folga" ? `<span class="vh-folga-lbl">${__("Folga")}</span>` : frappe.utils.escape_html(row.turno || "—")}</td>
				<td>${frappe.utils.escape_html(row.regime || "—")}</td>
				<td>
					<span class="vh-status-txt">${status === "Presente" ? __("Presente") : __(status)}</span>
					<span class="vh-check">${row.ja_ausencia_row ? this._icon("check") : ""}</span>
				</td>
				<td class="vh-tbl-accao">${accaoLine}</td>
				<td class="mono">${tel ? `<a class="vh-tbl-tel" href="tel:${tel}">${frappe.utils.escape_html(row.contacto)}</a>` : "—"}</td>
				<td class="vh-tbl-menu-cell"><button type="button" class="vh-tbl-menu-btn" title="${__("Acções")}">⋯</button></td>
			</tr>
		`).appendTo($tbody);

		$tr.find(".vh-tbl-menu-btn").on("click", (e) => {
			e.stopPropagation();
			this._abrir_row_menu(e.currentTarget, row);
		});
		$tr.find(".vh-tbl-tel").on("click", (e) => e.stopPropagation());
	}

	// ---- Row actions menu (custom — used by table view) --------------------
	// position:fixed + appended to document.body, same reasoning as the fix
	// already applied to the mark dialog's Link dropdown this session: a table
	// cell is an even tighter overflow context than a modal body, so this can't
	// risk being clipped by an ancestor's overflow.
	_close_menu() {
		if (this._menuEl) { this._menuEl.remove(); this._menuEl = null; }
		if (this._menuOutsideHandler) {
			document.removeEventListener("click", this._menuOutsideHandler, true);
			document.removeEventListener("keydown", this._menuEscHandler, true);
			this._menuOutsideHandler = null;
		}
	}

	_abrir_row_menu(btnEl, row) {
		this._close_menu();
		const isFolga = row._status === "Folga";
		const isSubmetida = row.ja_registado_estado === "Submetido";

		const $menu = $(`<div class="vh-menu${this.theme === "dark" ? " theme-dark" : ""}"></div>`);
		if (isFolga) {
			$menu.append(`<span class="vh-menu-item disabled">${__("Em folga — sem acção disponível")}</span>`);
		} else if (isSubmetida) {
			$menu.append(this._menu_btn(__("Ver Detalhes"), () => this._abrir_detalhes_dialog(row)));
		} else {
			$menu.append(this._menu_btn(row.ja_ausencia_row ? __("Rever Marcação") : __("Marcar Ausência"), () => this._abrir_marcar_dialog(row)));
		}
		$menu.append(`<span class="vh-menu-item disabled">+ ${__("Ocorrência")} <span class="soon">${__("Em breve")}</span></span>`);
		$menu.append(`<span class="vh-menu-item disabled">${__("Ver Histórico")} <span class="soon">${__("Em breve")}</span></span>`);

		$("body").append($menu);
		const rect = btnEl.getBoundingClientRect();
		const largura = $menu.outerWidth();
		const altura = $menu.outerHeight();
		// Clamp on BOTH edges (the earlier version only floored the left bound,
		// so a button near the left of a scrolled-into-view table could still
		// push the menu to hang off past the viewport) and flip above the
		// button when there's no room below.
		let left = rect.right - largura;
		left = Math.max(8, Math.min(left, window.innerWidth - largura - 8));
		let top = rect.bottom + 4;
		if (top + altura > window.innerHeight - 8) top = rect.top - altura - 4;
		top = Math.max(8, top);
		$menu.css({ position: "fixed", top, left });
		this._menuEl = $menu;
		this._menuOutsideHandler = (e) => { if (!$menu[0].contains(e.target) && e.target !== btnEl) this._close_menu(); };
		this._menuEscHandler = (e) => { if (e.key === "Escape") this._close_menu(); };
		setTimeout(() => {
			document.addEventListener("click", this._menuOutsideHandler, true);
			document.addEventListener("keydown", this._menuEscHandler, true);
		}, 0);
	}

	_menu_btn(label, onClick) {
		const $b = $(`<button type="button" class="vh-menu-item">${label}</button>`);
		$b.on("click", () => { this._close_menu(); onClick(); });
		return $b;
	}

	// ============================================================ EXPANDED PANEL
	_render_panel($panel, row) {
		$panel.empty();
		const isFolga = row._status === "Folga";
		const $in = $(`
			<div class="vh-panel-in">
				<div class="vh-profile">
					<div><span class="vh-pf-lbl">${__("Categoria")}</span><span class="vh-pf-val">${frappe.utils.escape_html(row.categoria || "—")}</span></div>
					<div><span class="vh-pf-lbl">${__("Contacto Alternativo")}</span><span class="vh-pf-val mono">${row.contacto_alternativo ? `<a href="tel:${row.contacto_alternativo.replace(/\s/g, "")}">${frappe.utils.escape_html(row.contacto_alternativo)}</a>` : "—"}</span></div>
					<div><span class="vh-pf-lbl">${__("Residência")}</span><span class="vh-pf-val">${frappe.utils.escape_html(row.residencia || "—")}</span></div>
				</div>
				<div class="vh-actions"></div>
			</div>
		`).appendTo($panel);

		const isSubmetida = row.ja_registado_estado === "Submetido";
		const $actions = $in.find(".vh-actions");
		if (isFolga) {
			$actions.append(`<span class="vh-folga-note">${this._icon("info")} ${__("Em folga hoje — sem escala, por isso não há ausência para marcar.")}</span>`);
		} else if (isSubmetida) {
			$actions.append(`<span class="vh-folga-note">${this._icon("info")} ${__("Folha já submetida — só leitura. Use o formulário Ausencias para alterar.")}</span>`);
			const $detBtn = $(`<button class="vh-actbtn primary">${__("Ver Detalhes")}</button>`).appendTo($actions);
			$detBtn.on("click", () => this._abrir_detalhes_dialog(row));
		} else {
			const $markBtn = $(`<button class="vh-actbtn primary">${row.ja_ausencia_row ? __("Rever Marcação") : __("Marcar Ausência")}</button>`).appendTo($actions);
			$markBtn.on("click", () => this._abrir_marcar_dialog(row));
		}
		$actions.append(`<button class="vh-actbtn ghost" title="${__("Em breve — abre a Ocorrência já com este vigilante e posto preenchidos")}">+ ${__("Ocorrência")} <span class="soon">${__("Em breve")}</span></button>`);
		$actions.append(`<button class="vh-actbtn ghost" title="${__("Em breve")}">${__("Ver Histórico")} <span class="soon">${__("Em breve")}</span></button>`);
	}

	// ============================================================ MARK DIALOG
	// A modal (not inline) — but dressed in the same premium deck language as the
	// rest of SIGOS (Ausencias/Rotatividade pill controls, guard-identity header),
	// not bare default Dialog fields. Only the chrome (title bar, footer buttons)
	// is native Frappe; the body is fully custom HTML/CSS, scoped to .vh-dialog-body
	// so it carries its own copy of the page's design tokens (a Dialog mounts at
	// document.body, outside .vh-root, so CSS var() inheritance can't reach it).
	_avatar_html(nome) {
		const limpo = (nome || "").trim();
		const partes = limpo.split(/\s+/).filter(Boolean);
		const ini = partes.length
			? ((partes[0][0] || "") + (partes.length > 1 ? partes[partes.length - 1][0] : "")).toUpperCase()
			: "?";
		let h = 0;
		for (let i = 0; i < limpo.length; i++) h = (h * 31 + limpo.charCodeAt(i)) % 360;
		return `<span class="vh-dg-ava" style="background:hsl(${h},42%,38%)">${frappe.utils.escape_html(ini)}</span>`;
	}

	// ============================================================ DETAILS DIALOG (read-only)
	// For an already-SUBMITTED sheet — no primary/secondary action, no editable
	// controls. Same guard header + visual language as the mark dialog, values
	// shown as plain label:value pairs instead of pill buttons/Link pickers.
	_abrir_detalhes_dialog(row) {
		const meta = [row.mecanografico, row.turno, row.regime, row.nome_do_posto || row.posto].filter(Boolean).join(" · ");
		const val = (v) => (v || v === 0) ? frappe.utils.escape_html(String(v)) : "—";

		const d = new frappe.ui.Dialog({
			title: __("Detalhes da Ausência"), size: "large",
			on_hide: () => { this._dialogOpen = false; },
		});
		this._dialogOpen = true;
		const $body = $(`<div class="vh-dialog-body${this.theme === "dark" ? " theme-dark" : ""}">
			<div class="vh-dg-guard">
				${this._avatar_html(row.nome_completo)}
				<div class="vh-dg-guard-txt">
					<span class="vh-dg-name">${frappe.utils.escape_html(row.nome_completo || row.vigilante)}</span>
					<span class="vh-dg-meta">${frappe.utils.escape_html(meta)}</span>
				</div>
				<span class="vh-dg-submitted-badge">${this._icon("check")} ${__("Submetida")}</span>
			</div>
			<div class="vh-profile vh-dg-fields">
				<div><span class="vh-pf-lbl">${__("Tipo de Ausência")}</span><span class="vh-pf-val">${val(row.ja_tipo_de_ausencia)}</span></div>
				<div><span class="vh-pf-lbl">${__("Subtipo")}</span><span class="vh-pf-val">${val(row.ja_subtipo_falta)}</span></div>
				<div><span class="vh-pf-lbl">${__("Faltas Contadas")}</span><span class="vh-pf-val">${val(row.ja_n_de_faltas)}</span></div>
				<div><span class="vh-pf-lbl">${__("Tipo de Justificação")}</span><span class="vh-pf-val">${val(row.ja_tipo_justificacao)}</span></div>
				<div><span class="vh-pf-lbl">${__("Justificativo")}</span><span class="vh-pf-val">${val(row.ja_jutificativo)}</span></div>
				<div><span class="vh-pf-lbl">${__("Próxima Acção")}</span><span class="vh-pf-val">${val(row.ja_proxima_accao)}</span></div>
				${row.ja_actor_nome ? `<div><span class="vh-pf-lbl">${__("Vigilante Envolvido")}</span><span class="vh-pf-val">${val(row.ja_actor_nome)}</span></div>` : ""}
				<div><span class="vh-pf-lbl">${__("Folha")}</span><span class="vh-pf-val mono">${val(row.ja_ausencia_doc)}</span></div>
			</div>
		</div>`);
		d.$body.html($body);
		d.show();
	}

	_abrir_marcar_dialog(row) {
		const isEdit = !!row.ja_ausencia_row;
		const showSubtipo = !!this.settingsFlags.faltas_normal_vermelha_activo;
		const meta = [row.mecanografico, row.turno, row.regime, row.nome_do_posto || row.posto].filter(Boolean).join(" · ");

		const d = new frappe.ui.Dialog({
			title: isEdit ? __("Rever Marcação") : __("Marcar Ausência"),
			size: "large",
			fields: [{ fieldname: "vh_area", fieldtype: "HTML" }],
			primary_action_label: __("Guardar"),
			primary_action: () => this._validar_e_guardar(d, $body, row, state, controls, showSubtipo),
			on_hide: () => { this._dialogOpen = false; },
		});
		this._dialogOpen = true;

		const $body = d.fields_dict.vh_area.$wrapper;
		$body.addClass("vh-dialog-body");
		if (this.theme === "dark") $body.addClass("theme-dark");
		$body.html(`
			<div class="vh-dg-guard">
				${this._avatar_html(row.nome_completo)}
				<div class="vh-dg-guard-txt">
					<span class="vh-dg-name">${frappe.utils.escape_html(row.nome_completo || row.vigilante)}</span>
					<span class="vh-dg-meta">${frappe.utils.escape_html(meta)}</span>
				</div>
			</div>
			<div>
				<span class="vh-field-lbl">${__("Tipo de Ausência")}</span>
				<div class="vh-pillrow" data-role="tipo"></div>
			</div>
			<div class="vh-sub-row" data-role="subtipo-wrap">
				<span class="vh-field-lbl">${__("Subtipo de Falta")}</span>
				<div class="vh-pillrow" data-role="subtipo"></div>
			</div>
			<div class="vh-2col">
				<div id="vh-dg-justif"></div>
				<div id="vh-dg-nota"></div>
			</div>
			<div>
				<span class="vh-field-lbl">${__("Próxima Acção")}</span>
				<div class="vh-pillrow" data-role="accao"></div>
			</div>
			<div class="vh-actor-row" data-role="actor-wrap">
				<span class="vh-field-lbl" data-role="actor-lbl"></span>
				<div id="vh-dg-actor"></div>
			</div>
			<div class="vh-dg-err" data-role="err"></div>
		`);

		const state = { tipo: row.ja_tipo_de_ausencia || "Falta", subtipo: row.ja_subtipo_falta || null, accao: row.ja_proxima_accao || "Sem Ação" };
		const controls = {};

		VH_TIPOS.forEach((t) => {
			const $b = $(`<button type="button" class="vh-optbtn" data-tipo="${t}">${__(t)}</button>`).appendTo($body.find('[data-role="tipo"]'));
			if (t === state.tipo) $b.addClass("on");
			$b.on("click", () => {
				$body.find('[data-role="tipo"] .vh-optbtn').removeClass("on");
				$b.addClass("on");
				state.tipo = t;
				$body.find('[data-role="subtipo-wrap"]').toggleClass("show", t === "Falta" && showSubtipo);
			});
		});
		$body.find('[data-role="subtipo-wrap"]').toggleClass("show", state.tipo === "Falta" && showSubtipo);
		["Normal", "Vermelha"].forEach((s) => {
			const $b = $(`<button type="button" class="vh-optbtn sm" data-sub="${s}">${__(s)}</button>`).appendTo($body.find('[data-role="subtipo"]'));
			if (s === state.subtipo) $b.addClass("on");
			$b.on("click", () => {
				$body.find('[data-role="subtipo"] .vh-optbtn').removeClass("on");
				$b.addClass("on");
				state.subtipo = s;
			});
		});

		controls.justif = frappe.ui.form.make_control({
			df: { fieldtype: "Link", fieldname: "tipo_justificacao", options: "Tipo De Justificacao", label: __("Tipo de Justificação") },
			parent: $body.find("#vh-dg-justif"), render_input: true,
		});
		if (row.ja_tipo_justificacao) controls.justif.set_value(row.ja_tipo_justificacao);

		controls.nota = frappe.ui.form.make_control({
			df: { fieldtype: "Data", fieldname: "jutificativo", label: __("Justificativo (nota)") },
			parent: $body.find("#vh-dg-nota"), render_input: true,
		});
		if (row.ja_jutificativo) controls.nota.set_value(row.ja_jutificativo);

		// Same per-acção eligibility rules as the Ausencias deck's _mount_picker —
		// NOT a uniform "status = Reserva" pool. Substituto draws from the bench;
		// Dobra/Meia Dobra must already be scheduled at THIS posto today; Horas
		// Extras is any folga guard in the same delegação (any posto); Adiantamento
		// is any active guard already at this same posto.
		const renderActor = (accao) => {
			$body.find("#vh-dg-actor").empty();
			controls.actor = null;
			const campo = VH_ACCAO_CAMPO[accao] || null;
			if (!campo) { $body.find('[data-role="actor-wrap"]').removeClass("show"); return; }
			$body.find('[data-role="actor-wrap"]').addClass("show");
			$body.find('[data-role="actor-lbl"]').text(__("Vigilante"));
			controls.actor = frappe.ui.form.make_control({
				df: {
					fieldtype: "Link", fieldname: campo, options: "Vigilante",
					placeholder: __("Escolher vigilante…"),
					get_query: () => {
						if (campo === "vigilante_substituto") {
							return { query: "sigos.api.get_substitutos_disponiveis", filters: {
								excluir: row.vigilante || "",
								excluir_lista: JSON.stringify([]),
								grupo_delegados: this.state.grupo_delegados || "",
								data: this.state.data || "", periodo: this.state.periodo || "",
								excluir_doc: row.ja_ausencia_doc || "",
							} };
						}
						if (campo === "vigilante_a_dobrar" || campo === "vigilante_a_meia_dobra") {
							return { query: "sigos.api.get_escalados_no_posto_dia", filters: {
								posto: row.posto || "", data: this.state.data,
								excluir: row.vigilante || "",
								excluir_lista: JSON.stringify([]),
								excluir_doc: row.ja_ausencia_doc || "",
							} };
						}
						if (campo === "vigilante_a_horas_extras") {
							return { query: "sigos.api.get_vigilantes_de_folga_na_delegacao_dia", filters: {
								delegacao: row.delegacao || "", data: this.state.data,
								excluir: row.vigilante || "",
								excluir_lista: JSON.stringify([]),
								excluir_doc: row.ja_ausencia_doc || "",
							} };
						}
						// vigilante_a_adiantar — a guard of the same posto, currently active
						return { filters: { posto_de_vigilancia: row.posto || "", status: "Activo", name: ["!=", row.vigilante || ""] } };
					},
				},
				parent: $body.find("#vh-dg-actor"), render_input: true,
			});
			if (row[`ja_${campo}`]) controls.actor.set_value(row[`ja_${campo}`]);
		};
		VH_ACCOES.forEach((a) => {
			const $b = $(`<button type="button" class="vh-optbtn sm" data-accao="${a}">${__(a)}</button>`).appendTo($body.find('[data-role="accao"]'));
			if (a === state.accao) $b.addClass("on");
			$b.on("click", () => {
				$body.find('[data-role="accao"] .vh-optbtn').removeClass("on");
				$b.addClass("on");
				state.accao = a;
				renderActor(a);
			});
		});
		renderActor(state.accao);

		if (isEdit) {
			d.set_secondary_action_label(__("Remover Marcação"));
			d.set_secondary_action(() => {
				frappe.confirm(
					__("Remover a marcação de {0}?", [frappe.utils.escape_html(row.nome_completo || row.vigilante)]),
					() => {
						frappe.call({
							method: "sigos.api.remover_marca_ausencia",
							args: { ausencia_doc: row.ja_ausencia_doc, ausencia_row: row.ja_ausencia_row },
							freeze: true,
							callback: () => {
								d.hide();
								frappe.show_alert({ message: __("Marcação removida."), indicator: "green" }, 4);
								this.refresh();
							},
						});
					}
				);
			});
		}

		d.show();
	}

	// Pre-empt the three server rules that were only being caught AFTER a failed
	// save (subtipo required when Falta+setting on, an actor required once an
	// Acção is chosen, Substituto must actually be Reserva) — same rules, just
	// surfaced inline instead of via a generic error dialog.
	_validar_e_guardar(d, $body, row, state, controls, showSubtipo) {
		const $err = $body.find('[data-role="err"]').text("");
		const campoAccao = VH_ACCAO_CAMPO[state.accao] || null;
		const actorVal = controls.actor ? controls.actor.get_value() : null;

		if (state.tipo === "Falta" && showSubtipo && !state.subtipo) {
			$err.text(__("Seleccione o Subtipo de Falta (Normal ou Vermelha)."));
			return;
		}
		if (campoAccao && !actorVal) {
			$err.text(__("Seleccione o Vigilante para a acção \"{0}\".", [state.accao]));
			return;
		}
		if (campoAccao !== "vigilante_substituto" || !actorVal) {
			this._guardar_marcacao(d, row, state, controls);
			return;
		}
		// Substituto specifically must be a benched Reserva guard — the picker is
		// already scoped to that pool via get_query, but a Link field doesn't
		// refuse a manually-typed valid-but-out-of-pool docname, so double check.
		frappe.db.get_value("Vigilante", actorVal, "status").then((r) => {
			const status = r && r.message && r.message.status;
			if (status !== "Reserva") {
				$err.text(__("O vigilante \"{0}\" não está em Reserva (estado actual: {1}) — só vigilantes em Reserva podem ser Substituto.",
					[actorVal, status || __("desconhecido")]));
				return;
			}
			this._guardar_marcacao(d, row, state, controls);
		});
	}

	_guardar_marcacao(d, row, state, controls, motivo_atraso) {
		const campoAccao = VH_ACCAO_CAMPO[state.accao] || null;
		const actorVal = controls.actor ? controls.actor.get_value() : null;

		const args = {
			vigilante: row.vigilante,
			data: this.state.data,
			periodo: this.state.periodo,
			regime: row.regime,
			turno: row.turno,
			grupo_delegados: this.state.grupo_delegados || null,
			ausencia_row: row.ja_ausencia_row || null,
			tipo_de_ausencia: state.tipo,
			subtipo_falta: state.subtipo || null,
			tipo_justificacao: controls.justif.get_value() || null,
			jutificativo: controls.nota.get_value() || null,
			proxima_accao: state.accao === "Sem Ação" ? null : state.accao,
		};
		if (campoAccao) args[campoAccao] = actorVal;
		if (motivo_atraso) args.motivo_atraso = motivo_atraso;

		frappe.call({
			method: "sigos.api.marcar_ausencia_rapida",
			args,
			freeze: true,
			freeze_message: __("A guardar…"),
			callback: () => {
				d.hide();
				frappe.show_alert({ message: __("Ausência registada."), indicator: "green" }, 4);
				this.refresh();
			},
			error: (r) => {
				const msg = [
					r && r.responseJSON && r.responseJSON.exception,
					r && r.responseJSON && r.responseJSON._server_messages,
					r && r._server_messages,
				].filter(Boolean).join(" | ");
				if (msg.includes("Submissão Tardia") || msg.includes("Motivo do Atraso")) {
					frappe.prompt(
						{ fieldname: "motivo", fieldtype: "Small Text", label: __("Motivo do Atraso"), reqd: 1 },
						(pv) => this._guardar_marcacao(d, row, state, controls, pv.motivo),
						__("Submissão Tardia")
					);
				}
			},
		});
	}

	// ============================================================ CHROME (build/wire/theme)
	_build() {
		this.page.main.addClass("sigos-vhoje");
		this.$root = $(`
			<div class="vh-root">
				<div class="vh-head">
					<div>
						<h1 class="vh-h1">${__("Vigilantes de Hoje")}</h1>
						<p class="vh-sub">${__("Sala de controlo — quem está, quem falta e como contactar, tudo num só lugar. Marcar uma ausência é só mais uma acção aqui.")}</p>
					</div>
					<div class="vh-head-actions">
						<span class="vh-stamp"></span>
						<div class="vh-seg" data-role="view">
							<button data-v="table" class="${this.viewMode === "table" ? "on" : ""}">${__("Tabela")}</button>
							<button data-v="cards" class="${this.viewMode === "cards" ? "on" : ""}">${__("Quadro")}</button>
						</div>
						<button class="vh-theme-btn" title="${__("Alternar tema")}">${this._icon("sun", "i-sun")}${this._icon("moon", "i-moon")}</button>
						<button class="vh-refresh-btn">${__("Actualizar")}</button>
					</div>
				</div>

				<div class="vh-bar">
					<div id="vh-ctrl-data"></div>
					<div class="vh-seg" data-role="periodo">
						<button data-p="Manhã" class="on">${__("Manhã")}</button>
						<button data-p="Noite">${__("Noite")}</button>
					</div>
					<div id="vh-ctrl-grupo"></div>
					<select class="vh-select" data-role="estado-filtro">
						<option value="">${__("Todos os Estados")}</option>
						<option value="Falta">${__("Falta")}</option>
						<option value="Atraso">${__("Atraso")}</option>
						<option value="Saída Antecipada">${__("Saída Antecipada")}</option>
						<option value="Suspensão">${__("Suspensão")}</option>
						<option value="Licença">${__("Licença")}</option>
						<option value="Outro">${__("Outro")}</option>
						<option value="Folga">${__("Folga")}</option>
						<option value="Presente">${__("Presente")}</option>
					</select>
					<select class="vh-select" data-role="posto-filtro">
						<option value="">${__("Todos os Postos")}</option>
					</select>
					<div class="vh-search">
						${this._icon("search")}
						<input type="text" placeholder="${__("Procurar vigilante, mecanográfico ou posto…")}" />
					</div>
				</div>

				<div class="vh-sum">
					<div class="vh-pill tot vh-sum-total"><b class="num">0</b><span>${__("Escalados")}</span></div>
					<div class="vh-pill done vh-sum-done"><b class="num">0</b><span>${__("Já Registados")}</span></div>
					<div class="vh-pill bad vh-sum-faltas"><b class="num">0</b><span>${__("Faltas Hoje")}</span></div>
				</div>

				<div class="vh-roster"></div>
				<div class="vh-empty">${__("Nenhum vigilante ou posto corresponde à pesquisa.")}</div>
			</div>
		`).appendTo(this.page.main);

		this._c_data = frappe.ui.form.make_control({
			df: { fieldtype: "Date", fieldname: "data", onchange: () => {
				const v = this._c_data.get_value();
				if (v && v !== this.state.data) { this.state.data = v; this.refresh(); }
			} },
			parent: this.$root.find("#vh-ctrl-data"), render_input: true,
		});
		this._c_data.set_value(this.state.data);

		this._c_grupo = frappe.ui.form.make_control({
			df: { fieldtype: "Link", fieldname: "grupo_delegados", options: "Grupo De Delegados",
				placeholder: __("Todos os Grupos"),
				onchange: () => {
					const v = this._c_grupo.get_value() || null;
					if (v !== this.state.grupo_delegados) { this.state.grupo_delegados = v; this.refresh(); }
				} },
			parent: this.$root.find("#vh-ctrl-grupo"), render_input: true,
		});
	}

	_wire() {
		this.$root.find('.vh-seg[data-role="periodo"] button').on("click", (e) => {
			const $b = $(e.currentTarget);
			this.$root.find('.vh-seg[data-role="periodo"] button').removeClass("on");
			$b.addClass("on");
			this.state.periodo = $b.data("p");
			this.refresh();
		});
		this.$root.find('.vh-seg[data-role="view"] button').on("click", (e) => {
			const $b = $(e.currentTarget);
			this.$root.find('.vh-seg[data-role="view"] button').removeClass("on");
			$b.addClass("on");
			this.viewMode = $b.data("v");
			localStorage.setItem(this.VIEW_KEY, this.viewMode);
			this._render();
		});
		this.$root.find('[data-role="estado-filtro"]').on("change", (e) => {
			this.state.statusFiltro = e.target.value || null;
			this._render();
		});
		this.$root.find('[data-role="posto-filtro"]').on("change", (e) => {
			this.state.postoFiltro = e.target.value || null;
			this._render();
		});
		this.$root.find(".vh-search input").on("input", frappe.utils.debounce((e) => {
			this.state.busca = e.target.value;
			this._render();
		}, 200));
		this.$root.find(".vh-refresh-btn").on("click", () => this.refresh());
		this.$root.find(".vh-theme-btn").on("click", () => this._toggle_theme());
	}

	_populate_posto_filter() {
		const $sel = this.$root.find('[data-role="posto-filtro"]');
		if (!$sel.length) return;
		const actual = this.state.postoFiltro;
		const postos = [...new Set(this.rows.map((r) => r.nome_do_posto || r.posto).filter(Boolean))].sort();
		$sel.empty().append(`<option value="">${__("Todos os Postos")}</option>`);
		postos.forEach((p) => $sel.append(`<option value="${frappe.utils.escape_html(p)}">${frappe.utils.escape_html(p)}</option>`));
		if (actual && postos.includes(actual)) $sel.val(actual);
		else if (actual) { this.state.postoFiltro = null; }
	}

	_apply_theme() {
		this.page.main.toggleClass("theme-dark", this.theme === "dark");
	}
	_toggle_theme() {
		this.theme = this.theme === "dark" ? "light" : "dark";
		localStorage.setItem(this.THEME_KEY, this.theme);
		this._apply_theme();
	}

	_icon(name, cls) {
		const paths = {
			check: '<path d="M20 6L9 17l-5-5"/>',
			chev: '<path d="M9 6l6 6-6 6"/>',
			flag: '<path d="M12 2v20M12 4h7l-1.5 4L19 12h-7"/>',
			phone: '<path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.362 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0122 16.92z"/>',
			info: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
			search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
			sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
			moon: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
		};
		return `<svg class="${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">${paths[name] || ""}</svg>`;
	}

	_inject_fonts() {
		if (document.getElementById("vh-fonts")) return;
		const l = document.createElement("link");
		l.id = "vh-fonts"; l.rel = "stylesheet";
		l.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";
		document.head.appendChild(l);
	}

	_inject_css() {
		if (document.getElementById("vh-css")) return;
		const css = `
.sigos-vhoje { background:#F4F6FA; transition:background-color .3s ease; }
.layout-main-section-wrapper:has(.sigos-vhoje), .page-body:has(.sigos-vhoje) { background:#F4F6FA; }
.sigos-vhoje.theme-dark { background:#151A24; }
.layout-main-section-wrapper:has(.sigos-vhoje.theme-dark), .page-body:has(.sigos-vhoje.theme-dark) { background:#151A24; }

.vh-root {
  --paper:#F4F6FA; --paper2:#FFFFFF; --paper3:#EEF1F6;
  --ink:#0E1726; --ink2:#5B6B82; --ink3:#93A1B5;
  --line:#E6EAF2; --line2:#D5DCE8;
  --accent:#4F46E5; --accentInk:#4338CA; --accent-soft:rgba(79,70,229,.08);
  --mark:#E8A020; --mark-soft:#FDF1DD;
  --done:#2FA56A; --done-soft:#E4F5EC;
  --falta:#C0392B; --falta-soft:#FBE7E5;
  --folga:#6B7890; --folga-soft:#EEF1F6;
  --danger:#C0392B;
  --shadow:0 1px 2px rgba(14,23,38,.04), 0 4px 14px rgba(14,23,38,.05);
  --r:14px; --r-sm:9px;
  --display:'Space Grotesk',system-ui,sans-serif; --body:'Inter',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
  max-width:100%; padding:20px 20px 80px;
  color:var(--ink); font-family:var(--body); font-size:13.5px; line-height:1.45; -webkit-font-smoothing:antialiased;
}
.sigos-vhoje.theme-dark .vh-root {
  --paper:#151A24; --paper2:#1C2230; --paper3:#242B3B;
  --ink:#EDF1F7; --ink2:#A7B3C6; --ink3:#76839A;
  --line:#2C3444; --line2:#374155;
  --accent:#7B76F0; --accentInk:#9490F5; --accent-soft:rgba(123,118,240,.14);
  --mark:#F0AD4E; --mark-soft:#3A2E14;
  --done:#3FBF7F; --done-soft:#123422;
  --falta:#E0574A; --falta-soft:#3A1917;
  --folga:#8B97AC; --folga-soft:#242B3B;
  --shadow:0 1px 2px rgba(0,0,0,.25), 0 6px 18px rgba(0,0,0,.28);
}
.sigos-vhoje .page-head, .sigos-vhoje + .page-head { display:none; }
.vh-root * { box-sizing:border-box; }
.vh-root .num { font-variant-numeric:tabular-nums; }

.vh-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:16px; }
.vh-h1 { font-family:var(--display); font-weight:600; font-size:26px; letter-spacing:-.02em; margin:0; color:var(--ink); }
.vh-sub { font-size:13px; color:var(--ink2); margin:6px 0 0; max-width:56ch; }
.vh-head-actions { display:flex; align-items:center; gap:8px; }
.vh-stamp { font-size:11px; color:var(--ink3); margin-right:4px; white-space:nowrap; }
.vh-theme-btn, .vh-refresh-btn {
  font-family:var(--body); font-weight:600; border-radius:var(--r-sm); cursor:pointer; transition:.15s;
  background:var(--paper2); border:1px solid var(--line2); color:var(--ink2); box-shadow:var(--shadow);
}
.vh-theme-btn { width:38px; height:38px; display:inline-flex; align-items:center; justify-content:center; padding:0; }
.vh-theme-btn svg { width:16px; height:16px; }
.vh-theme-btn .i-moon { display:none; }
.sigos-vhoje.theme-dark .vh-theme-btn .i-sun { display:none; }
.sigos-vhoje.theme-dark .vh-theme-btn .i-moon { display:block; }
.vh-refresh-btn { font-size:13px; padding:11px 16px; }
.vh-theme-btn:hover, .vh-refresh-btn:hover { border-color:var(--accent); color:var(--accent); }

.vh-bar { background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow);
  padding:14px 16px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
.vh-bar .form-group { margin-bottom:0; }
.vh-bar .control-input-wrapper { min-width:150px; }
.vh-seg { display:flex; gap:3px; background:var(--paper3); border:1px solid var(--line); border-radius:11px; padding:3px; }
.vh-seg button { font-family:var(--body); font-size:12px; font-weight:600; border:0; background:transparent; color:var(--ink2);
  padding:6px 13px; border-radius:8px; cursor:pointer; transition:.15s; }
.vh-seg button.on { background:var(--paper2); color:var(--accent); box-shadow:0 1px 3px rgba(16,23,38,.12); }
.vh-search { display:flex; align-items:center; gap:8px; background:var(--paper3); border:1px solid var(--line2);
  border-radius:var(--r-sm); padding:0 12px; height:34px; flex:1; min-width:200px; }
.vh-search svg { width:13px; height:13px; color:var(--ink3); flex:none; }
.vh-search input { border:0; background:transparent; outline:0; font-family:var(--body); font-size:12.5px; color:var(--ink); width:100%; }
.vh-select { font-family:var(--body); font-size:12.5px; font-weight:600; color:var(--ink2); background:var(--paper3);
  border:1px solid var(--line2); border-radius:var(--r-sm); padding:0 10px; height:34px; cursor:pointer; }
.vh-select:hover { border-color:var(--accent); color:var(--accent); }

.vh-sum { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
.vh-pill { display:flex; align-items:baseline; gap:7px; background:var(--paper2); border:1px solid var(--line);
  border-radius:999px; padding:8px 16px; box-shadow:var(--shadow); }
.vh-pill b { font-family:var(--display); font-size:17px; font-weight:600; }
.vh-pill span { font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink3); font-weight:600; }
.vh-pill.tot b { color:var(--ink); } .vh-pill.done b { color:var(--done); } .vh-pill.bad b { color:var(--falta); }

.vh-roster { display:flex; flex-direction:column; gap:10px; }
.vh-group { background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); overflow:hidden; }
.vh-group summary { list-style:none; cursor:pointer; padding:13px 16px; display:flex; align-items:center; gap:10px;
  font-family:var(--display); font-weight:600; font-size:14.5px; color:var(--ink); user-select:none; }
.vh-group summary::-webkit-details-marker { display:none; }
.vh-group summary svg.vh-chev { width:16px; height:16px; color:var(--ink3); transition:transform .2s ease; flex:none; }
.vh-group[open] summary svg.vh-chev { transform:rotate(90deg); }
.vh-group-aside { margin-left:auto; display:flex; align-items:center; gap:8px; }
.vh-group-n { font-family:var(--body); font-weight:600; font-size:11.5px; color:var(--ink3); background:var(--paper3); border-radius:999px; padding:2px 9px; }
.vh-group-cov { font-family:var(--body); font-weight:700; font-size:11px; border-radius:999px; padding:2px 9px; }
.vh-group-cov.critical { color:var(--falta); background:var(--falta-soft); }
.vh-rows { border-top:1px solid var(--line); }

.vh-row { border-bottom:1px solid var(--line); }
.vh-row:last-child { border-bottom:0; }
.vh-rowhead { display:flex; align-items:flex-start; gap:12px; padding:11px 16px; cursor:pointer; transition:background .12s; }
.vh-rowhead:hover { background:var(--paper3); }
.vh-rowhead:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.vh-ring { width:9px; height:9px; border-radius:50%; flex:none; margin-top:6px; background:var(--paper3); border:2px solid var(--line2); box-shadow:0 0 0 3px var(--paper2); }
.vh-row[data-status="Falta"] .vh-ring, .vh-row[data-status="Suspensão"] .vh-ring { background:var(--falta); border-color:var(--falta); }
.vh-row[data-status="Atraso"] .vh-ring, .vh-row[data-status="Saída Antecipada"] .vh-ring, .vh-row[data-status="Outro"] .vh-ring { background:var(--mark); border-color:var(--mark); }
.vh-row[data-status="Licença"] .vh-ring { background:var(--accentInk); border-color:var(--accentInk); }
.vh-row[data-status="Folga"] .vh-ring { background:var(--folga); border-color:var(--folga); }

.vh-info { flex:1; min-width:0; }
.vh-idline { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.vh-name { font-weight:600; font-size:13.5px; color:var(--ink); }
.vh-mec { font-family:var(--mono); font-size:11px; color:var(--ink3); font-weight:500; }
.vh-cat { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--ink2);
  background:var(--paper3); border:1px solid var(--line2); border-radius:5px; padding:1.5px 6px; }
.vh-meta { font-size:11.5px; color:var(--ink2); margin-top:3px; display:flex; align-items:center; flex-wrap:wrap; }
.vh-meta b { color:var(--ink2); font-weight:600; }
.vh-meta .dot { color:var(--ink3); margin:0 5px; }
.vh-folga-lbl { color:var(--folga); font-weight:700; font-style:italic; }
.vh-flag { display:inline-flex; align-items:center; gap:4px; background:var(--mark-soft); color:var(--mark); font-size:10.5px; font-weight:700; padding:2px 8px 2px 6px; border-radius:999px; }
.vh-flag svg { width:10px; height:10px; }
.vh-accao-chip { font-size:11px; color:var(--ink2); margin-top:3px; }
.vh-accao-chip b { color:var(--ink); font-weight:700; }

.vh-right { display:flex; align-items:center; gap:12px; flex:none; }
.vh-call { display:inline-flex; align-items:center; gap:6px; background:var(--paper3); border:1px solid var(--line2);
  color:var(--ink2); border-radius:999px; padding:5px 11px 5px 9px; font-family:var(--mono); font-size:11.5px; font-weight:600;
  text-decoration:none; transition:.15s; }
.vh-call:hover { background:var(--done-soft); border-color:var(--done); color:var(--done); }
.vh-call svg { width:12px; height:12px; flex:none; }
.vh-status { display:flex; align-items:center; gap:8px; }
.vh-status-txt { font-size:12px; font-weight:600; color:var(--ink3); }
.vh-row[data-status="Falta"] .vh-status-txt, .vh-row[data-status="Suspensão"] .vh-status-txt { color:var(--falta); }
.vh-row[data-status="Atraso"] .vh-status-txt, .vh-row[data-status="Saída Antecipada"] .vh-status-txt, .vh-row[data-status="Outro"] .vh-status-txt { color:var(--mark); }
.vh-row[data-status="Licença"] .vh-status-txt { color:var(--accentInk); }
.vh-row[data-status="Folga"] .vh-status-txt { color:var(--folga); font-style:italic; }
.vh-check svg { width:15px; height:15px; color:var(--done); }
.vh-rowchev svg { width:14px; height:14px; color:var(--ink3); transition:transform .2s ease; }
.vh-row[data-open="true"] .vh-rowchev svg { transform:rotate(90deg); color:var(--accent); }
.vh-row[data-open="true"] .vh-panel { display:block; }
.vh-panel { display:none; }

/* ---- Table view ---------------------------------------------------------
   Scoped under .sigos-vhoje throughout: Frappe's own desk CSS carries table/
   th/td rules that otherwise out-specificity plain .vh-tbl-* class selectors
   and flatten this back to a bare default-looking table. */
.sigos-vhoje .vh-tbl-scroll { overflow-x:auto; border-radius:var(--r); box-shadow:var(--shadow); }
.sigos-vhoje .vh-tbl { width:100%; min-width:820px; border-collapse:separate; border-spacing:0;
  background:var(--paper2); border:1px solid var(--line); border-radius:var(--r); overflow:hidden; }
.sigos-vhoje .vh-tbl thead th {
  position:sticky; top:0; z-index:1; text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:.07em;
  font-weight:700; color:var(--ink2); padding:12px 14px; border-bottom:2px solid var(--line2); background:var(--paper3);
  white-space:nowrap;
}
.sigos-vhoje .vh-tbl-sortable { cursor:pointer; user-select:none; transition:color .13s, background .13s; }
.sigos-vhoje .vh-tbl-sortable:hover { color:var(--accent); background:var(--line); }
.sigos-vhoje .vh-tbl-sortable.active { color:var(--accent); background:var(--accent-soft); }
.sigos-vhoje .vh-tbl-sort-ico { display:inline-block; width:11px; font-size:9px; margin-left:4px; color:var(--ink3); opacity:.6; }
.sigos-vhoje .vh-tbl-sortable.active .vh-tbl-sort-ico { color:var(--accent); opacity:1; font-size:10px; }
.sigos-vhoje .vh-tbl-row td { padding:11px 14px; border-top:1px solid var(--line); font-size:12.5px; color:var(--ink); vertical-align:middle; white-space:nowrap; }
.sigos-vhoje .vh-tbl-row:nth-child(even) td { background:var(--paper3); }
.sigos-vhoje .vh-tbl-row:hover td { background:var(--accent-soft); }
.sigos-vhoje .vh-tbl-row td.mono { font-family:var(--mono); font-size:11.5px; color:var(--ink3); }
.sigos-vhoje .vh-tbl-name { font-weight:600; }
.sigos-vhoje .vh-tbl-stripe { box-shadow:inset 3px 0 0 var(--pc, transparent); }
.sigos-vhoje .vh-tbl-posto-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--pc, var(--ink3)); margin-right:7px; vertical-align:1px; }
.sigos-vhoje .vh-tbl-lic { display:inline-flex; vertical-align:-2px; margin-right:6px; color:var(--mark); }
.sigos-vhoje .vh-tbl-lic svg { width:12px; height:12px; }
.sigos-vhoje .vh-tbl-accao { color:var(--ink2); font-size:11.5px; }
.sigos-vhoje .vh-tbl-accao b { color:var(--ink); font-weight:700; }
.sigos-vhoje .vh-tbl-tel { font-family:var(--mono); font-size:11.5px; color:var(--ink2); text-decoration:none; }
.sigos-vhoje .vh-tbl-tel:hover { color:var(--accent); text-decoration:underline; }
.sigos-vhoje .vh-tbl-row[data-status="Falta"] .vh-status-txt, .sigos-vhoje .vh-tbl-row[data-status="Suspensão"] .vh-status-txt { color:var(--falta); font-weight:700; }
.sigos-vhoje .vh-tbl-row[data-status="Atraso"] .vh-status-txt, .sigos-vhoje .vh-tbl-row[data-status="Saída Antecipada"] .vh-status-txt, .sigos-vhoje .vh-tbl-row[data-status="Outro"] .vh-status-txt { color:var(--mark); font-weight:700; }
.sigos-vhoje .vh-tbl-row[data-status="Licença"] .vh-status-txt { color:var(--accentInk); font-weight:700; }
.sigos-vhoje .vh-tbl-row[data-status="Folga"] .vh-status-txt, .sigos-vhoje .vh-tbl-row[data-status="Folga"] .vh-folga-lbl { color:var(--folga); font-style:italic; }
.sigos-vhoje .vh-tbl-menu-cell { width:1%; text-align:right; }
.sigos-vhoje .vh-tbl-menu-btn {
  font-family:var(--body); font-size:15px; font-weight:700; line-height:1; color:var(--ink2);
  background:var(--paper3); border:1px solid var(--line2); border-radius:var(--r-sm); width:30px; height:26px;
  cursor:pointer; transition:.13s;
}
.sigos-vhoje .vh-tbl-menu-btn:hover { background:var(--accent); border-color:var(--accent); color:#fff; }

/* Custom row-actions menu — position:fixed + appended to document.body, so a
   table cell's overflow can never clip it (same reasoning as the mark dialog's
   Link dropdown fix). Own token copy since it mounts outside .vh-root. */
.vh-menu {
  --paper2:#FFFFFF; --paper3:#EEF1F6; --ink:#0E1726; --ink2:#5B6B82; --line:#E6EAF2; --line2:#D5DCE8;
  --accent:#4F46E5; --falta:#C0392B; --r-sm:9px;
  --display:'Space Grotesk',system-ui,sans-serif; --body:'Inter',system-ui,sans-serif;
  z-index:1071; min-width:190px; background:var(--paper2); border:1px solid var(--line); border-radius:var(--r-sm);
  box-shadow:0 8px 24px rgba(14,23,38,.18); padding:6px; display:flex; flex-direction:column; gap:1px;
}
.vh-menu.theme-dark {
  --paper2:#1C2230; --paper3:#242B3B; --ink:#EDF1F7; --ink2:#A7B3C6; --line:#2C3444; --line2:#374155;
  --accent:#7B76F0; --falta:#E0574A;
}
.vh-menu-item { font-family:var(--body); font-size:12.5px; font-weight:600; color:var(--ink); background:transparent;
  border:0; border-radius:6px; padding:8px 10px; text-align:left; cursor:pointer; text-decoration:none; display:block; }
.vh-menu-item:hover { background:var(--paper3); color:var(--accent); }
.vh-menu-item.disabled { color:var(--ink2); cursor:default; }
.vh-menu-item.disabled:hover { background:transparent; color:var(--ink2); }
.vh-menu-item .soon { font-size:9px; text-transform:uppercase; letter-spacing:.05em; background:var(--paper3); border-radius:999px; padding:1px 6px; margin-left:4px; }

.vh-panel-in { padding:2px 16px 18px 37px; display:flex; flex-direction:column; gap:14px; }
.vh-profile { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; background:var(--paper3); border:1px solid var(--line); border-radius:var(--r-sm); padding:12px 14px; }
.vh-pf-lbl { font-size:9.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--ink3); font-weight:700; display:block; margin-bottom:3px; }
.vh-pf-val { font-size:12.5px; color:var(--ink); font-weight:500; }
.vh-pf-val.mono { font-family:var(--mono); }
.vh-pf-val a { color:var(--ink); text-decoration:none; }
.vh-pf-val a:hover { color:var(--accent); text-decoration:underline; }

.vh-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.vh-actbtn { font-family:var(--body); font-size:12.5px; font-weight:700; border-radius:999px; padding:8px 16px; cursor:pointer; transition:.15s; display:inline-flex; align-items:center; gap:7px; }
.vh-actbtn.primary { background:var(--mark); border:1px solid var(--mark); color:#3a2c05; }
.vh-actbtn.primary:hover { filter:brightness(1.05); }
.vh-actbtn.primary.on { background:var(--ink); border-color:var(--ink); color:var(--paper2); }
.vh-actbtn.ghost { background:transparent; border:1px dashed var(--line2); color:var(--ink3); cursor:default; }
.vh-actbtn.ghost .soon { font-size:9px; text-transform:uppercase; letter-spacing:.05em; background:var(--paper3); border-radius:999px; padding:1px 6px; }
.vh-folga-note { display:inline-flex; align-items:center; gap:7px; font-size:12px; font-weight:600; color:var(--folga);
  background:var(--folga-soft); border:1px solid var(--line2); border-radius:999px; padding:7px 14px 7px 12px; }
.vh-folga-note svg { width:14px; height:14px; flex:none; }

/* Mark dialog body — a Dialog mounts at document.body, outside .vh-root, so the
   design tokens are redefined here rather than inherited. .theme-dark is added
   to this element directly (mirrors the page's own toggle, not a CSS media query). */
.vh-dialog-body {
  --paper:#F4F6FA; --paper2:#FFFFFF; --paper3:#EEF1F6;
  --ink:#0E1726; --ink2:#5B6B82; --ink3:#93A1B5;
  --line:#E6EAF2; --line2:#D5DCE8;
  --accent:#4F46E5; --accentInk:#4338CA;
  --mark:#E8A020; --falta:#C0392B; --folga:#6B7890; --done:#2FA56A; --done-soft:#E4F5EC;
  --r-sm:9px;
  --display:'Space Grotesk',system-ui,sans-serif; --body:'Inter',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
  font-family:var(--body); display:flex; flex-direction:column; gap:14px; padding:2px 2px 6px;
}
.vh-dialog-body.theme-dark {
  --paper:#151A24; --paper2:#1C2230; --paper3:#242B3B;
  --ink:#EDF1F7; --ink2:#A7B3C6; --ink3:#76839A;
  --line:#2C3444; --line2:#374155;
  --accent:#7B76F0; --accentInk:#9490F5;
  --mark:#F0AD4E; --falta:#E0574A; --folga:#8B97AC; --done:#3FBF7F; --done-soft:#123422;
}
/* Link-field dropdowns (awesomplete) are position:absolute and get clipped by
   Frappe's own .modal-body { overflow-y:auto } once a field sits near the bottom
   of a tall dialog — the options render but the lower portion is cut off/unclickable.
   The outer .modal already scrolls the whole dialog when it doesn't fit the
   viewport, so let modal-body size to its content instead of double-scrolling and
   clipping the dropdown out of view. */
.modal:has(.vh-dialog-body) .modal-body { overflow: visible; max-height: none; }
.modal:has(.vh-dialog-body) .awesomplete ul { z-index: 1071; }
.vh-dg-guard { display:flex; align-items:center; gap:12px; padding:12px 14px; background:var(--paper3);
  border:1px solid var(--line); border-radius:var(--r-sm); }
.vh-dg-ava { width:38px; height:38px; border-radius:50%; flex:none; display:flex; align-items:center; justify-content:center;
  color:#fff; font-family:var(--display); font-weight:600; font-size:14px; }
.vh-dg-guard-txt { display:flex; flex-direction:column; gap:2px; min-width:0; }
.vh-dg-name { font-family:var(--display); font-weight:600; font-size:15px; color:var(--ink); }
.vh-dg-meta { font-size:11.5px; color:var(--ink2); }
.vh-dg-submitted-badge { margin-left:auto; display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:700;
  color:var(--done); background:var(--done-soft); border-radius:999px; padding:5px 12px; flex:none; }
.vh-dg-submitted-badge svg { width:12px; height:12px; }
.vh-field-lbl { font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--ink3); font-weight:700; margin-bottom:6px; display:block; }
.vh-pillrow { display:flex; gap:6px; flex-wrap:wrap; }
.vh-optbtn { font-family:var(--body); font-size:12px; font-weight:600; color:var(--ink2); background:var(--paper3);
  border:1px solid var(--line2); border-radius:999px; padding:6px 13px; cursor:pointer; transition:.13s; }
.vh-optbtn:hover { border-color:var(--accent); color:var(--accent); }
.vh-optbtn.on { background:var(--ink); color:var(--paper2); border-color:var(--ink); }
.vh-optbtn[data-tipo="Falta"].on { background:var(--falta); border-color:var(--falta); }
.vh-optbtn[data-tipo="Atraso"].on, .vh-optbtn[data-tipo="Saída Antecipada"].on { background:var(--mark); border-color:var(--mark); color:#3a2c05; }
.vh-optbtn[data-tipo="Licença"].on { background:var(--accentInk); border-color:var(--accentInk); }
.vh-optbtn.sm { padding:5px 11px; font-size:11.5px; }
.vh-2col { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.vh-sub-row, .vh-actor-row { display:none; }
.vh-sub-row.show, .vh-actor-row.show { display:block; animation:vh-dg-fade .15s ease both; }
@keyframes vh-dg-fade { from{ opacity:0; transform:translateY(-3px);} to{ opacity:1; transform:none;} }
.vh-dg-err { color:var(--falta); font-size:12px; font-weight:600; min-height:1em; }
@media (max-width:600px) { .vh-2col { grid-template-columns:1fr; } }

.vh-empty { display:none; padding:34px 16px; text-align:center; color:var(--ink3); font-size:12.5px; background:var(--paper2);
  border:1px solid var(--line); border-radius:var(--r); }
.vh-empty.show { display:block; }

@media (max-width:640px) {
  .vh-profile { grid-template-columns:1fr; }
  .vh-bar { flex-direction:column; align-items:stretch; }
  .vh-rowhead { flex-wrap:wrap; }
}
@media (prefers-reduced-motion: reduce) {
  .sigos-vhoje, .vh-ring, .vh-rowchev svg, .vh-group summary svg.vh-chev { transition:none !important; animation:none !important; }
}
`;
		const style = document.createElement("style");
		style.id = "vh-css";
		style.textContent = css;
		document.head.appendChild(style);
	}
};
