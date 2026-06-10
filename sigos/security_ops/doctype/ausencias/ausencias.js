// AUSENCIAS — inline "Quadro de Ausências".
// Everything happens on the deck: pick Data/Período/Grupo, SEARCH a guard from the
// day's escala and ADD them as an absent card, then handle them in place — Tipo,
// Próxima Acção and the replacement guard (substituto / dobra / adiantamento) are all
// inline. Each absent card = one Tabela Ausencia child row, written live. Validation
// and submit are unchanged.

let _escala_cache = null;
let _escala_cache_key = null;
let _atraso_estado = null;        // null = n/a, "ok" = on time, "tardia" = late

const ACCOES = ["Sem Ação", "Substituto", "Dobra de Turno", "Adiantamento de Turno"];
const ACCAO_FIELD = {
	"Substituto":             "vigilante_substituto",
	"Dobra de Turno":         "vigilante_a_dobrar",
	"Adiantamento de Turno":  "vigilante_a_adiantar",
};
const ACCAO_LABEL = { "Substituto": "Substituto", "Dobra de Turno": "A dobrar", "Adiantamento de Turno": "A adiantar" };
const PICKER_FIELDS = ["vigilante_substituto", "vigilante_a_dobrar", "vigilante_a_adiantar"];

// ─── Main form events ─────────────────────────────────────────────────────────
frappe.ui.form.on("Ausencias", {
	onload(frm) {
		// Pre-pick período from the clock (Manhã <12:00, Noite from 12:00). New docs only.
		if (frm.is_new() && !frm.doc.periodo) frm.set_value("periodo", _periodo_automatico());
		_setup_substituto_query(frm);
	},

	refresh(frm) {
		// The board supersedes the native button, summary AND the child-table grid;
		// the header fields are mounted as controls inside the deck.
		["btn_adicionar_ausencia", "resumo_ausencias", "tabela_ausencia",
		 "data", "periodo", "grupo_delegados", "col_break_1"]
			.forEach(f => frm.set_df_property(f, "hidden", 1));

		_toggle_atraso(frm, !!frm.doc.motivo_atraso);
		_aplicar_permissoes(frm);
		_verificar_horario(frm);
		_render_deck(frm);
		_setup_substituto_query(frm);
	},

	data(frm)            { _invalidar_cache(); _verificar_horario(frm); _render_deck(frm); _refresh_results(frm); },
	periodo(frm)         { _invalidar_cache(); _verificar_horario(frm); _render_deck(frm); _refresh_results(frm); },
	grupo_delegados(frm) { _invalidar_cache(); _render_deck(frm); _refresh_results(frm); },

	before_save(frm) {
		const agora = new Date().toLocaleTimeString("pt-PT", { hour12: false });
		frm.set_value("hora_submissao_tardia", agora);
	},
});

// Child-table events still fire when the board writes via frappe.model.set_value —
// reuse the duplicate checks and the n_de_faltas recompute.
frappe.ui.form.on("Tabela Ausencia", {
	vigilante_substituto(frm, cdt, cdn) { _check_duplicate(frm, cdt, cdn, "vigilante_substituto", __("Este substituto já foi usado noutra linha.")); },
	vigilante_a_dobrar(frm, cdt, cdn)   { _check_duplicate(frm, cdt, cdn, "vigilante_a_dobrar", __("Este vigilante a dobrar já foi usado.")); },
	vigilante_a_adiantar(frm, cdt, cdn) { _check_duplicate(frm, cdt, cdn, "vigilante_a_adiantar", __("Este vigilante a adiantar já foi usado.")); },
	regime(frm, cdt, cdn)               { _set_n_faltas(frm, cdt, cdn); },
	turno(frm, cdt, cdn)                { _set_n_faltas(frm, cdt, cdn); },
});

// ─── Deck: build once, then reconcile cards + stats ───────────────────────────
function _render_deck(frm) {
	_inject_css();
	const w = frm.fields_dict.deck_ausencias?.$wrapper;
	if (!w) return;

	const formEditable = frm.doc.docstatus !== 1 && frm.doc.workflow_state !== "Pendente De Aprovação";
	const $deck = w.find("#sigos-aus-deck");
	const docKey = frm.doc.name || "new";
	if (!$deck.length
		|| $deck.attr("data-editable") !== String(formEditable)
		|| $deck.attr("data-doc") !== docKey) {
		_build_shell(frm, w, formEditable);
	}
	_reconcile_cards(frm, w, formEditable);
	_update_stats(frm, w);
	_update_chip(frm, w);
}

function _build_shell(frm, w, formEditable) {
	w.html(`
		<div id="sigos-aus-deck" data-editable="${formEditable}" data-doc="${frm.doc.name || "new"}">
			<div class="ausd-top">
				<div class="ausd-head"><div class="ausd-title">${__("Folha de Ausências")}</div></div>
				<span data-ausd-chip></span>
			</div>
			<div class="ausd-controls">
				<div class="ausd-field"><label>${__("Data")}</label><div id="ausd-ctrl-data"></div></div>
				<div class="ausd-field"><label>${__("Período")}</label><div id="ausd-ctrl-periodo"></div></div>
				<div class="ausd-field"><label>${__("Grupo De Delegados")}</label><div id="ausd-ctrl-grupo"></div></div>
			</div>
			${formEditable ? `
			<div class="ausb-search">
				<input type="text" class="ausb-search-input" data-search
					placeholder="${__("Pesquisar vigilante na escala para marcar ausente…")}" />
				<div class="ausb-results" data-results></div>
			</div>` : ""}
			<div class="ausb-cards" data-aus-cards></div>
			<div class="ausb-empty" data-aus-empty>${__("Pesquise um vigilante acima para o marcar como ausente.")}</div>
			<div data-ausd-stats></div>
		</div>`);

	_mount_header_controls(frm, w, formEditable);

	if (formEditable) {
		const $inp = w.find("[data-search]");
		$inp.on("input focus", () => _render_results(frm, w, $inp.val() || ""));
		// Enter picks the first match (keyboard-only flow).
		$inp.on("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				w.find("[data-results] .ausb-res").first().trigger("click");
			}
		});
	}
}

// ─── Header controls (Data / Período / Grupo) — two-way bound ─────────────────
function _mount_header_controls(frm, w, formEditable) {
	const ro = formEditable ? 0 : 1;

	const c_data = frappe.ui.form.make_control({
		df: { fieldtype: "Date", fieldname: "data", read_only: ro,
			onchange: () => { const v = c_data.get_value(); if (v !== frm.doc.data) frm.set_value("data", v); } },
		parent: w.find("#ausd-ctrl-data"), render_input: true,
	});
	c_data.set_value(frm.doc.data || frappe.datetime.get_today());

	const c_periodo = frappe.ui.form.make_control({
		df: { fieldtype: "Select", fieldname: "periodo", options: "\nManhã\nNoite", read_only: ro,
			onchange: () => { const v = c_periodo.get_value(); if (v !== frm.doc.periodo) frm.set_value("periodo", v); } },
		parent: w.find("#ausd-ctrl-periodo"), render_input: true,
	});
	c_periodo.set_value(frm.doc.periodo || "");

	const c_grupo = frappe.ui.form.make_control({
		df: { fieldtype: "Link", fieldname: "grupo_delegados", options: "Grupo De Delegados",
			placeholder: __("Todos os grupos"), read_only: ro,
			onchange: () => { const v = c_grupo.get_value(); if ((v || "") !== (frm.doc.grupo_delegados || "")) frm.set_value("grupo_delegados", v || null); } },
		parent: w.find("#ausd-ctrl-grupo"), render_input: true,
	});
	if (frm.doc.grupo_delegados) c_grupo.set_value(frm.doc.grupo_delegados);

	frm._ausd_controls = { data: c_data, periodo: c_periodo, grupo: c_grupo };
}

// ─── Search → add absentees ───────────────────────────────────────────────────
function _ensure_roster(frm) {
	const key = `${frm.doc.data}|${frm.doc.periodo}|${frm.doc.grupo_delegados || ""}`;
	if (_escala_cache && _escala_cache_key === key) return Promise.resolve(_escala_cache);
	if (!frm.doc.data || !frm.doc.periodo) return Promise.resolve(null);
	return frappe.call({
		method: "sigos.api.get_vigilantes_da_escala",
		args: { data: frm.doc.data, periodo: frm.doc.periodo, grupo_delegados: frm.doc.grupo_delegados || null },
	}).then(r => { _escala_cache = r.message || []; _escala_cache_key = key; return _escala_cache; });
}

function _refresh_results(frm) {
	const w = frm.fields_dict.deck_ausencias?.$wrapper;
	if (!w) return;
	const $inp = w.find("[data-search]");
	if ($inp.length) _render_results(frm, w, $inp.val() || "");
}

function _render_results(frm, w, filtro) {
	const $res = w.find("[data-results]");
	if (!$res.length) return;

	const q = (filtro || "").trim().toLowerCase();
	if (!q) { $res.empty(); return; }   // search-only: nothing shown until you type

	if (!frm.doc.data || !frm.doc.periodo) {
		$res.html(`<div class="ausb-res-hint">${__("Defina Data e Período para carregar a escala.")}</div>`);
		return;
	}

	_ensure_roster(frm).then(roster => {
		roster = roster || [];
		if (!roster.length) {
			$res.html(`<div class="ausb-res-hint">${__("Sem escala para esta data/período.")}</div>`);
			return;
		}
		const ja = new Set((frm.doc.tabela_ausencia || []).map(r => r.vigilante));
		const matches = roster
			.filter(v => !ja.has(v.vigilante))
			.filter(v =>
				(v.nome_completo || "").toLowerCase().includes(q) ||
				(v.mecanografico || "").toLowerCase().includes(q) ||
				(v.posto || "").toLowerCase().includes(q))
			.slice(0, 6);

		if (!matches.length) {
			$res.html(`<div class="ausb-res-hint">${__("Nenhum vigilante corresponde.")}</div>`);
			return;
		}

		$res.html(matches.map(v => {
			const meta = [v.mecanografico, v.posto, v.regime, v.turno].filter(Boolean).join(" · ");
			return `<div class="ausb-res" data-vig="${frappe.utils.escape_html(v.vigilante)}">
				<span class="ausb-res-plus">+</span>
				<span class="ausb-res-info"><b>${frappe.utils.escape_html(v.nome_completo || v.vigilante)}</b>
					<span class="ausb-res-meta">${frappe.utils.escape_html(meta)}</span></span>
			</div>`;
		}).join(""));

		$res.find(".ausb-res").on("click", function () {
			const vd = roster.find(v => v.vigilante === $(this).attr("data-vig"));
			if (vd) _add_absent(frm, w, vd);
		});
	});
}

function _add_absent(frm, w, vd) {
	if ((frm.doc.tabela_ausencia || []).some(r => r.vigilante === vd.vigilante)) return;
	const row = frm.add_child("tabela_ausencia");
	row.vigilante         = vd.vigilante;
	row.nome_do_vigilante = vd.nome_completo;
	row.mecanografico     = vd.mecanografico;
	row.posto             = vd.posto;
	row.regime            = vd.regime;
	row.turno             = vd.turno;
	row.periodo           = vd.periodo;
	row.delegacao         = vd.delegacao;
	row.n_de_faltas       = vd.n_de_faltas ?? 1;
	row.tipo_de_ausencia  = "Falta";
	row.proxima_accao     = "Sem Ação";

	frm.dirty();
	_reconcile_cards(frm, w, true);
	_update_stats(frm, w);
	_update_chip(frm, w);

	// Clear the box and refocus for the next deliberate search.
	const $inp = w.find("[data-search]");
	$inp.val("");
	w.find("[data-results]").empty();
	$inp.focus();
}

// ─── Absent cards (reconciled against the child table) ────────────────────────
function _reconcile_cards(frm, w, formEditable) {
	const $cont = w.find("[data-aus-cards]");
	if (!$cont.length) return;
	const rows = frm.doc.tabela_ausencia || [];
	const have = new Set();

	rows.forEach(r => {
		have.add(r.name);
		if (!$cont.find(`[data-cdn="${r.name}"]`).length) _append_card(frm, w, r, formEditable);
	});
	$cont.find("[data-cdn]").each(function () {
		if (!have.has($(this).attr("data-cdn"))) $(this).remove();
	});
	w.find("[data-aus-empty]").toggle(rows.length === 0);
}

function _append_card(frm, w, row, formEditable) {
	const meta = [row.mecanografico, row.regime, row.turno].filter(Boolean).join(" · ");
	const accaoOpts = ACCOES.map(a => `<option value="${a}" ${(row.proxima_accao || "Sem Ação") === a ? "selected" : ""}>${a}</option>`).join("");
	const dis = formEditable ? "" : "disabled";

	const $card = $(`
		<div class="ausb-card" data-cdn="${row.name}">
			<div class="ausb-card-top">
				<div class="ausb-guard">
					<span class="ausb-name">${frappe.utils.escape_html(row.nome_do_vigilante || row.vigilante)}</span>
					<span class="ausb-meta">${row.posto ? `<span class="ausb-posto">${frappe.utils.escape_html(row.posto)}</span>` : ""}${frappe.utils.escape_html(meta)}</span>
				</div>
				<div class="ausb-inline">
					<label class="ausb-f"><span>${__("Justificação")}</span><div class="ausb-justif" data-justif></div></label>
					<label class="ausb-f"><span>${__("Acção")}</span>
						<select class="ausb-sel" data-f="proxima_accao" ${dis}>${accaoOpts}</select></label>
				</div>
				${formEditable ? `<button type="button" class="ausb-remove" title="${__("Remover")}">×</button>` : ""}
			</div>
			<div class="ausb-picker" data-picker></div>
		</div>`).appendTo(w.find("[data-aus-cards]"));

	// Tipo de Justificação — dynamic Link (manage reasons via the Tipo De Justificacao doctype)
	const cj = frappe.ui.form.make_control({
		df: {
			fieldtype: "Link", fieldname: "tipo_justificacao", options: "Tipo De Justificacao",
			placeholder: __("Justificação…"), read_only: formEditable ? 0 : 1,
			get_query: () => ({ filters: { activo: 1 } }),
			onchange: () => {
				const v = cj.get_value();
				if ((v || "") !== (row.tipo_justificacao || "")) frappe.model.set_value(row.doctype, row.name, "tipo_justificacao", v || null);
			},
		},
		parent: $card.find("[data-justif]"), render_input: true,
	});
	if (row.tipo_justificacao) cj.set_value(row.tipo_justificacao);

	$card.find('[data-f="proxima_accao"]').on("change", function () {
		const accao = this.value;
		// changing the action clears any previously chosen replacement guard
		PICKER_FIELDS.forEach(f => { if (row[f]) frappe.model.set_value(row.doctype, row.name, f, null); });
		frappe.model.set_value(row.doctype, row.name, "proxima_accao", accao);
		_mount_picker(frm, w, row, $card, accao, formEditable);
		_update_stats(frm, w);
	});
	$card.find(".ausb-remove").on("click", () => _remove_absent(frm, w, row));

	_mount_picker(frm, w, row, $card, row.proxima_accao || "Sem Ação", formEditable);
}

function _mount_picker(frm, w, row, $card, accao, formEditable) {
	const $slot = $card.find("[data-picker]").empty();
	const field = ACCAO_FIELD[accao];
	if (!field) return;

	const $wrap = $(`<div class="ausb-pick"><span class="ausb-pick-arrow">↳</span>
		<span class="ausb-pick-label">${ACCAO_LABEL[accao]}</span><div class="ausb-pick-ctrl"></div></div>`).appendTo($slot);

	const ctrl = frappe.ui.form.make_control({
		df: {
			fieldtype: "Link", fieldname: field, options: "Vigilante",
			placeholder: __("Escolher vigilante…"), read_only: formEditable ? 0 : 1,
			get_query: () => {
				if (field === "vigilante_substituto")
					return { query: "sigos.api.get_substitutos_disponiveis", filters: { delegacao: row.delegacao || "", excluir: row.vigilante || "" } };
				if (field === "vigilante_a_dobrar")
					// only guards SCHEDULED at this posto on this day can double up
					return { query: "sigos.api.get_escalados_no_posto_dia", filters: { posto: row.posto || "", data: frm.doc.data, excluir: row.vigilante || "" } };
				// vigilante_a_adiantar — a guard of the SAME posto brings their shift forward
				return { filters: { posto_de_vigilancia: row.posto || "", status: "Activo", name: ["!=", row.vigilante || ""] } };
			},
			onchange: () => {
				const v = ctrl.get_value();
				if ((v || "") !== (row[field] || "")) frappe.model.set_value(row.doctype, row.name, field, v || null);
			},
		},
		parent: $wrap.find(".ausb-pick-ctrl"), render_input: true,
	});
	if (row[field]) ctrl.set_value(row[field]);
}

function _remove_absent(frm, w, row) {
	frm.get_field("tabela_ausencia").grid.grid_rows_by_docname[row.name]?.remove?.();
	// fallback: remove from doc directly if grid helper is unavailable
	if ((frm.doc.tabela_ausencia || []).some(r => r.name === row.name)) {
		frm.doc.tabela_ausencia = (frm.doc.tabela_ausencia || []).filter(r => r.name !== row.name);
	}
	frm.dirty();
	w.find(`[data-cdn="${row.name}"]`).remove();
	w.find("[data-aus-empty]").toggle((frm.doc.tabela_ausencia || []).length === 0);
	_update_stats(frm, w);
	_update_chip(frm, w);
	_refresh_results(frm);
}

// ─── Stats + status chip ──────────────────────────────────────────────────────
function _update_stats(frm, w) {
	const rows = frm.doc.tabela_ausencia || [];
	const faltas = rows.reduce((s, r) => s + (r.n_de_faltas || 0), 0);
	const subs   = rows.filter(r => r.proxima_accao === "Substituto").length;
	const dobras = rows.filter(r => r.proxima_accao === "Dobra de Turno").length;
	const adiant = rows.filter(r => r.proxima_accao === "Adiantamento de Turno").length;
	const tile = (n, l, c) => `<div class="ausd-tile ${c || ""}"><span class="n">${n}</span><span class="lbl">${l}</span></div>`;
	const tiles = [
		tile(rows.length, __("ausentes"), "t-aus"),
		tile(faltas, __("faltas"), "t-falta"),
		subs   ? tile(subs,   __("substitutos"), "t-sub") : "",
		dobras ? tile(dobras, __("dobras"),      "t-dob") : "",
		adiant ? tile(adiant, __("adiantam."),   "t-adi") : "",
	].join("");
	const warn = (_atraso_estado === "tardia" && frm.doc.docstatus !== 1)
		? `<div class="ausd-warn">${__("Submissão fora do horário — preencha o <b>Motivo do Atraso</b> antes de gravar.")}</div>` : "";
	w.find("[data-ausd-stats]").html((rows.length ? `<div class="ausd-tiles">${tiles}</div>` : "") + warn);
}

function _update_chip(frm, w) {
	const submitted = frm.doc.docstatus === 1;
	const locked    = frm.doc.workflow_state === "Pendente De Aprovação";
	const ready     = !!(frm.doc.data && frm.doc.periodo);
	let chip;
	if (submitted)                        chip = `<span class="ausd-chip ausd-chip-ok">${__("Submetida")}</span>`;
	else if (locked)                      chip = `<span class="ausd-chip ausd-chip-lock">${__("Pendente de Aprovação")}</span>`;
	else if (!ready)                      chip = `<span class="ausd-chip ausd-chip-wait">${__("Defina data e período")}</span>`;
	else if (_atraso_estado === "tardia") chip = `<span class="ausd-chip ausd-chip-late">${__("Submissão tardia")}</span>`;
	else                                  chip = `<span class="ausd-chip ausd-chip-ok">${__("Dentro do horário")}</span>`;
	w.find("[data-ausd-chip]").html(chip);
}

// ─── Late-submission rule ─────────────────────────────────────────────────────
function _verificar_horario(frm) {
	const limites = { "Manhã": "09:30:00", "Noite": "18:30:00" };
	const limite  = limites[frm.doc.periodo];
	if (!limite) {
		_atraso_estado = null;
		_limpar_alerta(frm);
		frm.set_df_property("motivo_atraso", "reqd", 0);
		_toggle_atraso(frm, !!frm.doc.motivo_atraso);
		return;
	}
	const key = frm.doc.periodo === "Manhã" ? "hora_limite_manha" : "hora_limite_noite";
	frappe.db.get_single_value("SIGOS Settings", key).then(val => {
		const hora_limite = val || limite;
		const agora = new Date().toLocaleTimeString("pt-PT", { hour12: false });
		if (agora > hora_limite) {
			_atraso_estado = "tardia";
			_mostrar_alerta_atraso(frm, agora, hora_limite);
			frm.set_df_property("motivo_atraso", "reqd", 1);
			frm.set_df_property("motivo_atraso", "read_only", 0);
			_toggle_atraso(frm, true);
		} else {
			_atraso_estado = "ok";
			_limpar_alerta(frm);
			frm.set_df_property("motivo_atraso", "reqd", 0);
			_toggle_atraso(frm, !!frm.doc.motivo_atraso);
		}
		const w = frm.fields_dict.deck_ausencias?.$wrapper;
		if (w) { _update_stats(frm, w); _update_chip(frm, w); }
	});
}

function _toggle_atraso(frm, mostrar) {
	["sec_atraso", "alerta_atraso", "motivo_atraso", "col_break_atraso", "hora_submissao_tardia"]
		.forEach(f => frm.set_df_property(f, "hidden", mostrar ? 0 : 1));
}

function _mostrar_alerta_atraso(frm, agora, limite) {
	frm.fields_dict.alerta_atraso.$wrapper.html(`
		<div class="alert alert-warning d-flex align-items-center mb-0" style="border-radius:6px;">
			<span style="font-size:1.2em;margin-right:8px;">⚠️</span>
			<div><strong>${__("Submissão fora do horário")}</strong><br>
				${__("Hora actual")}: <b>${agora}</b> &nbsp;|&nbsp; ${__("Limite")}: <b>${limite}</b><br>
				<small>${__("O campo Motivo do Atraso é obrigatório.")}</small></div>
		</div>`);
}

function _limpar_alerta(frm) { frm.fields_dict.alerta_atraso?.$wrapper.html(""); }

// ─── Permissions ──────────────────────────────────────────────────────────────
function _aplicar_permissoes(frm) {
	const locked = frm.doc.workflow_state === "Pendente De Aprovação";
	frm.fields.forEach(f => {
		const always_rw = ["motivo_atraso"];
		if (locked && !always_rw.includes(f.df.fieldname)) frm.set_df_property(f.df.fieldname, "read_only", 1);
	});
}

function _setup_substituto_query(frm) {
	frm.set_query("vigilante_substituto", "tabela_ausencia", function (doc, cdt, cdn) {
		const row = locals[cdt][cdn];
		return { query: "sigos.api.get_substitutos_disponiveis", filters: { delegacao: row.delegacao || "", excluir: row.vigilante || "" } };
	});
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _invalidar_cache() { _escala_cache = null; _escala_cache_key = null; }

function _periodo_automatico() { return new Date().getHours() < 12 ? "Manhã" : "Noite"; }

function _check_duplicate(frm, cdt, cdn, field, msg) {
	const row = locals[cdt][cdn];
	if (!row[field]) return;
	const dup = (frm.doc.tabela_ausencia || []).some(r => r.name !== row.name && r[field] === row[field]);
	if (dup) {
		frappe.show_alert({ message: msg, indicator: "red" }, 4);
		frappe.model.set_value(cdt, cdn, field, null);
	}
}

function _set_n_faltas(frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	if (!row.regime || !row.turno) return;
	const cached = (_escala_cache || []).find(v => v.vigilante === row.vigilante);
	if (cached?.n_de_faltas != null) { frappe.model.set_value(cdt, cdn, "n_de_faltas", cached.n_de_faltas); return; }
	frappe.db.get_value("Regime Turno Item", { parent: row.regime, turno: row.turno }, "n_de_faltas")
		.then(r => frappe.model.set_value(cdt, cdn, "n_de_faltas", r?.message?.n_de_faltas ?? 1));
}

// ─── Self-injected CSS (ASCII only) ───────────────────────────────────────────
function _inject_css() {
	if (document.getElementById("sigos-aus-deck-css")) return;
	const css = `
#sigos-aus-deck {
	position: sticky; top: 8px; z-index: 6; margin: 0 0 14px; padding: 16px 18px;
	border-radius: 14px; color: #fff;
	background: linear-gradient(135deg, #234a73 0%, #1a3a5c 60%, #14304c 100%);
	box-shadow: 0 8px 24px rgba(20,48,76,.28), inset 0 1px 0 rgba(255,255,255,.08);
	border: 1px solid rgba(255,255,255,.06);
}
#sigos-aus-deck.is-locked { filter: saturate(.7); }
.ausd-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.ausd-title { font-family: var(--sigos-display, system-ui); font-weight: 700; font-size: 1.18em; letter-spacing: .03em; text-transform: uppercase; line-height: 1; }
.ausd-chip { flex: none; padding: 5px 11px; border-radius: 999px; white-space: nowrap; font-size: .72em; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; border: 1px solid transparent; }
.ausd-chip-ok   { background: rgba(47,165,106,.18); color: #8fe6b8; border-color: rgba(47,165,106,.4); }
.ausd-chip-late { background: rgba(224,92,92,.2);  color: #ffb4b4; border-color: rgba(224,92,92,.5); }
.ausd-chip-wait { background: rgba(255,255,255,.1); color: rgba(255,255,255,.75); }
.ausd-chip-lock { background: rgba(232,160,32,.2); color: #f4cd84; border-color: rgba(232,160,32,.45); }
.ausd-controls { display: flex; flex-direction: row; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
.ausd-field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 150px; }
.ausd-field > label { font-size: .7em; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: rgba(255,255,255,.65); margin: 0; }
#sigos-aus-deck .frappe-control { margin: 0 !important; }
#sigos-aus-deck .control-label, #sigos-aus-deck .help-box { display: none !important; }
#sigos-aus-deck .control-input input, #sigos-aus-deck .control-input select, #sigos-aus-deck .control-input .input-with-feedback {
	background: rgba(255,255,255,.96); border: 1px solid rgba(255,255,255,.25); border-radius: 8px; color: #1a3a5c; font-weight: 600; height: 32px;
}
#sigos-aus-deck .control-value, #sigos-aus-deck .like-disabled-input { color: #fff; background: rgba(255,255,255,.08); border-radius: 8px; border-color: rgba(255,255,255,.15); }

/* Search-to-add */
.ausb-search { margin-top: 16px; position: relative; }
.ausb-search-input { width: 100%; height: 36px; border-radius: 9px; border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.96); color: #1a3a5c; font-weight: 600; padding: 0 12px; }
.ausb-search-input::placeholder { color: #97a3b0; font-weight: 500; }
.ausb-results:not(:empty) { margin-top: 8px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 10px; padding: 6px; max-height: 230px; overflow-y: auto; }
.ausb-res-head { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px 8px; font-size: .76em; color: rgba(255,255,255,.65); }
.ausb-addall { background: rgba(232,160,32,.9); color: #1a3a5c; border: none; border-radius: 7px; padding: 4px 10px; font-weight: 700; font-size: .92em; cursor: pointer; }
.ausb-addall:hover { background: #f2b542; }
.ausb-res-hint { padding: 10px 8px; color: rgba(255,255,255,.6); font-size: .84em; font-style: italic; }
.ausb-res { display: flex; align-items: center; gap: 9px; padding: 7px 9px; border-radius: 8px; cursor: pointer; }
.ausb-res:hover { background: rgba(255,255,255,.1); }
.ausb-res-plus { width: 20px; height: 20px; border-radius: 50%; background: rgba(47,165,106,.85); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; flex: none; }
.ausb-res-info { display: flex; flex-direction: column; min-width: 0; font-size: .9em; }
.ausb-res-meta { font-size: .82em; color: rgba(255,255,255,.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Absent cards */
.ausb-cards { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.ausb-empty { margin-top: 14px; color: rgba(255,255,255,.6); font-style: italic; font-size: .86em; }
.ausb-card { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.12); border-left: 3px solid #e05c5c; border-radius: 10px; padding: 11px 13px; }
.ausb-card-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ausb-guard { flex: 1 1 170px; min-width: 0; }
.ausb-name { font-weight: 700; font-size: 1.0em; }
.ausb-meta { display: block; font-size: .78em; color: rgba(255,255,255,.6); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ausb-posto { font-weight: 700; color: #8fd0ff; margin-right: 6px; }
.ausb-justif { min-width: 150px; }
.ausb-remove { background: rgba(255,255,255,.1); border: none; color: #ffb4b4; width: 24px; height: 24px; border-radius: 6px; font-size: 1.1em; line-height: 1; cursor: pointer; flex: none; }
.ausb-remove:hover { background: rgba(224,92,92,.3); }
.ausb-inline { display: flex; gap: 8px; flex: 0 0 auto; }
.ausb-f { display: flex; flex-direction: column; gap: 3px; min-width: 128px; margin: 0; }
.ausb-f > span { font-size: .68em; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: rgba(255,255,255,.6); }
.ausb-sel { height: 32px; border-radius: 8px; border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.96); color: #1a3a5c; font-weight: 600; padding: 0 8px; }
.ausb-picker:not(:empty) { margin-top: 10px; }
.ausb-pick { display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,.16); border-radius: 8px; padding: 7px 10px; }
.ausb-pick-arrow { color: #f4cd84; font-weight: 700; }
.ausb-pick-label { font-size: .76em; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: rgba(255,255,255,.7); white-space: nowrap; }
.ausb-pick-ctrl { flex: 1; }

/* Stats tiles */
.ausd-tiles { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
.ausd-tile { min-width: 84px; padding: 10px 14px; border-radius: 10px; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.1); display: flex; flex-direction: column; gap: 2px; }
.ausd-tile .n { font-family: var(--sigos-display, system-ui); font-weight: 700; font-size: 1.7em; line-height: 1; font-variant-numeric: tabular-nums; }
.ausd-tile .lbl { font-size: .68em; text-transform: uppercase; letter-spacing: .05em; color: rgba(255,255,255,.65); }
.ausd-tile.t-aus .n { color: #ff9d9d; }
.ausd-tile.t-sub .n { color: #8fd0ff; }
.ausd-tile.t-dob .n { color: #f4cd84; }
.ausd-tile.t-adi .n { color: #c6b6ff; }
.ausd-warn { margin-top: 14px; padding: 9px 13px; border-radius: 9px; font-size: .82em; font-weight: 600; background: rgba(224,92,92,.16); border: 1px solid rgba(224,92,92,.4); color: #ffd0d0; }
.ausd-warn b { color: #fff; }
`;
	const s = document.createElement("style");
	s.id = "sigos-aus-deck-css";
	s.textContent = css;
	document.head.appendChild(s);
}
