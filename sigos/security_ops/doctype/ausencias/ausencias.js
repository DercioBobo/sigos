// ─── Module-level state ───────────────────────────────────────────────────────
// Cache: keyed by "data|periodo|grupo" so it resets when header fields change
let _escala_cache = null;
let _escala_cache_key = null;
let _quick_dialog = null;

// ─── Main form events ─────────────────────────────────────────────────────────
frappe.ui.form.on("Ausencias", {

	onload(frm) {
		_setup_substituto_query(frm);
	},

	refresh(frm) {
		_aplicar_permissoes(frm);
		_verificar_horario(frm);
		_atualizar_resumo(frm);
		_setup_substituto_query(frm);
	},

	data(frm)           { _invalidar_cache(); _verificar_horario(frm); },
	periodo(frm)        { _invalidar_cache(); _verificar_horario(frm); },
	grupo_delegados(frm){ _invalidar_cache(); },

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

	frappe.show_progress(__("A carregar escala..."), 0, 100, __("Por favor aguarde"));

	frappe.call({
		method: "sigos.api.get_vigilantes_da_escala",
		args: {
			data: frm.doc.data,
			periodo: frm.doc.periodo,
			grupo_delegados: frm.doc.grupo_delegados || null,
		},
		callback(r) {
			frappe.hide_progress();
			_escala_cache     = r.message || [];
			_escala_cache_key = cache_key;
			_mostrar();
		},
		error() {
			frappe.hide_progress();
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

	const html = `
		<div class="aus-roster-head">
			<div class="aus-counts">
				<span class="aus-pill aus-pill-total">${roster.length} ${__("na escala")}</span>
				<span class="aus-pill aus-pill-disp">${disp} ${__("disponíveis")}</span>
				<span class="aus-pill aus-pill-done">${ja.size} ${__("registado(s)")}</span>
				<span class="aus-pill aus-pill-sel" data-sel-count>${selected.size} ${__("seleccionado(s)")}</span>
			</div>
			<div class="aus-bulk">
				<button class="aus-mini-btn" data-action="all">${__("Seleccionar todos")}</button>
				<button class="aus-mini-btn" data-action="none">${__("Limpar")}</button>
			</div>
		</div>
		<div class="aus-roster">${cards || `<div class="aus-empty">${__("Nenhum vigilante corresponde à pesquisa.")}</div>`}</div>`;

	const $w = dialog.fields_dict.roster.$wrapper;
	$w.html(html);

	const refreshCount = () => {
		$w.find("[data-sel-count]").text(`${selected.size} ${__("seleccionado(s)")}`);
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
		_limpar_alerta(frm);
		return;
	}

	// Fetch limits from settings (cached by Frappe)
	const key = frm.doc.periodo === "Manhã" ? "hora_limite_manha" : "hora_limite_noite";
	frappe.db.get_single_value("SIGOS Settings", key).then(val => {
		const hora_limite = val || limite;
		const agora = new Date().toLocaleTimeString("pt-PT", { hour12: false });

		if (agora > hora_limite) {
			_mostrar_alerta_atraso(frm, agora, hora_limite);
			frm.set_df_property("motivo_atraso", "reqd", 1);
			frm.set_df_property("motivo_atraso", "read_only", 0);
			// Expand the section so it's visible
			frm.set_df_property("sec_atraso", "collapsible_open", 1);
		} else {
			_limpar_alerta(frm);
			frm.set_df_property("motivo_atraso", "reqd", 0);
		}
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
