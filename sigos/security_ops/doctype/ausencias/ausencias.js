// AUSENCIAS — inline "Quadro de Ausências".
// Everything happens on the deck: pick Data/Período/Grupo, SEARCH a guard from the
// day's escala and ADD them as an absent card, then handle them in place — Tipo,
// Próxima Acção and the replacement guard (substituto / dobra / adiantamento) are all
// inline. Each absent card = one Tabela Ausencia child row, written live. Validation
// and submit are unchanged.

let _escala_cache = null;
let _escala_cache_key = null;
let _atraso_estado = null;        // null = n/a, "ok" = on time, "tardia" = late
let _ctx_cache = {};              // "vigilante|data" -> {base, efetivo, dedup, faltas_mes, acum}
let _ctx_doc = null;              // doc the ctx cache belongs to
let _abertos = new Set();         // child-row names currently EXPANDED for editing (per doc)
let _nomes_cache = {};            // vigilante docname -> nome_completo (compact action summary)
let _atraso_restam = null;        // minutes until the cutoff (null when n/a or already late)
let _limites_cache = {};          // SIGOS Settings hora_limite_* (fetched once per session)

const ACCOES = ["Sem Ação", "Substituto", "Dobra de Turno", "Meia Dobra", "Adiantamento de Turno"];
const PERIODO_CLASSE = { "Manhã": "per-manha", "Noite": "per-noite", "Tarde": "per-tarde" };
const ACCAO_FIELD = {
	"Substituto":             "vigilante_substituto",
	"Dobra de Turno":         "vigilante_a_dobrar",
	"Meia Dobra":             "vigilante_a_meia_dobra",
	"Adiantamento de Turno":  "vigilante_a_adiantar",
};
const ACCAO_LABEL = { "Substituto": "Substituto", "Dobra de Turno": "A dobrar", "Meia Dobra": "Meia dobra", "Adiantamento de Turno": "A adiantar" };
const PICKER_FIELDS = ["vigilante_substituto", "vigilante_a_dobrar", "vigilante_a_meia_dobra", "vigilante_a_adiantar"];

// ─── Main form events ─────────────────────────────────────────────────────────
frappe.ui.form.on("Ausencias", {
	onload(frm) {
		// Pre-pick período from the clock (Manhã <12:00, Noite from 12:00). New docs only.
		if (frm.is_new() && !frm.doc.periodo) frm.set_value("periodo", _periodo_automatico());
		_setup_substituto_query(frm);
	},

	refresh(frm) {
		// The board supersedes the native button, summary AND the child-table grid;
		// the header fields are mounted as controls inside the deck. The atraso section
		// is deck-handled too (inline motivo + footer note), so it stays hidden.
		["btn_adicionar_ausencia", "resumo_ausencias", "tabela_ausencia",
		 "data", "periodo", "grupo_delegados", "col_break_1",
		 "sec_atraso", "alerta_atraso", "motivo_atraso", "col_break_atraso", "hora_submissao_tardia"]
			.forEach(f => frm.set_df_property(f, "hidden", 1));

		_aplicar_permissoes(frm);
		_verificar_horario(frm);
		_render_deck(frm);
		_setup_substituto_query(frm);

		// Live clock: the cutoff can pass while the form sits open — re-check every 30s
		// so the chip flips to countdown/late and the motivo field appears in time.
		if (frm._ausd_timer) clearInterval(frm._ausd_timer);
		if (frm.doc.docstatus === 0) {
			frm._ausd_timer = setInterval(() => _verificar_horario(frm), 30000);
		}
	},

	data(frm)            { _invalidar_cache(); _verificar_horario(frm); _render_deck(frm); _refresh_results(frm); },
	periodo(frm)         { _invalidar_cache(); _verificar_horario(frm); _render_deck(frm); _refresh_results(frm); },
	grupo_delegados(frm) { _invalidar_cache(); _render_deck(frm); _refresh_results(frm); },

	before_save(frm) {
		// Stamp the hora ONLY on actually-late saves — on-time docs keep it empty.
		if (_atraso_estado === "tardia") {
			frm.set_value("hora_submissao_tardia", new Date().toLocaleTimeString("pt-PT", { hour12: false }));
		}
	},
});

// Child-table events still fire when the board writes via frappe.model.set_value —
// reuse the duplicate checks and the n_de_faltas recompute.
frappe.ui.form.on("Tabela Ausencia", {
	vigilante_substituto(frm, cdt, cdn) { _check_duplicate(frm, cdt, cdn, "vigilante_substituto", __("Este substituto já foi usado noutra linha.")); },
	vigilante_a_dobrar(frm, cdt, cdn)   { _check_duplicate(frm, cdt, cdn, "vigilante_a_dobrar", __("Este vigilante a dobrar já foi usado.")); },
	vigilante_a_meia_dobra(frm, cdt, cdn) { _check_duplicate(frm, cdt, cdn, "vigilante_a_meia_dobra", __("Este vigilante a meia dobrar já foi usado.")); },
	vigilante_a_adiantar(frm, cdt, cdn) { _check_duplicate(frm, cdt, cdn, "vigilante_a_adiantar", __("Este vigilante a adiantar já foi usado.")); },
	regime(frm, cdt, cdn)               { _set_n_faltas(frm, cdt, cdn); },
	turno(frm, cdt, cdn)                { _set_n_faltas(frm, cdt, cdn); },
});

// ─── Deck: build once, then reconcile cards + stats ───────────────────────────
function _render_deck(frm) {
	_inject_css();
	const w = frm.fields_dict.deck_ausencias?.$wrapper;
	if (!w) return;

	const locked = frm.doc.workflow_state === "Pendente De Aprovação";
	const formEditable = frm.doc.docstatus !== 1 && !locked;
	const $deck = w.find("#sigos-aus-deck");
	const docKey = frm.doc.name || "new";
	// Falta context can change between documents (submitting one affects the next) —
	// scope the cache and the expanded-card state to the open doc.
	if (_ctx_doc !== docKey) { _ctx_cache = {}; _ctx_doc = docKey; _abertos = new Set(); }
	if (!$deck.length
		|| $deck.attr("data-editable") !== String(formEditable)
		|| $deck.attr("data-locked") !== String(locked)
		|| $deck.attr("data-doc") !== docKey) {
		_build_shell(frm, w, formEditable, locked);
	}
	_reconcile_cards(frm, w, formEditable);
	_fetch_contextos(frm, w);
	_update_stats(frm, w);
	_update_chip(frm, w);
	_update_footer(frm, w);
}

function _build_shell(frm, w, formEditable, locked) {
	w.html(`
		<div id="sigos-aus-deck" class="${locked ? "is-locked" : ""}"
			data-editable="${formEditable}" data-locked="${locked}" data-doc="${frm.doc.name || "new"}">
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
					placeholder="${__("Tocar para ver a escala do dia, ou pesquisar…")}" />
				<div class="ausb-results" data-results></div>
			</div>` : ""}
			<div class="ausb-cards" data-aus-cards></div>
			<div class="ausb-empty" data-aus-empty>${__("Toque na pesquisa para ver a escala do dia e marcar os ausentes.")}</div>
			<div data-ausd-stats></div>
			<div data-ausd-footer></div>
		</div>`);

	_mount_header_controls(frm, w, formEditable);

	if (formEditable) {
		const $inp = w.find("[data-search]");
		// Focus with no text shows the FULL day roster grouped by posto (tap-to-add);
		// typing filters it.
		$inp.on("input focus", () => _render_results(frm, w, $inp.val() || ""));
		// Keyboard flow: arrows move the highlight, Enter adds it, Esc closes.
		const mover = (dir) => {
			const $todos = w.find("[data-results] .ausb-res");
			const $sel = $todos.filter(":not(.is-off)");
			if (!$sel.length) return;
			let i = $sel.index($todos.filter(".is-active"));
			i = i < 0 ? (dir > 0 ? 0 : $sel.length - 1)
			          : Math.min(Math.max(i + dir, 0), $sel.length - 1);
			$todos.removeClass("is-active");
			const alvo = $sel.eq(i).addClass("is-active")[0];
			if (alvo && alvo.scrollIntoView) alvo.scrollIntoView({ block: "nearest" });
		};
		$inp.on("keydown", (e) => {
			if (e.key === "ArrowDown") { e.preventDefault(); mover(1); }
			if (e.key === "ArrowUp")   { e.preventDefault(); mover(-1); }
			if (e.key === "Enter") {
				e.preventDefault();
				const $alvo = w.find("[data-results] .ausb-res.is-active:not(.is-off)");
				($alvo.length ? $alvo : w.find("[data-results] .ausb-res:not(.is-off)").first())
					.first().trigger("click");
			}
			if (e.key === "Escape") {
				$inp.val("");
				w.find("[data-results]").empty();
				$inp.blur();
			}
		});
		// Click anywhere outside the search closes the roster panel.
		$(document).off("mousedown.ausdroster").on("mousedown.ausdroster", (e) => {
			if (!$(e.target).closest(".ausb-search").length) w.find("[data-results]").empty();
		});
	}
}

// ─── Header controls (Data / Período / Grupo) — two-way bound ─────────────────
function _mount_header_controls(frm, w, formEditable) {
	// data/periodo/grupo ARE the doc name — editable only while the doc is new
	// (server enforces immutability after creation; shell remounts on first save).
	const ro = (formEditable && frm.is_new()) ? 0 : 1;

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
			placeholder: __("Grupo de delegados…"), reqd: 1, read_only: ro,
			onchange: () => { const v = c_grupo.get_value(); if ((v || "") !== (frm.doc.grupo_delegados || "")) frm.set_value("grupo_delegados", v || null); } },
		parent: w.find("#ausd-ctrl-grupo"), render_input: true,
	});
	if (frm.doc.grupo_delegados) c_grupo.set_value(frm.doc.grupo_delegados);

	frm._ausd_controls = { data: c_data, periodo: c_periodo, grupo: c_grupo };
}

// ─── Search → add absentees ───────────────────────────────────────────────────
function _ensure_roster(frm) {
	const excluir_doc = frm.is_new() ? null : frm.doc.name;
	const key = `${frm.doc.data}|${frm.doc.periodo}|${frm.doc.grupo_delegados || ""}|${excluir_doc || ""}`;
	if (_escala_cache && _escala_cache_key === key) return Promise.resolve(_escala_cache);
	// grupo is mandatory — the roster is ALWAYS scoped to it (a grupo never sees
	// another grupo's guards, so it can never register or block them).
	if (!frm.doc.data || !frm.doc.periodo || !frm.doc.grupo_delegados) return Promise.resolve(null);
	return frappe.call({
		method: "sigos.api.get_vigilantes_da_escala",
		args: {
			data: frm.doc.data, periodo: frm.doc.periodo,
			grupo_delegados: frm.doc.grupo_delegados || null,
			excluir_doc: excluir_doc,
		},
	}).then(r => { _escala_cache = r.message || []; _escala_cache_key = key; return _escala_cache; });
}

function _refresh_results(frm) {
	const w = frm.fields_dict.deck_ausencias?.$wrapper;
	if (!w) return;
	const $inp = w.find("[data-search]");
	if (!$inp.length) return;
	// Only re-render when the roster panel is already open — never pop it open
	// as a side effect of changing Data/Período/Grupo.
	if (!w.find("[data-results]").children().length) return;
	_render_results(frm, w, $inp.val() || "");
}

function _render_results(frm, w, filtro) {
	const $res = w.find("[data-results]");
	if (!$res.length) return;

	const q = (filtro || "").trim().toLowerCase();

	if (!frm.doc.data || !frm.doc.periodo || !frm.doc.grupo_delegados) {
		$res.html(`<div class="ausb-res-hint">${__("Defina Data, Período e Grupo De Delegados para carregar a escala.")}</div>`);
		return;
	}

	_ensure_roster(frm).then(roster => {
		roster = roster || [];
		if (!roster.length) {
			$res.html(`<div class="ausb-res-hint">${__("Sem escala para esta data/período.")}</div>`);
			return;
		}
		const ja = new Set((frm.doc.tabela_ausencia || []).map(r => r.vigilante));
		const match = v => !q
			|| (v.nome_completo || "").toLowerCase().includes(q)
			|| (v.mecanografico || "").toLowerCase().includes(q)
			|| (v.posto || "").toLowerCase().includes(q);

		// Group the roster by posto — the delegado thinks "posto X, who's missing?".
		const grupos = new Map();
		roster.forEach(v => {
			const p = v.posto || __("Sem posto");
			if (!grupos.has(p)) grupos.set(p, []);
			grupos.get(p).push(v);
		});

		let html = "", visiveis = 0;
		[...grupos.keys()].sort((a, b) => a.localeCompare(b)).forEach(posto => {
			const todos = grupos.get(posto);
			const items = todos.filter(match);
			if (!items.length) return;
			visiveis += items.length;

			const ausentes = todos.filter(v => ja.has(v.vigilante) || v.ja_registado_em).length;
			const resumo = ausentes
				? `${todos.length} ${__("escalados")} · ${ausentes} ${__("ausente(s)")}`
				: `${todos.length} ${__("escalados")}`;

			const linhas = items.map(v => {
				const neste = ja.has(v.vigilante);
				const outro = !neste && v.ja_registado_em;
				const licenca = !neste && !outro && v.em_licenca;
				const meta = [v.mecanografico, v.regime].filter(Boolean).join(" · ");
				let tag = "", off = "";
				if (neste) {
					off = "is-off";
					tag = `<span class="ausb-res-tag tag-neste">${__("registado")}</span>`;
				} else if (outro) {
					off = "is-off is-outro";
					tag = `<span class="ausb-res-tag tag-outro">${__("já em")} ${frappe.utils.escape_html(v.ja_registado_em)}</span>`;
				} else if (licenca) {
					// Not blocked — a supervisor may still need to mark Atraso/Suspensão etc.
					// on a leave day; this just flags it before they tap Falta by mistake.
					tag = `<span class="ausb-res-tag tag-licenca">${__("licença")}: ${frappe.utils.escape_html(v.em_licenca)}</span>`;
				}
				return `<div class="ausb-res ${off}" data-vig="${frappe.utils.escape_html(v.vigilante)}">
					${_avatar_html(v.nome_completo || v.vigilante)}
					<span class="ausb-res-info"><b>${frappe.utils.escape_html(v.nome_completo || v.vigilante)}</b>
						<span class="ausb-res-meta">${frappe.utils.escape_html(meta)}</span></span>
					${_turno_chip(v.turno, v.periodo)}
					${tag || `<span class="ausb-res-plus">+</span>`}
				</div>`;
			}).join("");

			html += `<div class="ausb-grp">
				<div class="ausb-grp-head"><span>${frappe.utils.escape_html(posto)}</span>
					<span class="ausb-grp-n">${resumo}</span></div>
				${linhas}
			</div>`;
		});

		if (!visiveis) {
			$res.html(`<div class="ausb-res-hint">${__("Nenhum vigilante corresponde.")}</div>`);
			return;
		}
		$res.html(html);

		$res.find(".ausb-res:not(.is-off)").on("click", function () {
			const vd = roster.find(v => v.vigilante === $(this).attr("data-vig"));
			if (vd) _add_absent(frm, w, vd);
		});
		// Conflicted guards: explain instead of silently ignoring the tap.
		$res.find(".ausb-res.is-outro").on("click", function () {
			const vd = roster.find(v => v.vigilante === $(this).attr("data-vig"));
			if (!vd) return;
			frappe.show_alert({
				message: __("{0} já está registado em {1} ({2}).",
					[vd.nome_completo || vd.vigilante, vd.ja_registado_em, vd.ja_registado_estado]),
				indicator: "orange",
			}, 5);
		});
	});
}

function _add_absent(frm, w, vd) {
	if ((frm.doc.tabela_ausencia || []).some(r => r.vigilante === vd.vigilante)) return;
	if (vd.ja_registado_em) {
		frappe.show_alert({
			message: __("{0} já está registado em {1}.", [vd.nome_completo || vd.vigilante, vd.ja_registado_em]),
			indicator: "orange",
		}, 5);
		return;
	}
	// Soft warning only — a guard with approved leave can still legitimately get
	// an Atraso/Suspensão/Outro row; this just makes sure Falta isn't a mistake.
	if (vd.em_licenca) {
		frappe.show_alert({
			message: __("{0} tem licença aprovada ({1}) neste dia — confirme o Tipo de Ausência.",
				[vd.nome_completo || vd.vigilante, vd.em_licenca]),
			indicator: "orange",
		}, 6);
	}
	// Can't be absent while covering someone else's absence on this sheet.
	const cobre = (frm.doc.tabela_ausencia || []).find(r => PICKER_FIELDS.some(f => r[f] === vd.vigilante));
	if (cobre) {
		frappe.show_alert({
			message: __("{0} já foi escolhido para cobrir a ausência de {1} — remova essa escolha primeiro.",
				[vd.nome_completo || vd.vigilante, cobre.nome_do_vigilante || cobre.vigilante]),
			indicator: "orange",
		}, 6);
		return;
	}
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
	// Accordion: the previous card auto-confirms (it's complete with defaults),
	// the new guard's card opens for editing.
	_confirmar_abertos(frm, w, row.name);
	_abertos.add(row.name);
	_reconcile_cards(frm, w, true);
	_fetch_contextos(frm, w);
	_update_stats(frm, w);
	_update_chip(frm, w);

	// Clear the filter but KEEP the roster open (now with this guard greyed) —
	// the tap-tap-tap flow for marking several absentees in a row.
	const $inp = w.find("[data-search]");
	$inp.val("");
	_render_results(frm, w, "");
	$inp.focus();
}

// ─── Absent cards (reconciled against the child table) ────────────────────────
// Two visual states per row: EXPANDED (being edited — full controls) and COMPACT
// (confirmed — one readable line, pencil to reopen). Pure client-side presentation;
// nothing touches the server until Gravar.
function _reconcile_cards(frm, w, formEditable) {
	const $cont = w.find("[data-aus-cards]");
	if (!$cont.length) return;
	const rows = frm.doc.tabela_ausencia || [];
	const have = new Set();

	rows.forEach(r => {
		have.add(r.name);
		if (!$cont.find(`[data-cdn="${r.name}"]`).length) _rerender_card(frm, w, r, formEditable);
	});
	$cont.find("[data-cdn]").each(function () {
		if (!have.has($(this).attr("data-cdn"))) $(this).remove();
	});
	w.find("[data-aus-empty]").toggle(rows.length === 0);
}

function _rerender_card(frm, w, row, formEditable) {
	const $old = w.find(`[data-aus-cards] [data-cdn="${row.name}"]`);
	const aberta = formEditable && _abertos.has(row.name);
	const $novo = aberta ? _card_aberta(frm, w, row) : _card_compacta(frm, w, row, formEditable);
	// state toggles re-render in place; NEW cards enter at the TOP (newest first —
	// the card being edited is always the first thing under the search)
	if ($old.length) $old.replaceWith($novo);
	else w.find("[data-aus-cards]").prepend($novo);
	_render_badges(frm, $novo, row, _ctx_cache[`${row.vigilante}|${frm.doc.data}`]);
}

// A card is complete when its action doesn't need a replacement guard, or has one.
function _card_completa(row) {
	const campo = ACCAO_FIELD[row.proxima_accao];
	return !campo || !!row[campo];
}

function _abrir_card(frm, w, row) {
	_confirmar_abertos(frm, w, row.name);
	_abertos.add(row.name);
	_rerender_card(frm, w, row, true);
}

function _confirmar_card(frm, w, row) {
	if (!_card_completa(row)) {
		const $c = w.find(`[data-aus-cards] [data-cdn="${row.name}"]`);
		$c.addClass("is-incompleta");
		$c.find("[data-hint-inc]")
			.text(__("Falta escolher o vigilante para a acção \"{0}\".", [row.proxima_accao]))
			.show();
		return false;
	}
	_abertos.delete(row.name);
	_rerender_card(frm, w, row, true);
	return true;
}

// Accordion: collapse every other open card that is complete; incomplete ones stay
// open and turn amber instead of silently losing data.
function _confirmar_abertos(frm, w, exceto) {
	[..._abertos].forEach(cdn => {
		if (cdn === exceto) return;
		const row = (frm.doc.tabela_ausencia || []).find(r => r.name === cdn);
		if (!row) { _abertos.delete(cdn); return; }
		_confirmar_card(frm, w, row);
	});
}

function _nome_vig(v) {
	if (_nomes_cache[v]) return Promise.resolve(_nomes_cache[v]);
	return frappe.db.get_value("Vigilante", v, "nome_completo")
		.then(r => (_nomes_cache[v] = (r && r.message && r.message.nome_completo) || v));
}

// COMPACT: one thin ledger line — ✓ avatar · name · turno chip · posto/mec · badges · acção · pencil/×
function _card_compacta(frm, w, row, formEditable) {
	const accao = row.proxima_accao || "Sem Ação";
	const campo = ACCAO_FIELD[accao];
	const meta = [row.posto, row.mecanografico].filter(Boolean).join(" · ");

	const $el = $(`
		<div class="ausb-card ausb-card-c ${formEditable ? "" : "is-ro"}" data-cdn="${row.name}">
			<span class="ausb-c-check">&#10003;</span>
			${_avatar_html(row.nome_do_vigilante || row.vigilante)}
			<span class="ausb-name">${frappe.utils.escape_html(row.nome_do_vigilante || row.vigilante)}</span>
			${_turno_chip(row.turno, row.periodo)}
			<span class="ausb-c-meta">${frappe.utils.escape_html(meta)}</span>
			<span class="ausb-c-extra">
				<span class="ausb-badges" data-badges></span>
				${row.tipo_justificacao ? `<span class="ausb-bdg bdg-justif">${frappe.utils.escape_html(row.tipo_justificacao)}</span>` : ""}
				${campo && row[campo] ? `<span class="ausb-c-accao">&#8627; ${ACCAO_LABEL[accao]}: <b data-accao-nome>${frappe.utils.escape_html(row[campo])}</b></span>` : ""}
			</span>
			${formEditable ? `
				<button type="button" class="ausb-pencil" title="${__("Editar")}">&#9998;</button>
				<button type="button" class="ausb-remove" title="${__("Remover")}">×</button>` : ""}
		</div>`);

	if (campo && row[campo]) _nome_vig(row[campo]).then(n => $el.find("[data-accao-nome]").text(n));

	if (formEditable) {
		// whole row is the edit target; the pencil is the visual cue
		$el.on("click", (e) => {
			if ($(e.target).closest(".ausb-remove").length) return;
			_abrir_card(frm, w, row);
		});
		$el.find(".ausb-remove").on("click", (e) => { e.stopPropagation(); _remove_absent(frm, w, row); });
	}
	return $el;
}

// EXPANDED: the full editing card, with a confirm ✓ that collapses it.
function _card_aberta(frm, w, row) {
	const meta = [row.mecanografico, row.regime].filter(Boolean).join(" · ");
	const accaoOpts = ACCOES.map(a => `<option value="${a}" ${(row.proxima_accao || "Sem Ação") === a ? "selected" : ""}>${a}</option>`).join("");

	const $card = $(`
		<div class="ausb-card is-aberta" data-cdn="${row.name}">
			<div class="ausb-card-top">
				<div class="ausb-guard">
					${_avatar_html(row.nome_do_vigilante || row.vigilante)}
					<div class="ausb-guard-txt">
						<span class="ausb-name">${frappe.utils.escape_html(row.nome_do_vigilante || row.vigilante)}</span>
						<span class="ausb-meta">${row.posto ? `<span class="ausb-posto">${frappe.utils.escape_html(row.posto)}</span>` : ""}${frappe.utils.escape_html(meta)} ${_turno_chip(row.turno, row.periodo)}</span>
						<span class="ausb-badges" data-badges></span>
					</div>
				</div>
				<div class="ausb-inline">
					<label class="ausb-f"><span>${__("Justificação")}</span><div class="ausb-justif" data-justif></div></label>
					<label class="ausb-f"><span>${__("Acção")}</span>
						<select class="ausb-sel" data-f="proxima_accao">${accaoOpts}</select></label>
				</div>
				<button type="button" class="ausb-confirm" title="${__("Confirmar")}">&#10003;</button>
				<button type="button" class="ausb-remove" title="${__("Remover")}">×</button>
			</div>
			<div class="ausb-picker" data-picker></div>
			<div class="ausb-hint-inc" data-hint-inc style="display:none"></div>
		</div>`);

	// Tipo de Justificação — dynamic Link (manage reasons via the Tipo De Justificacao doctype)
	const cj = frappe.ui.form.make_control({
		df: {
			fieldtype: "Link", fieldname: "tipo_justificacao", options: "Tipo De Justificacao",
			placeholder: __("Justificação…"),
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
		_mount_picker(frm, w, row, $card, accao, true);
		if (_card_completa(row)) { $card.removeClass("is-incompleta"); $card.find("[data-hint-inc]").hide(); }
		_update_stats(frm, w);
	});
	$card.find(".ausb-confirm").on("click", () => _confirmar_card(frm, w, row));
	$card.find(".ausb-remove").on("click", () => _remove_absent(frm, w, row));

	_mount_picker(frm, w, row, $card, row.proxima_accao || "Sem Ação", true);
	return $card;
}

// ─── Falta context badges (weight + month cumulative) ─────────────────────────
function _render_badges(frm, $card, row, ctx) {
	const $b = $card.find("[data-badges]");
	if (!$b.length) return;
	const n = (ctx ? ctx.efetivo : row.n_de_faltas) ?? 1;
	const dedup = !!(ctx && ctx.dedup);
	let html = `<span class="ausb-bdg ${dedup ? "bdg-dedup" : "bdg-peso"}"
		title="${dedup
			? __("Turno consecutivo — as folgas já foram contadas na falta anterior")
			: __("Peso desta falta no regime")}">
		${__("conta")} <b>${n}</b> ${n === 1 ? __("falta") : __("faltas")}${dedup ? " · " + __("consecutiva") : ""}</span>`;
	if (ctx && ctx.acum != null) {
		html += `<span class="ausb-bdg bdg-mes" title="${__("Faltas acumuladas no mês, incluindo esta")}">
			<b>${ctx.acum}</b> ${__("no mês")}</span>`;
	}
	$b.html(html);
}

function _fetch_contextos(frm, w) {
	// Batch-fetch effective weight + month cumulative for cards that lack it.
	if (frm.doc.docstatus === 2 || !frm.doc.data) return;
	const rows = (frm.doc.tabela_ausencia || []).filter(r => r.vigilante);
	const render_all = () => rows.forEach(r => {
		const ctx = _ctx_cache[`${r.vigilante}|${frm.doc.data}`];
		const $card = w.find(`[data-cdn="${r.name}"]`);
		if ($card.length && ctx) _render_badges(frm, $card, r, ctx);
	});

	const pend = rows.filter(r => !_ctx_cache[`${r.vigilante}|${frm.doc.data}`]);
	if (!pend.length) { render_all(); return; }

	frappe.call({
		method: "sigos.api.get_contexto_faltas",
		args: {
			data: frm.doc.data,
			linhas: pend.map(r => ({ vigilante: r.vigilante, regime: r.regime, turno: r.turno })),
		},
	}).then(r => {
		const map = r.message || {};
		Object.entries(map).forEach(([vig, ctx]) => {
			// faltas_mes counts only SUBMITTED absences — add this one unless we ARE submitted.
			ctx.acum = (ctx.faltas_mes || 0) + (frm.doc.docstatus === 1 ? 0 : ctx.efetivo);
			_ctx_cache[`${vig}|${frm.doc.data}`] = ctx;
		});
		// Stamp the effective weight on rows not yet saved (server re-stamps at save anyway);
		// saved rows already hold the save-time effective value — don't dirty the form.
		pend.forEach(r => {
			const ctx = map[r.vigilante];
			if (ctx && r.__islocal && r.n_de_faltas !== ctx.efetivo) {
				frappe.model.set_value(r.doctype, r.name, "n_de_faltas", ctx.efetivo);
			}
		});
		render_all();
		_update_stats(frm, w);
	});
}

// Guards unavailable as replacements for `row`: everyone marked absent in this doc
// plus replacements already chosen on OTHER rows (one guard covers one absence).
function _indisponiveis(frm, row) {
	const out = new Set();
	(frm.doc.tabela_ausencia || []).forEach(r => {
		if (r.vigilante) out.add(r.vigilante);
		if (r.name !== row.name) PICKER_FIELDS.forEach(f => { if (r[f]) out.add(r[f]); });
	});
	return [...out];
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
				const fora = _indisponiveis(frm, row);
				if (field === "vigilante_substituto")
					// reserves scoped to THIS grupo's delegações — minus guards already
					// absent or covering, here or elsewhere this day/período
					return { query: "sigos.api.get_substitutos_disponiveis", filters: {
						excluir: row.vigilante || "",
						excluir_lista: JSON.stringify(fora),
						grupo_delegados: frm.doc.grupo_delegados || "",
						data: frm.doc.data || "", periodo: frm.doc.periodo || "",
						excluir_doc: frm.is_new() ? "" : frm.doc.name,
					} };
				if (field === "vigilante_a_dobrar" || field === "vigilante_a_meia_dobra")
					// only guards SCHEDULED at this posto on this day can double up —
					// minus this sheet's absentees/replacements and submitted absentees
					// (Meia Dobra reuses the same pool as a full Dobra — same real-world
					// situation, just priced for half a shift in payroll)
					return { query: "sigos.api.get_escalados_no_posto_dia", filters: {
						posto: row.posto || "", data: frm.doc.data,
						excluir: row.vigilante || "",
						excluir_lista: JSON.stringify(fora),
						excluir_doc: frm.is_new() ? "" : frm.doc.name,
					} };
				// vigilante_a_adiantar — a guard of the SAME posto brings their shift forward
				return { filters: {
					posto_de_vigilancia: row.posto || "", status: "Activo",
					name: ["not in", [...fora, row.vigilante || ""]],
				} };
			},
			onchange: () => {
				const v = ctrl.get_value();
				if ((v || "") !== (row[field] || "")) frappe.model.set_value(row.doctype, row.name, field, v || null);
				if (v) { $card.removeClass("is-incompleta"); $card.find("[data-hint-inc]").hide(); }
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
	_abertos.delete(row.name);
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
	const meias  = rows.filter(r => r.proxima_accao === "Meia Dobra").length;
	const adiant = rows.filter(r => r.proxima_accao === "Adiantamento de Turno").length;
	const tile = (n, l, c) => `<div class="ausd-tile ${c || ""}"><span class="n">${n}</span><span class="lbl">${l}</span></div>`;
	const tiles = [
		tile(rows.length, __("ausentes"), "t-aus"),
		tile(faltas, __("faltas"), "t-falta"),
		subs   ? tile(subs,   __("substitutos"), "t-sub") : "",
		dobras ? tile(dobras, __("dobras"),      "t-dob") : "",
		meias  ? tile(meias,  __("meias dobras"), "t-mdb") : "",
		adiant ? tile(adiant, __("adiantam."),   "t-adi") : "",
	].join("");
	const warn = (_atraso_estado === "tardia" && frm.doc.docstatus !== 1)
		? `<div class="ausd-warn">${__("Submissão fora do horário — preencha o <b>Motivo do Atraso</b> abaixo antes de gravar.")}</div>` : "";
	w.find("[data-ausd-stats]").html((rows.length ? `<div class="ausd-tiles">${tiles}</div>` : "") + warn);
	// Every mutation path lands here — keep the footer CTA label (Gravar/Submeter) in step.
	_update_footer(frm, w);
}

function _update_chip(frm, w) {
	const submitted = frm.doc.docstatus === 1;
	const locked    = frm.doc.workflow_state === "Pendente De Aprovação";
	const ready     = !!(frm.doc.data && frm.doc.periodo && frm.doc.grupo_delegados);
	let chip;
	if (submitted)                        chip = `<span class="ausd-chip ausd-chip-ok">${__("Submetida")}</span>`;
	else if (locked)                      chip = `<span class="ausd-chip ausd-chip-lock">${__("Pendente de Aprovação")}</span>`;
	else if (!ready)                      chip = `<span class="ausd-chip ausd-chip-wait">${__("Defina data, período e grupo")}</span>`;
	else if (_atraso_estado === "tardia") chip = `<span class="ausd-chip ausd-chip-late">${__("Submissão tardia")}</span>`;
	else if (_atraso_estado === "ok" && _atraso_restam != null && _atraso_restam <= 30)
		chip = `<span class="ausd-chip ausd-chip-soon">${__("Faltam {0} min", [_atraso_restam])}</span>`;
	else                                  chip = `<span class="ausd-chip ausd-chip-ok">${__("Dentro do horário")}</span>`;
	w.find("[data-ausd-chip]").html(chip);
}

// ─── Deck footer: motivo do atraso inline + finish-in-canvas CTA ──────────────
function _update_footer(frm, w) {
	const $f = w.find("[data-ausd-footer]");
	if (!$f.length) return;

	const locked = frm.doc.workflow_state === "Pendente De Aprovação";
	const tardia = _atraso_estado === "tardia" && frm.doc.docstatus === 0 && !locked;
	const sig = `${frm.doc.docstatus}|${locked}|${tardia}`;

	if ($f.attr("data-sig") !== sig) {
		$f.attr("data-sig", sig).empty();

		if (frm.doc.docstatus !== 0 || locked) {
			// Read-only: just document the late submission, if there was one.
			if (frm.doc.motivo_atraso) {
				$f.html(`<div class="ausd-late-note">${__("Submissão tardia")}${
					frm.doc.hora_submissao_tardia ? " · " + frappe.utils.escape_html(frm.doc.hora_submissao_tardia) : ""
				} — ${frappe.utils.escape_html(frm.doc.motivo_atraso)}</div>`);
			}
		} else {
			if (tardia) {
				const $m = $(`<div class="ausd-motivo"><label>${__("Motivo do Atraso")}</label>
					<div data-motivo-ctrl></div></div>`).appendTo($f);
				const cm = frappe.ui.form.make_control({
					df: { fieldtype: "Small Text", fieldname: "motivo_atraso",
						placeholder: __("Porque é que o registo está a ser feito fora do horário?"),
						onchange: () => {
							const v = cm.get_value();
							if ((v || "") !== (frm.doc.motivo_atraso || "")) frm.set_value("motivo_atraso", v);
						} },
					parent: $m.find("[data-motivo-ctrl]"), render_input: true,
				});
				cm.set_value(frm.doc.motivo_atraso || "");
			}
			const $row = $(`<div class="ausd-cta-row"><button type="button" class="ausd-cta" data-cta></button></div>`)
				.appendTo($f);
			$row.find("[data-cta]").on("click", () => _cta_click(frm));
		}
	}

	// Label tracks dirty/clean state on every repaint (no DOM rebuild → no lost focus).
	const $btn = $f.find("[data-cta]");
	if ($btn.length) $btn.text(_cta_label(frm));
}

function _tem_workflow(frm) {
	return frappe.meta.has_field("Ausencias", "workflow_state");
}

function _cta_label(frm) {
	if (frm.is_new() || frm.is_dirty()) return __("Gravar");
	return _tem_workflow(frm) ? __("Enviar para Aprovação") : __("Submeter");
}

function _cta_click(frm) {
	if (frm.is_new() || frm.is_dirty()) { frm.save(); return; }
	if (frm.doc.docstatus !== 0) return;
	if (_tem_workflow(frm)) {
		frappe.xcall("frappe.model.workflow.get_transitions", { doc: frm.doc }).then(ts => {
			if (!ts || !ts.length) {
				frappe.show_alert({ message: __("Sem acções de workflow disponíveis para si."), indicator: "orange" }, 5);
				return;
			}
			frappe.xcall("frappe.model.workflow.apply_workflow", { doc: frm.doc, action: ts[0].action })
				.then(() => frm.reload_doc());
		});
	} else {
		frm.savesubmit();
	}
}

// ─── Visual helpers: avatar initials + periodo-coloured turno chip ────────────
function _avatar_html(nome) {
	const limpo = (nome || "").trim();
	const partes = limpo.split(/\s+/).filter(Boolean);
	const ini = partes.length
		? ((partes[0][0] || "") + (partes.length > 1 ? partes[partes.length - 1][0] : "")).toUpperCase()
		: "?";
	let h = 0;
	for (let i = 0; i < limpo.length; i++) h = (h * 31 + limpo.charCodeAt(i)) % 360;
	return `<span class="ausb-ava" style="background:hsl(${h},42%,38%)">${frappe.utils.escape_html(ini)}</span>`;
}

function _turno_chip(turno, periodo) {
	if (!turno) return "";
	return `<span class="ausb-chip ${PERIODO_CLASSE[periodo] || "per-outro"}">${frappe.utils.escape_html(turno)}</span>`;
}

// ─── Late-submission rule (live — re-run by a 30s timer while the form is open) ─
function _verificar_horario(frm) {
	const padrao = { "Manhã": "09:30:00", "Noite": "18:30:00" };
	const limite_padrao = padrao[frm.doc.periodo];
	if (!limite_padrao) {
		_atraso_estado = null;
		_atraso_restam = null;
		_pintar_estado(frm);
		return;
	}
	const key = frm.doc.periodo === "Manhã" ? "hora_limite_manha" : "hora_limite_noite";

	const aplicar = (hora_limite) => {
		// numeric compare — the setting may arrive as "9:30:00" (timedelta serialized
		// without leading zero), which breaks string comparison
		const agora = new Date();
		const agora_s = agora.getHours() * 3600 + agora.getMinutes() * 60 + agora.getSeconds();
		const limite_s = _segundos(hora_limite);
		if (agora_s > limite_s) {
			_atraso_estado = "tardia";
			_atraso_restam = null;
		} else {
			_atraso_estado = "ok";
			_atraso_restam = Math.max(0, Math.ceil((limite_s - agora_s) / 60));
		}
		_pintar_estado(frm);
	};

	if (_limites_cache[key]) { aplicar(_limites_cache[key]); return; }
	frappe.db.get_single_value("SIGOS Settings", key).then(val => {
		_limites_cache[key] = val || limite_padrao;
		aplicar(_limites_cache[key]);
	});
}

function _segundos(hms) {
	const p = String(hms || "0:0:0").split(":");
	return (+p[0] || 0) * 3600 + (+p[1] || 0) * 60 + (+p[2] || 0);
}

function _pintar_estado(frm) {
	const w = frm.fields_dict.deck_ausencias?.$wrapper;
	if (w) { _update_stats(frm, w); _update_chip(frm, w); _update_footer(frm, w); }
}

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
		return { query: "sigos.api.get_substitutos_disponiveis", filters: {
			excluir: row.vigilante || "",
			excluir_lista: JSON.stringify(_indisponiveis(frm, row)),
			grupo_delegados: frm.doc.grupo_delegados || "",
			data: frm.doc.data || "", periodo: frm.doc.periodo || "",
			excluir_doc: frm.is_new() ? "" : frm.doc.name,
		} };
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
.ausd-chip-soon { background: rgba(232,160,32,.2); color: #f4cd84; border-color: rgba(232,160,32,.45); animation: ausd-soon 2s ease-in-out infinite; }
@keyframes ausd-soon { 50% { opacity: .55; } }
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
.ausb-results:not(:empty) { margin-top: 8px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 10px; padding: 6px; max-height: 340px; overflow-y: auto; }
.ausb-grp { margin: 2px 0 6px; }
.ausb-grp + .ausb-grp { border-top: 1px solid rgba(255,255,255,.08); padding-top: 4px; }
.ausb-grp-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 8px 4px; font-size: .72em; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #8fd0ff; }
.ausb-grp-n { color: rgba(255,255,255,.55); font-weight: 600; text-transform: none; letter-spacing: 0; white-space: nowrap; }
.ausb-res.is-off { opacity: .55; cursor: default; }
.ausb-res.is-off:hover { background: transparent; }
.ausb-res.is-off .ausb-res-plus { background: rgba(255,255,255,.18); }
.ausb-res.is-outro { cursor: pointer; }
.ausb-res.is-outro:hover { background: rgba(232,160,32,.08); }
.ausb-res-tag { flex: none; margin-left: auto; font-size: .66em; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.tag-neste { background: rgba(255,255,255,.12); color: rgba(255,255,255,.7); }
.tag-outro { background: rgba(232,160,32,.2); color: #f4cd84; border: 1px solid rgba(232,160,32,.4); }
.tag-licenca { background: rgba(90,140,220,.2); color: #a8c8f0; border: 1px solid rgba(90,140,220,.4); }
.ausb-res-head { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px 8px; font-size: .76em; color: rgba(255,255,255,.65); }
.ausb-addall { background: rgba(232,160,32,.9); color: #1a3a5c; border: none; border-radius: 7px; padding: 4px 10px; font-weight: 700; font-size: .92em; cursor: pointer; }
.ausb-addall:hover { background: #f2b542; }
.ausb-res-hint { padding: 10px 8px; color: rgba(255,255,255,.6); font-size: .84em; font-style: italic; }
.ausb-res { display: flex; align-items: center; gap: 9px; padding: 7px 9px; border-radius: 8px; cursor: pointer; }
.ausb-res:hover { background: rgba(255,255,255,.1); }
.ausb-res.is-active { background: rgba(255,255,255,.14); outline: 1px solid rgba(255,255,255,.3); }
.ausb-res-plus { width: 22px; height: 22px; border-radius: 50%; background: rgba(47,165,106,.85); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; flex: none; }
.ausb-res-info { display: flex; flex-direction: column; min-width: 0; font-size: .9em; flex: 1; }
.ausb-res-meta { font-size: .82em; color: rgba(255,255,255,.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Absent cards */
.ausb-cards { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.ausb-empty { margin-top: 14px; color: rgba(255,255,255,.6); font-style: italic; font-size: .86em; }
.ausb-card { position: relative; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.12); border-left: 3px solid #e05c5c; border-radius: 10px; padding: 11px 13px; }
.ausb-card-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ausb-guard { flex: 1 1 190px; min-width: 0; display: flex; gap: 10px; align-items: flex-start; }
.ausb-guard-txt { min-width: 0; flex: 1; }
.ausb-name { font-weight: 700; font-size: 1.0em; }
.ausb-meta { display: block; font-size: .78em; color: rgba(255,255,255,.6); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ausb-posto { font-weight: 700; color: #8fd0ff; margin-right: 6px; }
.ausb-badges { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.ausb-bdg { font-size: .68em; font-weight: 700; padding: 2px 8px; border-radius: 999px; letter-spacing: .03em; white-space: nowrap; }
.ausb-bdg b { font-variant-numeric: tabular-nums; }
.bdg-peso  { background: rgba(224,92,92,.18); color: #ffb4b4; border: 1px solid rgba(224,92,92,.4); }
.bdg-dedup { background: rgba(47,165,106,.16); color: #8fe6b8; border: 1px solid rgba(47,165,106,.4); }
.bdg-mes   { background: rgba(255,255,255,.1); color: rgba(255,255,255,.78); border: 1px solid rgba(255,255,255,.16); }

/* Avatar initials + periodo-coloured turno chips (same language as the escala grid) */
.ausb-ava { width: 30px; height: 30px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: .76em; color: #fff; letter-spacing: .02em; box-shadow: inset 0 -2px 4px rgba(0,0,0,.22), 0 1px 2px rgba(0,0,0,.2); }
.ausb-res .ausb-ava { width: 28px; height: 28px; }
.ausb-chip { display: inline-block; vertical-align: middle; padding: 2px 9px; border-radius: 999px; font-size: .86em; font-weight: 700; color: #fff; letter-spacing: .03em; white-space: nowrap; flex: none; box-shadow: inset 0 1px 0 rgba(255,255,255,.18); }
.ausb-res .ausb-chip { font-size: .72em; }
.per-manha { background: linear-gradient(180deg, #62a2e2 0%, #3a7ec5 100%); }
.per-noite { background: linear-gradient(180deg, #3b5074 0%, #212f44 100%); border: 1px solid rgba(255,255,255,.22); }
.per-tarde { background: linear-gradient(180deg, #e8a020 0%, #c9821a 100%); }
.per-outro { background: rgba(255,255,255,.16); }
.ausb-justif { min-width: 150px; }
.ausb-remove { background: rgba(255,255,255,.1); border: none; color: #ffb4b4; width: 24px; height: 24px; border-radius: 6px; font-size: 1.1em; line-height: 1; cursor: pointer; flex: none; }
.ausb-remove:hover { background: rgba(224,92,92,.3); }
.ausb-inline { display: flex; gap: 8px; flex: 0 0 auto; }
.ausb-f { display: flex; flex-direction: column; gap: 3px; min-width: 128px; margin: 0; }
.ausb-f > span { font-size: .68em; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: rgba(255,255,255,.6); }
.ausb-sel { height: 32px; border-radius: 8px; border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.96); color: #1a3a5c; font-weight: 600; padding: 0 8px; }
.ausb-picker:not(:empty) { margin-top: 10px; }

/* Card states: the OPEN card is the spotlit workbench; CONFIRMED rows are thin
   ledger lines. Strong size + tone contrast so "done" reads at a glance. */
.ausb-card { animation: ausb-in .18s ease-out; }
@keyframes ausb-in { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: none; } }
.ausb-card.is-aberta { background: rgba(255,255,255,.13); box-shadow: 0 8px 22px rgba(0,0,0,.3), 0 0 0 1px rgba(255,255,255,.14); }

.ausb-card-c { display: flex; align-items: center; gap: 8px; padding: 4px 9px 4px 10px; min-height: 34px; border-left-color: #2fa56a; background: rgba(255,255,255,.045); cursor: pointer; }
.ausb-card-c:hover { background: rgba(255,255,255,.1); }
.ausb-card-c.is-ro { cursor: default; }
.ausb-card-c.is-ro:hover { background: rgba(255,255,255,.045); }
.ausb-c-check { flex: none; width: 14px; height: 14px; border-radius: 50%; background: rgba(47,165,106,.9); color: #fff; font-size: .58em; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.ausb-card-c .ausb-ava { width: 21px; height: 21px; font-size: .58em; box-shadow: none; }
.ausb-card-c .ausb-name { flex: none; max-width: 34%; font-size: .84em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ausb-card-c .ausb-chip { font-size: .6em; padding: 1px 7px; }
.ausb-c-meta { flex: 1; min-width: 40px; font-size: .68em; color: rgba(255,255,255,.5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ausb-c-extra { display: inline-flex; align-items: center; gap: 5px; flex: none; min-width: 0; }
.ausb-card-c .ausb-badges { margin-top: 0; display: inline-flex; gap: 5px; flex-wrap: nowrap; }
.ausb-card-c .ausb-bdg { font-size: .58em; padding: 1px 6px; }
.bdg-justif { background: rgba(47,165,106,.16); color: #8fe6b8; border: 1px solid rgba(47,165,106,.4); font-size: .68em; font-weight: 700; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.ausb-c-accao { font-size: .62em; color: #f4cd84; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px; }
.ausb-pencil { background: rgba(255,255,255,.1); border: none; color: #8fd0ff; width: 26px; height: 26px; border-radius: 7px; font-size: .95em; line-height: 1; cursor: pointer; flex: none; }
.ausb-pencil:hover { background: rgba(143,208,255,.25); }
.ausb-card-c .ausb-pencil, .ausb-card-c .ausb-remove { width: 22px; height: 22px; font-size: .85em; opacity: .35; transition: opacity .12s; }
.ausb-card-c:hover .ausb-pencil, .ausb-card-c:hover .ausb-remove { opacity: 1; }
.ausb-confirm { background: rgba(47,165,106,.85); border: none; color: #fff; width: 26px; height: 26px; border-radius: 7px; font-size: 1em; line-height: 1; cursor: pointer; flex: none; }
.ausb-confirm:hover { background: #2fa56a; }
.ausb-card.is-incompleta { border-left-color: #e8a020; box-shadow: 0 0 0 1px rgba(232,160,32,.55); }
.ausb-hint-inc { margin-top: 8px; font-size: .78em; font-weight: 600; color: #f4cd84; }
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
.ausd-tile.t-mdb .n { color: #8fe6b8; }
.ausd-tile.t-adi .n { color: #c6b6ff; }
.ausd-warn { margin-top: 14px; padding: 9px 13px; border-radius: 9px; font-size: .82em; font-weight: 600; background: rgba(224,92,92,.16); border: 1px solid rgba(224,92,92,.4); color: #ffd0d0; }
.ausd-warn b { color: #fff; }

/* Footer: inline motivo do atraso + finish-in-canvas CTA */
[data-ausd-footer]:not(:empty) { margin-top: 14px; border-top: 1px solid rgba(255,255,255,.12); padding-top: 12px; }
.ausd-motivo > label { display: block; font-size: .7em; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #ffd0d0; margin: 0 0 4px; }
#sigos-aus-deck .control-input textarea { background: rgba(255,255,255,.96); border: 1px solid rgba(255,255,255,.25); border-radius: 8px; color: #1a3a5c; font-weight: 600; min-height: 56px; }
.ausd-cta-row { display: flex; justify-content: flex-end; margin-top: 10px; }
.ausd-cta { background: #e8a020; color: #14304c; border: none; border-radius: 9px; padding: 9px 24px; font-weight: 800; font-size: .95em; letter-spacing: .02em; cursor: pointer; box-shadow: 0 3px 10px rgba(0,0,0,.25); }
.ausd-cta:hover { background: #f2b542; }
.ausd-late-note { font-size: .84em; font-weight: 600; color: #ffd0d0; background: rgba(224,92,92,.12); border: 1px solid rgba(224,92,92,.3); border-radius: 9px; padding: 8px 12px; }

/* Mobile: deck unsticks, cards stack, tap targets grow */
@media (max-width: 640px) {
	#sigos-aus-deck { position: static; padding: 12px 13px; }
	.ausd-controls { gap: 8px; }
	.ausd-field { min-width: calc(50% - 8px); }
	.ausb-results:not(:empty) { max-height: 55vh; }
	.ausb-res { padding: 11px 9px; }
	.ausb-card-top { flex-direction: column; align-items: stretch; gap: 9px; }
	.ausb-guard { padding-right: 60px; }
	.ausb-inline { width: 100%; }
	.ausb-f { flex: 1; min-width: 0; }
	.ausb-card.is-aberta .ausb-remove { position: absolute; top: 9px; right: 9px; }
	.ausb-card.is-aberta .ausb-confirm { position: absolute; top: 9px; right: 41px; }
	.ausb-card-c { flex-wrap: wrap; row-gap: 3px; padding: 7px 9px; }
	.ausb-card-c .ausb-name { max-width: none; }
	.ausb-c-meta { flex-basis: 100%; order: 9; }
	.ausb-card-c .ausb-pencil, .ausb-card-c .ausb-remove { opacity: 1; margin-left: auto; }
	.ausb-card-c .ausb-remove { margin-left: 0; }
	.ausd-tile { flex: 1; min-width: 72px; padding: 8px 10px; }
	.ausd-cta { width: 100%; padding: 12px; }
}
`;
	const s = document.createElement("style");
	s.id = "sigos-aus-deck-css";
	s.textContent = css;
	document.head.appendChild(s);
}
