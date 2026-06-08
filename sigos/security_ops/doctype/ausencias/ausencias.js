// ─── Module-level state ───────────────────────────────────────────────────────
// Cache: keyed by "data|periodo|grupo" so it resets when header fields change
let _escala_cache = null;
let _escala_cache_key = null;
let _quick_dialog = null;
let _atraso_estado = null;   // null = unknown/na, "ok" = on time, "tardia" = late

// ─── Main form events ─────────────────────────────────────────────────────────
frappe.ui.form.on("Ausencias", {

	onload(frm) {
		_setup_substituto_query(frm);
	},

	refresh(frm) {
		// The native button + old summary are superseded by the command deck.
		frm.set_df_property("btn_adicionar_ausencia", "hidden", 1);
		frm.set_df_property("resumo_ausencias", "hidden", 1);

		_aplicar_permissoes(frm);
		_verificar_horario(frm);
		_render_deck(frm);
		_setup_substituto_query(frm);
	},

	data(frm)           { _invalidar_cache(); _verificar_horario(frm); _render_deck(frm); },
	periodo(frm)        { _invalidar_cache(); _verificar_horario(frm); _render_deck(frm); },
	grupo_delegados(frm){ _invalidar_cache(); _render_deck(frm); },

	btn_adicionar_ausencia(frm) {
		if (!frm.doc.data || !frm.doc.periodo) {
			frappe.show_alert({ message: __("Preencha Data e Período primeiro."), indicator: "orange" });
			return;
		}
		_abrir_quick_add(frm);
	},

	before_save(frm) {
		// Capture server-side hora just before save — server enforces the actual rule
		const agora = new Date().toLocaleTimeString("pt-PT", { hour12: false });
		frm.set_value("hora_submissao_tardia", agora);
	},
});

// ─── Child table events ───────────────────────────────────────────────────────
frappe.ui.form.on("Tabela Ausencia", {

	vigilante(frm, cdt, cdn) {
		_check_duplicate(frm, cdt, cdn, "vigilante", __("Este vigilante já foi adicionado."));
		_enrich_from_cache(frm, cdt, cdn);
	},

	vigilante_substituto(frm, cdt, cdn) {
		_check_duplicate(frm, cdt, cdn, "vigilante_substituto", __("Este substituto já foi usado noutra linha."));
	},

	vigilante_a_dobrar(frm, cdt, cdn) {
		_check_duplicate(frm, cdt, cdn, "vigilante_a_dobrar", __("Este vigilante a dobrar já foi usado."));
	},

	vigilante_a_adiantar(frm, cdt, cdn) {
		_check_duplicate(frm, cdt, cdn, "vigilante_a_adiantar", __("Este vigilante a adiantar já foi usado."));
	},

	regime(frm, cdt, cdn)          { _set_n_faltas(frm, cdt, cdn); _atualizar_resumo(frm); },
	turno(frm, cdt, cdn)           { _set_n_faltas(frm, cdt, cdn); _atualizar_resumo(frm); },
	tipo_de_ausencia(frm, cdt, cdn){ _atualizar_resumo(frm); },
	proxima_accao(frm, cdt, cdn)   { _atualizar_resumo(frm); },

	tabela_ausencia_remove(frm)    { _atualizar_resumo(frm); },
});

// ─── Quick-add dialog ─────────────────────────────────────────────────────────
function _abrir_quick_add(frm) {
	const cache_key = `${frm.doc.data}|${frm.doc.periodo}|${frm.doc.grupo_delegados || ""}`;

	const _mostrar = () => {
		const total_escala = (_escala_cache || []).length;

		if (!total_escala) {
			frappe.msgprint({
				title: __("Escala não encontrada"),
				message: __(
					"Não foi encontrada nenhuma escala para esta data e período.<br><br>" +
					"Verifique que:<ul>" +
					"<li>Existe uma <b>Escala Do Vigilante</b> com estado <b>Activo</b> para o posto;</li>" +
					"<li>A escala tem turnos gerados para <b>{0}</b> no período <b>{1}</b>;</li>" +
					"<li>Os vigilantes não estão todos em folga nesse dia.</li></ul>",
					[frappe.datetime.str_to_user(frm.doc.data) || "", frm.doc.periodo || ""]
				),
				indicator: "orange",
			});
			return;
		}

		if (_quick_dialog) { _quick_dialog.hide(); _quick_dialog = null; }

		// Selection state lives across re-renders (search filtering)
		const selected = new Set();

		_quick_dialog = new frappe.ui.Dialog({
			title: __("Registar Ausências — {0} · {1}", [
				frappe.datetime.str_to_user(frm.doc.data) || "", frm.doc.periodo || "",
			]),
			size: "large",
			fields: [
				{
					fieldname: "tipo_de_ausencia", fieldtype: "Select", label: __("Tipo de Ausência"),
					options: "Falta\nAtraso\nSaída Antecipada\nSuspensão\nLicença\nOutro",
					default: "Falta", reqd: 1,
				},
				{ fieldname: "cb1", fieldtype: "Column Break" },
				{
					fieldname: "proxima_accao", fieldtype: "Select", label: __("Próxima Acção (aplicada a todos)"),
					options: "Sem Ação\nSubstituto\nDobra de Turno\nAdiantamento de Turno",
					default: "Sem Ação",
				},
				{ fieldname: "sb1", fieldtype: "Section Break" },
				{
					fieldname: "pesquisa", fieldtype: "Data", label: __("Pesquisar vigilante"),
					description: __("Filtra por nome, mecanográfico ou posto"),
				},
				{ fieldname: "roster", fieldtype: "HTML" },
			],
			primary_action_label: __("Adicionar Seleccionados"),
			primary_action(values) {
				if (!selected.size) {
					frappe.show_alert({ message: __("Seleccione pelo menos um vigilante."), indicator: "orange" }, 3);
					return;
				}
				const tipo  = values.tipo_de_ausencia || "Falta";
				const accao = values.proxima_accao || "Sem Ação";
				let added = 0;

				selected.forEach(vname => {
					const vdata = (_escala_cache || []).find(v => v.vigilante === vname);
					if (!vdata) return;
					const row             = frm.add_child("tabela_ausencia");
					row.vigilante         = vdata.vigilante;
					row.nome_do_vigilante = vdata.nome_completo;
					row.mecanografico     = vdata.mecanografico;
					row.posto             = vdata.posto;
					row.regime            = vdata.regime;
					row.turno             = vdata.turno;
					row.periodo           = vdata.periodo;
					row.delegacao         = vdata.delegacao;
					row.tipo_de_ausencia  = tipo;
					row.proxima_accao     = accao;
					row.n_de_faltas       = vdata.n_de_faltas ?? 1;
					added++;
				});

				frm.refresh_field("tabela_ausencia");
				_atualizar_resumo(frm);
				frappe.show_alert({ message: __("{0} ausência(s) adicionada(s).", [added]), indicator: "green" }, 4);

				selected.clear();
				_render_roster(_quick_dialog, "");   // refresh — added ones become "registado"
			},
			secondary_action_label: __("Fechar"),
			secondary_action() { _quick_dialog.hide(); _quick_dialog = null; },
		});

		_quick_dialog.show();

		// Search re-renders the roster live
		_quick_dialog.fields_dict.pesquisa.$input?.on("input", function () {
			_render_roster(_quick_dialog, this.value || "", selected);
		});

		_render_roster(_quick_dialog, "", selected);

		// Stash selection so _render_roster can reach it on re-render
		_quick_dialog._selected = selected;
	};

	// Use cache if available for this header combination
	if (_escala_cache && _escala_cache_key === cache_key) {
		_mostrar();
		return;
	}

	frappe.call({
		method: "sigos.api.get_vigilantes_da_escala",
		args: {
			data: frm.doc.data,
			periodo: frm.doc.periodo,
			grupo_delegados: frm.doc.grupo_delegados || null,
		},
		freeze: true,
		freeze_message: __("A carregar escala..."),
		callback(r) {
			_escala_cache     = r.message || [];
			_escala_cache_key = cache_key;
			_mostrar();
		},
		error() {
			frappe.show_alert({ message: __("Erro ao carregar a escala."), indicator: "red" });
		},
	});
}

// ─── Interactive roster inside the quick-add dialog ───────────────────────────
function _render_roster(dialog, filtro, selected) {
	if (!dialog) return;
	selected = selected || dialog._selected || new Set();
	dialog._selected = selected;

	const frm = cur_frm;
	const ja = new Set((frm.doc.tabela_ausencia || []).map(r => r.vigilante));
	const roster = (_escala_cache || []);

	const q = (filtro || "").trim().toLowerCase();
	const lista = q
		? roster.filter(v =>
			(v.nome_completo || "").toLowerCase().includes(q) ||
			(v.mecanografico || "").toLowerCase().includes(q) ||
			(v.posto || "").toLowerCase().includes(q))
		: roster;

	const disp = roster.filter(v => !ja.has(v.vigilante)).length;

	const cards = lista.map(v => {
		const registado = ja.has(v.vigilante);
		const sel = selected.has(v.vigilante);
		const meta = [v.mecanografico, v.posto, v.turno].filter(Boolean).join(" · ");
		return `
			<div class="aus-card ${registado ? "aus-card-done" : ""} ${sel ? "aus-card-sel" : ""}"
				 data-vig="${registado ? "" : v.vigilante}">
				<div class="aus-check">${registado ? "✓" : (sel ? "☑" : "☐")}</div>
				<div class="aus-info">
					<div class="aus-name">${frappe.utils.escape_html(v.nome_completo || v.vigilante)}</div>
					<div class="aus-meta">${frappe.utils.escape_html(meta)}</div>
				</div>
				${registado ? `<span class="aus-badge-done">${__("registado")}</span>` : ""}
			</div>`;
	}).join("");

	const pill = (cls, n, label) => `<span class="aus-pill ${cls}"><span class="aus-n">${n}</span> ${label}</span>`;

	const html = `
		<div class="aus-roster-head">
			<div class="aus-counts">
				${pill("aus-pill-total", roster.length, __("na escala"))}
				${pill("aus-pill-disp", disp, __("disponíveis"))}
				${pill("aus-pill-done", ja.size, __("registado(s)"))}
			</div>
			<div class="aus-bulk">
				<button class="aus-mini-btn" data-action="all">${__("Seleccionar todos")}</button>
				<button class="aus-mini-btn" data-action="none">${__("Limpar")}</button>
			</div>
		</div>
		<div class="aus-roster">${cards || `<div class="aus-empty">${__("Nenhum vigilante corresponde à pesquisa.")}</div>`}</div>
		<div class="aus-selbar" data-sel-bar>
			<span class="aus-sel-hero"><span class="aus-n" data-sel-count>${selected.size}</span> ${__("seleccionado(s)")}</span>
		</div>`;

	const $w = dialog.fields_dict.roster.$wrapper;
	$w.html(html);

	const refreshCount = () => {
		$w.find("[data-sel-count]").text(selected.size);
		$w.find("[data-sel-bar]").toggleClass("aus-selbar-active", selected.size > 0);
		const $btn = dialog.$wrapper.find(".btn-primary");
		$btn.text(selected.size ? __("Adicionar Seleccionados ({0})", [selected.size]) : __("Adicionar Seleccionados"));
	};
	refreshCount();

	// Card toggle
	$w.find(".aus-card[data-vig]").on("click", function () {
		const vig = $(this).attr("data-vig");
		if (!vig) return;
		if (selected.has(vig)) { selected.delete(vig); $(this).removeClass("aus-card-sel"); $(this).find(".aus-check").text("☐"); }
		else                   { selected.add(vig);    $(this).addClass("aus-card-sel");    $(this).find(".aus-check").text("☑"); }
		refreshCount();
	});

	// Bulk select / clear (respects current filter)
	$w.find('[data-action="all"]').on("click", () => {
		lista.forEach(v => { if (!ja.has(v.vigilante)) selected.add(v.vigilante); });
		_render_roster(dialog, filtro, selected);
	});
	$w.find('[data-action="none"]').on("click", () => {
		selected.clear();
		_render_roster(dialog, filtro, selected);
	});
}

// ─── Late submission warning ──────────────────────────────────────────────────
function _verificar_horario(frm) {
	const limites = { "Manhã": "09:30:00", "Noite": "18:30:00" };
	const limite  = limites[frm.doc.periodo];
	if (!limite) {
		_atraso_estado = null;
		_limpar_alerta(frm);
		return;
	}

	// Fetch limits from settings (cached by Frappe)
	const key = frm.doc.periodo === "Manhã" ? "hora_limite_manha" : "hora_limite_noite";
	frappe.db.get_single_value("SIGOS Settings", key).then(val => {
		const hora_limite = val || limite;
		const agora = new Date().toLocaleTimeString("pt-PT", { hour12: false });

		if (agora > hora_limite) {
			_atraso_estado = "tardia";
			_mostrar_alerta_atraso(frm, agora, hora_limite);
			frm.set_df_property("motivo_atraso", "reqd", 1);
			frm.set_df_property("motivo_atraso", "read_only", 0);
			// Expand the section so it's visible
			frm.set_df_property("sec_atraso", "collapsible_open", 1);
		} else {
			_atraso_estado = "ok";
			_limpar_alerta(frm);
			frm.set_df_property("motivo_atraso", "reqd", 0);
		}
		_render_deck(frm);
	});
}

function _mostrar_alerta_atraso(frm, agora, limite) {
	const html = `
		<div class="alert alert-warning d-flex align-items-center mb-0" style="border-radius:6px;">
			<span style="font-size:1.2em;margin-right:8px;">⚠️</span>
			<div>
				<strong>${__("Submissão fora do horário")}</strong><br>
				${__("Hora actual")}: <b>${agora}</b> &nbsp;|&nbsp; ${__("Limite")}: <b>${limite}</b><br>
				<small>${__("O campo Motivo do Atraso é obrigatório.")}</small>
			</div>
		</div>`;
	frm.fields_dict.alerta_atraso.$wrapper.html(html);
}

function _limpar_alerta(frm) {
	frm.fields_dict.alerta_atraso?.$wrapper.html("");
}

// ─── Live summary ─────────────────────────────────────────────────────────────
function _atualizar_resumo(frm) {
	_render_deck(frm);   // the command deck carries the live stats now
	const rows = frm.doc.tabela_ausencia || [];
	if (!rows.length) {
		frm.fields_dict.resumo_ausencias?.$wrapper.html("");
		return;
	}

	const total_faltas = rows.reduce((s, r) => s + (r.n_de_faltas || 0), 0);

	// Count by tipo
	const por_tipo = {};
	rows.forEach(r => {
		const k = r.tipo_de_ausencia || "—";
		por_tipo[k] = (por_tipo[k] || 0) + 1;
	});

	// Count by proxima_accao
	const substitutos  = rows.filter(r => r.proxima_accao === "Substituto").length;
	const dobras       = rows.filter(r => r.proxima_accao === "Dobra de Turno").length;
	const adiantamentos= rows.filter(r => r.proxima_accao === "Adiantamento de Turno").length;
	const sem_accao    = rows.filter(r => !r.proxima_accao || r.proxima_accao === "Sem Ação").length;

	const tipo_badges = Object.entries(por_tipo)
		.map(([t, c]) => `<span class="badge badge-pill badge-secondary mr-1">${t}: ${c}</span>`)
		.join("");

	const html = `
		<div class="sigos-resumo" style="padding:8px 0 4px;">
			<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
				<span class="badge badge-pill badge-danger" style="font-size:.85em;">
					${rows.length} ausente(s)
				</span>
				<span class="badge badge-pill badge-dark" style="font-size:.85em;">
					${total_faltas} falta(s) contadas
				</span>
				${tipo_badges}
				${substitutos   ? `<span class="badge badge-pill badge-info">${substitutos} substituto(s)</span>` : ""}
				${dobras        ? `<span class="badge badge-pill badge-info">${dobras} dobra(s)</span>` : ""}
				${adiantamentos ? `<span class="badge badge-pill badge-info">${adiantamentos} adiantamento(s)</span>` : ""}
				${sem_accao     ? `<span class="badge badge-pill badge-light">${sem_accao} sem acção</span>` : ""}
			</div>
		</div>`;
	frm.fields_dict.resumo_ausencias?.$wrapper.html(html);
}

// ─── Command deck (the premium hero at the top of the form) ───────────────────
function _render_deck(frm) {
	_inject_deck_css();
	const w = frm.fields_dict.deck_ausencias?.$wrapper;
	if (!w) return;

	const rows   = frm.doc.tabela_ausencia || [];
	const ausentes = rows.length;
	const faltas   = rows.reduce((s, r) => s + (r.n_de_faltas || 0), 0);
	const subs     = rows.filter(r => r.proxima_accao === "Substituto").length;
	const dobras   = rows.filter(r => r.proxima_accao === "Dobra de Turno").length;
	const adiant   = rows.filter(r => r.proxima_accao === "Adiantamento de Turno").length;

	const locked    = frm.doc.workflow_state === "Pendente De Aprovação";
	const submitted = frm.doc.docstatus === 1;
	const ready     = !!(frm.doc.data && frm.doc.periodo);
	const editable  = !submitted && !locked && ready;

	const dataStr = frm.doc.data ? frappe.datetime.str_to_user(frm.doc.data) : __("sem data");
	const ctx = [dataStr, frm.doc.periodo || __("sem período"),
		frm.doc.grupo_delegados || __("todos os grupos")].join("  ·  ");

	let chip;
	if (submitted)                     chip = `<span class="ausd-chip ausd-chip-ok">${__("Submetida")}</span>`;
	else if (locked)                   chip = `<span class="ausd-chip ausd-chip-lock">${__("Pendente de Aprovação")}</span>`;
	else if (!ready)                   chip = `<span class="ausd-chip ausd-chip-wait">${__("Defina data e período")}</span>`;
	else if (_atraso_estado === "tardia") chip = `<span class="ausd-chip ausd-chip-late">${__("Submissão tardia")}</span>`;
	else                               chip = `<span class="ausd-chip ausd-chip-ok">${__("Dentro do horário")}</span>`;

	const tile = (n, label, cls) =>
		`<div class="ausd-tile ${cls || ""}"><span class="n">${n}</span><span class="lbl">${label}</span></div>`;

	const tiles = [
		tile(ausentes, __("ausentes"), "t-aus"),
		tile(faltas,   __("faltas"),   "t-falta"),
		subs   ? tile(subs,   __("substitutos"), "t-sub") : "",
		dobras ? tile(dobras, __("dobras"),      "t-dob") : "",
		adiant ? tile(adiant, __("adiantam."),   "t-adi") : "",
	].join("");

	const ctaDisabled = editable ? "" : "disabled";
	const warn = (_atraso_estado === "tardia" && editable)
		? `<div class="ausd-warn">${__("Submissão fora do horário — preencha o <b>Motivo do Atraso</b> antes de gravar.")}</div>`
		: "";

	w.html(`
		<div id="sigos-aus-deck" class="${locked ? "is-locked" : ""}">
			<div class="ausd-top">
				<div class="ausd-head">
					<div class="ausd-title">${__("Folha de Ausências")}</div>
					<div class="ausd-context">${frappe.utils.escape_html(ctx)}</div>
				</div>
				${chip}
			</div>
			<div class="ausd-actions">
				<button type="button" class="ausd-cta" ${ctaDisabled}>
					<span class="ausd-cta-plus">+</span> ${__("Registar Ausências")}
				</button>
				<span class="ausd-hint">${ausentes
					? __("{0} vigilante(s) na folha", [ausentes])
					: __("Comece por adicionar os vigilantes ausentes")}</span>
			</div>
			${ausentes ? `<div class="ausd-tiles">${tiles}</div>` : ""}
			${warn}
		</div>`);

	w.find(".ausd-cta").on("click", () => {
		if (!ready) {
			frappe.show_alert({ message: __("Preencha Data e Período primeiro."), indicator: "orange" });
			return;
		}
		if (!editable) return;
		_abrir_quick_add(frm);
	});
}

function _inject_deck_css() {
	if (document.getElementById("sigos-aus-deck-css")) return;
	const css = `
#sigos-aus-deck {
	position: sticky; top: 8px; z-index: 6;
	margin: 0 0 14px; padding: 16px 18px;
	border-radius: 14px; color: #fff;
	background: linear-gradient(135deg, #234a73 0%, #1a3a5c 60%, #14304c 100%);
	box-shadow: 0 8px 24px rgba(20,48,76,.28), inset 0 1px 0 rgba(255,255,255,.08);
	border: 1px solid rgba(255,255,255,.06);
}
#sigos-aus-deck.is-locked { filter: saturate(.7); }
.ausd-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.ausd-title {
	font-family: var(--sigos-display, system-ui); font-weight: 700;
	font-size: 1.18em; letter-spacing: .03em; text-transform: uppercase; line-height: 1;
}
.ausd-context { margin-top: 5px; font-size: .82em; color: rgba(255,255,255,.72); font-variant-numeric: tabular-nums; }
.ausd-chip {
	flex: none; padding: 5px 11px; border-radius: 999px; white-space: nowrap;
	font-size: .72em; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
	border: 1px solid transparent;
}
.ausd-chip-ok   { background: rgba(47,165,106,.18); color: #8fe6b8; border-color: rgba(47,165,106,.4); }
.ausd-chip-late { background: rgba(224,92,92,.2);  color: #ffb4b4; border-color: rgba(224,92,92,.5); }
.ausd-chip-wait { background: rgba(255,255,255,.1); color: rgba(255,255,255,.75); }
.ausd-chip-lock { background: rgba(232,160,32,.2); color: #f4cd84; border-color: rgba(232,160,32,.45); }
.ausd-actions { display: flex; align-items: center; gap: 14px; margin-top: 14px; flex-wrap: wrap; }
.ausd-cta {
	display: inline-flex; align-items: center; gap: 8px;
	padding: 11px 22px; border: none; border-radius: 10px; cursor: pointer;
	font-family: var(--sigos-display, system-ui); font-weight: 700; font-size: 1.02em;
	letter-spacing: .02em; color: #1a3a5c;
	background: linear-gradient(180deg, #f2b542 0%, #e8a020 100%);
	box-shadow: 0 4px 14px rgba(232,160,32,.4), inset 0 1px 0 rgba(255,255,255,.4);
	transition: transform .12s ease, box-shadow .12s ease, filter .12s ease;
}
.ausd-cta:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(232,160,32,.5); }
.ausd-cta:active { transform: translateY(0); }
.ausd-cta[disabled] {
	cursor: not-allowed; color: rgba(255,255,255,.45);
	background: rgba(255,255,255,.1); box-shadow: none; filter: none;
}
.ausd-cta-plus { font-size: 1.25em; line-height: 0; font-weight: 400; }
.ausd-hint { font-size: .82em; color: rgba(255,255,255,.7); }
.ausd-tiles { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
.ausd-tile {
	min-width: 84px; padding: 10px 14px; border-radius: 10px;
	background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.1);
	display: flex; flex-direction: column; gap: 2px;
}
.ausd-tile .n {
	font-family: var(--sigos-display, system-ui); font-weight: 700; font-size: 1.7em;
	line-height: 1; font-variant-numeric: tabular-nums;
}
.ausd-tile .lbl { font-size: .68em; text-transform: uppercase; letter-spacing: .05em; color: rgba(255,255,255,.65); }
.ausd-tile.t-aus   .n { color: #ff9d9d; }
.ausd-tile.t-falta .n { color: #fff; }
.ausd-tile.t-sub   .n { color: #8fd0ff; }
.ausd-tile.t-dob   .n { color: #f4cd84; }
.ausd-tile.t-adi   .n { color: #c6b6ff; }
.ausd-warn {
	margin-top: 14px; padding: 9px 13px; border-radius: 9px; font-size: .82em; font-weight: 600;
	background: rgba(224,92,92,.16); border: 1px solid rgba(224,92,92,.4); color: #ffd0d0;
}
.ausd-warn b { color: #fff; }
`;
	const s = document.createElement("style");
	s.id = "sigos-aus-deck-css";
	s.textContent = css;
	document.head.appendChild(s);
}

// ─── Permissions / read-only state ───────────────────────────────────────────
function _aplicar_permissoes(frm) {
	const locked = frm.doc.workflow_state === "Pendente De Aprovação";
	frm.fields.forEach(f => {
		const always_rw = ["motivo_atraso"]; // user may always fill this in
		if (locked && !always_rw.includes(f.df.fieldname)) {
			frm.set_df_property(f.df.fieldname, "read_only", 1);
		}
	});
}

// ─── Substituto query ─────────────────────────────────────────────────────────
function _setup_substituto_query(frm) {
	frm.set_query("vigilante_substituto", "tabela_ausencia", function(doc, cdt, cdn) {
		const row = locals[cdt][cdn];
		return {
			// Server-side filtered: only Categorias with pode_ser_substituto = 1
			query: "sigos.api.get_substitutos_disponiveis",
			filters: {
				delegacao: row.delegacao || "",
				excluir:   row.vigilante || "",
			},
		};
	});
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function _invalidar_cache() {
	_escala_cache     = null;
	_escala_cache_key = null;
}

function _check_duplicate(frm, cdt, cdn, field, msg) {
	const row = locals[cdt][cdn];
	if (!row[field]) return;
	const dup = (frm.doc.tabela_ausencia || []).some(
		r => r.name !== row.name && r[field] === row[field]
	);
	if (dup) {
		frappe.show_alert({ message: msg, indicator: "red" }, 4);
		frappe.model.set_value(cdt, cdn, field, null);
	}
}

function _enrich_from_cache(frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	if (!row.vigilante) return;

	// Try to get data from the cache first (no round trip if dialog was used)
	const cached = (_escala_cache || []).find(v => v.vigilante === row.vigilante);
	if (cached) {
		frappe.model.set_value(cdt, cdn, {
			nome_do_vigilante: cached.nome_completo,
			mecanografico:     cached.mecanografico,
			posto:             cached.posto,
			regime:            cached.regime,
			turno:             cached.turno,
			periodo:           cached.periodo,
			delegacao:         cached.delegacao,
		});
		_set_n_faltas(frm, cdt, cdn);
		return;
	}

	// Fallback: fetch from API (manual row entry without dialog)
	if (!frm.doc.data) return;
	frappe.call({
		method: "sigos.api.get_vigilante_data",
		args: { vigilante: row.vigilante, data: frm.doc.data },
		callback(r) {
			if (r.message?.length) {
				const d = r.message[0];
				frappe.model.set_value(cdt, cdn, {
					posto:   d.posto,
					regime:  d.regime,
					turno:   d.turno,
					periodo: d.periodo,
				});
				_set_n_faltas(frm, cdt, cdn);
			}
		},
	});
}

function _set_n_faltas(frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	if (!row.regime || !row.turno) return;

	// Check cache first
	const cached = (_escala_cache || []).find(
		v => v.vigilante === row.vigilante
	);
	if (cached?.n_de_faltas != null) {
		frappe.model.set_value(cdt, cdn, "n_de_faltas", cached.n_de_faltas);
		return;
	}

	// Server lookup — regime × turno
	frappe.db.get_value(
		"Regime Turno Item",
		{ parent: row.regime, turno: row.turno },
		"n_de_faltas"
	).then(r => {
		frappe.model.set_value(cdt, cdn, "n_de_faltas", r?.message?.n_de_faltas ?? 1);
	});
}
