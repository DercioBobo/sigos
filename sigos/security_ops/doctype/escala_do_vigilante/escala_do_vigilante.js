frappe.ui.form.on("Escala Do Vigilante", {

	refresh(frm) {
		// The DECK supersedes the native header fields and buttons — same data,
		// same handlers, premium chrome. Child tables stay native (inline editing).
		// Only hide the natives once the deck field actually exists on this site
		// (it arrives via migrate) — otherwise keep the classic form fully usable.
		if (frm.fields_dict.deck_escala) {
			["sec_cabecalho", "tipo_de_escala", "posto_de_vigilancia", "delegacao",
			 "col_break_1", "cliente", "estado",
			 "sec_config", "regime_do_vigilante", "data_de_inicio", "col_break_per", "gerado_ate",
			 "sincronizar_vigilantes", "distribuir_turnos", "atribuir_equipas", "btn_gerar",
			 "btn_limpar_futuro", "btn_limpar_tudo"]
				.forEach(f => frm.set_df_property(f, "hidden", 1));
			_render_deck(frm);
		}

		_estado_buttons(frm);
		_snapshot_slots(frm);
		_load_and_render(frm);
		_toggle_turno_equipa(frm);
		if (frm.doc.estado === "Arquivado") frm.disable_save();
	},

	onload(frm) {
		frm.set_query("posto_de_vigilancia", () => ({ filters: { estado: "Activo" } }));
	},

	posto_de_vigilancia(frm) {
		if (frm.doc.posto_de_vigilancia && !frm.doc.cliente) {
			frappe.db.get_value("Posto De Vigilancia", frm.doc.posto_de_vigilancia, "cliente")
				.then(r => {
					frm.set_value("cliente", r.message?.cliente);
					_deck_identity(frm);
				});
		}
	},

	sincronizar_vigilantes(frm) { _sincronizar_vigilantes(frm); },

	distribuir_turnos(frm) { _distribuir_turnos(frm); },

	atribuir_equipas(frm) { _atribuir_equipas(frm); },

	btn_gerar(frm) { _gerar_escala(frm); },

	btn_limpar_futuro(frm) { _limpar_futuro(frm); },

	btn_limpar_tudo(frm) { _limpar_tudo(frm); },
});

// ─── Turno da Equipa (customer-specific, SIGOS Settings.turno_equipa_activo) ──────
// Label/grouping column on both the roster grid and the generated schedule grid —
// never affects the rotation itself (sigos/security_ops/doctype/escala_do_vigilante/
// escala_do_vigilante.py reconciliar_escala carries it through unchanged). Hidden by
// default, same session-cached toggle pattern as Vigilante's Posição/Subsídios fields.
let _turno_equipa_activo = null;
function _toggle_turno_equipa(frm) {
	const aplicar = () => {
		const show = !!_turno_equipa_activo;
		frm.fields_dict.tab_vigilante_do_posto?.grid.toggle_display("turno_equipa", show);
		frm.fields_dict.tabela_de_escala?.grid.toggle_display("turno_equipa", show);
		// Tipo (Vigilante/Supervisor/Chefe...) is redundant once teams are in play —
		// swap it out for Turno da Equipa on the roster grid, same toggle.
		frm.fields_dict.tab_vigilante_do_posto?.grid.toggle_display("tipo_de_vigilante", !show);
		// "Atribuir Equipas em Bloco" only makes sense in team mode — same toggle.
		frm.fields_dict.deck_escala?.$wrapper.find('[data-act="equipas"]').toggle(show);
		// The async Settings fetch below usually resolves AFTER the grid has already
		// painted with the default column set — toggle_display alone can leave
		// already-rendered rows stale/misaligned for a flash. Force a clean re-layout
		// once the real column state is known, instead of waiting for some other
		// trigger to happen to refresh it.
		frm.fields_dict.tab_vigilante_do_posto?.grid.refresh();
		frm.fields_dict.tabela_de_escala?.grid.refresh();
	};
	if (_turno_equipa_activo === null) {
		frappe.db.get_single_value("SIGOS Settings", "turno_equipa_activo").then((v) => {
			_turno_equipa_activo = !!v;
			aplicar();
		});
	} else {
		aplicar();
	}
}

function _gerar_escala(frm) {
	if (frm.is_dirty() || frm.is_new()) {
		frm.save().then(() => frappe.show_alert({ message: __("Escala gerada."), indicator: "green" }, 3));
	} else {
		frappe.call({
			method: "sigos.api.gerar_escala_posto",
			args: { escala_name: frm.doc.name },
			freeze: true, freeze_message: __("A gerar escala..."),
			callback: () => frm.reload_doc(),
		});
	}
}

function _limpar_futuro(frm) {
	if (frm.is_new()) { frappe.show_alert({ message: __("Grave a escala primeiro."), indicator: "orange" }, 3); return; }
	frappe.confirm(
		__("Remover todos os dias futuros não-editados? Os dias com alteração manual são mantidos."),
		() => frappe.call({
			method: "sigos.api.limpar_futuro_escala",
			args: { escala_name: frm.doc.name },
			freeze: true,
			callback: () => frm.reload_doc(),
		})
	);
}

// Full reset of the GENERATED CALENDAR only — the roster (guards, turno_inicial,
// turno_equipa) is left untouched, unlike limpar_futuro (future non-override rows
// only) this drops every day, past and future. The alternative to deleting the
// whole Escala just to rebuild the calendar from scratch; reload_doc() afterwards
// is what actually clears the deck's calendar view too (editing the native "Dados"
// table alone doesn't re-render it). Click Gerar / Estender Escala after to rebuild.
function _limpar_tudo(frm) {
	if (frm.is_new()) { frappe.show_alert({ message: __("Grave a escala primeiro."), indicator: "orange" }, 3); return; }
	frappe.confirm(
		__("Limpar todo o calendário gerado desta escala? Os vigilantes e os turnos atribuídos são mantidos — só o calendário é apagado. Esta acção não pode ser desfeita."),
		() => frappe.call({
			method: "sigos.api.limpar_tudo_escala",
			args: { escala_name: frm.doc.name },
			freeze: true,
			freeze_message: __("A limpar escala..."),
			callback: () => frm.reload_doc(),
		})
	);
}

// ─── Auto-swap turno_inicial collisions in the guard list ─────────────────────
frappe.ui.form.on("Tab Vigilante Do Posto", {
	turno_inicial(frm, cdt, cdn) {
		const row = locals[cdt][cdn];
		const novo = row.turno_inicial;
		const antigo = frm._slot_snap?.[cdn];
		if (!novo) { _snapshot_slots(frm); return; }

		// Turno da Equipa (customer-specific): team rows are synced server-side on
		// save (_sincronizar_turno_por_equipa) — skip the single-guard swap here so
		// editing one teammate doesn't visibly bump a stranger before the server
		// corrects it back to the whole team's shared value.
		if (row.turno_equipa) { _snapshot_slots(frm); return; }

		// Another guard already on this slot?
		const outro = (frm.doc.tab_vigilante_do_posto || [])
			.find(g => g.name !== cdn && g.turno_inicial === novo);

		if (outro && antigo && antigo !== novo) {
			// Swap: the other guard takes the slot this guard just vacated
			frappe.model.set_value(outro.doctype, outro.name, "turno_inicial", antigo);
			frappe.show_alert({
				message: __(`Troca automática: ${outro.nome_completo || outro.vigilante} passa para ${antigo}.`),
				indicator: "blue",
			}, 5);
		}
		_snapshot_slots(frm);
	},
});

function _snapshot_slots(frm) {
	frm._slot_snap = {};
	(frm.doc.tab_vigilante_do_posto || []).forEach(g => { frm._slot_snap[g.name] = g.turno_inicial; });
}

// ─── Estado buttons ───────────────────────────────────────────────────────────
function _estado_buttons(frm) {
	if (frm.is_new()) return;
	if (frm.doc.estado === "Rascunho") {
		frm.add_custom_button(__("Activar"), () => _set_estado(frm, "Activo"), __("Estado"));
	}
	if (frm.doc.estado === "Activo") {
		frm.add_custom_button(__("Arquivar"), () => {
			frappe.confirm(__("Arquivar esta escala? Deixará de gerar e de ser usada."), () =>
				_set_estado(frm, "Arquivado"));
		}, __("Estado"));
	}
	if (frm.doc.estado === "Arquivado") {
		frm.add_custom_button(__("Reactivar"), () => _set_estado(frm, "Activo"), __("Estado"));
	}
}

function _set_estado(frm, novo) {
	// freeze: true blocks the whole page (native buttons AND the deck's own) for the
	// round trip — without it, the button's label flips as soon as reload_doc() lands
	// (Activar -> Arquivar in the same spot), so an impatient double-click can land on
	// the NEW action instead of a repeat of the one just clicked (e.g. activating then
	// immediately archiving, with no visible feedback in between to explain why).
	frappe.call({
		method: "frappe.client.set_value",
		args: { doctype: "Escala Do Vigilante", name: frm.doc.name, fieldname: "estado", value: novo },
		freeze: true,
		freeze_message: __("A actualizar estado..."),
		callback: () => frm.reload_doc(),
	});
}

// ─── Sync guards from posto (or, for tipo_de_escala == "Reserva", from
// delegação + status Reserva), with STAGGERED turnos for coverage ─────────────
function _sincronizar_vigilantes(frm) {
	const reserva = frm.doc.tipo_de_escala === "Reserva";

	if (reserva) {
		if (!frm.doc.delegacao || !frm.doc.regime_do_vigilante) {
			frappe.msgprint(__("Defina a Delegação e o Regime primeiro."));
			return;
		}
	} else if (!frm.doc.posto_de_vigilancia || !frm.doc.regime_do_vigilante) {
		frappe.msgprint(__("Defina o Posto e o Regime primeiro."));
		return;
	}

	// Reserva guards have NO regime_do_vigilante of their own while benched
	// (cleared same as posto — see vigilante.py CAMPOS_OPERACIONAIS_RESERVA), so
	// the shared Regime here is a property of THIS escala, not of each guard —
	// filtering by delegação + status is the complete match, unlike the Posto
	// branch which also matches the guard's own regime.
	const filters = reserva
		? [["delegacao", "=", frm.doc.delegacao], ["status", "=", "Reserva"]]
		: [
			["posto_de_vigilancia", "=", frm.doc.posto_de_vigilancia],
			["regime_do_vigilante", "=", frm.doc.regime_do_vigilante],
			["status", "=", "Activo"],
		];

	frappe.call({
		method: "frappe.client.get_list",
		args: {
			doctype: "Vigilante",
			filters,
			fields: ["name", "nome_completo"],
			limit_page_length: 0,
		},
		callback(r) {
			const guards = r.message || [];
			if (!guards.length) {
				frappe.msgprint(reserva
					? __("Nenhum vigilante em Reserva nesta delegação.")
					: __("Nenhum vigilante activo neste posto e regime."));
				return;
			}

			// Drop rows that no longer belong to this posto/regime (e.g. posto was
			// changed on the doc) — otherwise sync only ever appends, leaving stale
			// guards from a previous posto mixed in with the new ones.
			const guardNames = new Set(guards.map(g => g.name));
			const antes = (frm.doc.tab_vigilante_do_posto || []).length;
			frm.doc.tab_vigilante_do_posto = (frm.doc.tab_vigilante_do_posto || [])
				.filter(row => guardNames.has(row.vigilante));
			frm.doc.tab_vigilante_do_posto.forEach((row, i) => { row.idx = i + 1; });
			const removidos = antes - frm.doc.tab_vigilante_do_posto.length;
			if (removidos) frm.dirty();

			frappe.call({
				method: "sigos.api.get_regime_turnos",
				args: { regime: frm.doc.regime_do_vigilante },
				callback(res) {
					const seq = res.message || [];
					if (!seq.length) { frappe.msgprint(__("Regime sem turnos.")); return; }
					const L = seq.length;

					const rowsPorNome = new Map(
						(frm.doc.tab_vigilante_do_posto || []).map(row => [row.vigilante, row])
					);

					// Evenly space UNITS across the FULL cycle, not just the next slots in
					// sequence order — e.g. 3 units on a 6-slot H24 cycle (1a/2a Manhã, 1a/2a
					// Noite, 1a/2a Folga) land on 1a Manhã / 1a Noite / 1a Folga (one of each
					// type) instead of piling into the first 3 slots.
					//
					// Turno da Equipa (customer-specific): a UNIT is a whole equipa, not a
					// single guard, so every member of the same team always lands on the same
					// slot (server-side _sincronizar_turno_por_equipa is the ultimate
					// authority — this just avoids the sync button visibly scrambling teammates
					// apart first). Guards without an equipa tag are their own unit, same as
					// before — lets HR bulk-add first, tag teams after.
					const equipaAtiva = !!_turno_equipa_activo;
					const jaColocados = guards.map(g => g.name).filter(n => rowsPorNome.has(n));
					const novos = guards.map(g => g.name).filter(n => !rowsPorNome.has(n));

					const unidades = [];
					const unidadePorEquipa = new Map();
					jaColocados.forEach(nome => {
						const equipa = equipaAtiva ? rowsPorNome.get(nome).turno_equipa : null;
						if (equipa) {
							let u = unidadePorEquipa.get(equipa);
							if (!u) { u = { membros: [] }; unidadePorEquipa.set(equipa, u); unidades.push(u); }
							u.membros.push(nome);
						} else {
							unidades.push({ membros: [nome] });
						}
					});
					// Keep already-placed units in their current relative order (by where
					// their existing slot sits in the cycle) so an unchanged roster is a
					// no-op; new guards (never yet tagged with an equipa) are appended after,
					// each their own unit, in server return order.
					unidades.sort((a, b) =>
						seq.findIndex(t => t.turno === rowsPorNome.get(a.membros[0]).turno_inicial) -
						seq.findIndex(t => t.turno === rowsPorNome.get(b.membros[0]).turno_inicial));
					novos.forEach(nome => unidades.push({ membros: [nome], nova: true }));

					const Nu = unidades.length;
					const alvo = Array.from({ length: Nu }, (_, i) => seq[Math.round(i * L / Nu) % L].turno);

					const porNome = new Map(guards.map(g => [g.name, g]));
					let adicionados = 0, reequilibrados = 0;
					unidades.forEach((u, i) => {
						const slot = alvo[i];
						u.membros.forEach(nome => {
							let row = rowsPorNome.get(nome);
							if (!row) {
								row = frm.add_child("tab_vigilante_do_posto");
								row.vigilante     = nome;
								row.nome_completo = porNome.get(nome).nome_completo;
								row.turno_inicial = slot;
								adicionados++;
								return;
							}
							if (row.turno_inicial !== slot) {
								row.turno_inicial = slot;
								reequilibrados++;
							}
						});
					});

					frm.refresh_field("tab_vigilante_do_posto");
					_snapshot_slots(frm);
					const partes = [`${adicionados} vigilante(s) adicionado(s)`];
					if (removidos) partes.push(`${removidos} removido(s)`);
					if (reequilibrados) partes.push(`${reequilibrados} reequilibrado(s)`);
					frappe.show_alert({
						message: __(`${partes.join(", ")} — turnos escalonados. Reveja e guarde.`),
						indicator: (adicionados || removidos || reequilibrados) ? "green" : "blue",
					}, 5);
				},
			});
		},
	});
}

// ─── Bulk turno assignment ────────────────────────────────────────────────────
function _distribuir_turnos(frm) {
	const guards = frm.doc.tab_vigilante_do_posto || [];
	if (!guards.length) {
		frappe.msgprint(__("Sincronize ou adicione vigilantes primeiro."));
		return;
	}
	if (!frm.doc.regime_do_vigilante) {
		frappe.msgprint(__("Defina o Regime primeiro."));
		return;
	}

	frappe.xcall("sigos.api.get_regime_turnos", { regime: frm.doc.regime_do_vigilante }).then(seq => {
		seq = seq || [];
		if (!seq.length) { frappe.msgprint(__("Regime sem turnos.")); return; }

		const opts = "\n" + seq.map(t => t.turno).join("\n");

		// Turno da Equipa (customer-specific): group guards into UNITS so a whole team
		// is edited — and staggered — as one, every member always getting the same
		// turno_inicial. Guards without an equipa tag are their own unit, same as before.
		const equipaAtiva = !!_turno_equipa_activo;
		const unidades = [];
		const porEquipa = new Map();
		guards.forEach(g => {
			const equipa = equipaAtiva ? g.turno_equipa : null;
			if (equipa) {
				let u = porEquipa.get(equipa);
				if (!u) {
					u = { rotulo: equipa, membros: [], turno_inicial: g.turno_inicial };
					porEquipa.set(equipa, u);
					unidades.push(u);
				}
				u.membros.push(g);
			} else {
				unidades.push({ rotulo: g.nome_completo || g.vigilante, membros: [g], turno_inicial: g.turno_inicial });
			}
		});

		// One Select per unit, pre-filled with its current turno_inicial
		const fields = [
			{
				fieldname: "info", fieldtype: "HTML",
				options: `<div style="margin-bottom:6px;color:#555;">
					${__("Atribua o turno inicial de cada " + (equipaAtiva ? "equipa/vigilante" : "vigilante") + ". Use <b>Escalonar Automaticamente</b> para distribuir em sequência (cobertura ideal).")}
				</div>`,
			},
		];
		unidades.forEach((u, i) => {
			fields.push({
				fieldname: `t_${i}`,
				fieldtype: "Select",
				label: u.membros.length > 1 ? `${u.rotulo} (${u.membros.length})` : u.rotulo,
				options: opts,
				default: u.turno_inicial || "",
			});
		});

		const d = new frappe.ui.Dialog({
			title: __("Distribuir Turnos em Bloco"),
			fields,
			primary_action_label: __("Aplicar"),
			primary_action(v) {
				// Warn on duplicates across units (not blocking — overstaffed postos may
				// repeat); teammates sharing a value is expected, not a duplicate here.
				const vals = unidades.map((u, i) => v[`t_${i}`]);
				unidades.forEach((u, i) => {
					u.membros.forEach(g => {
						frappe.model.set_value(g.doctype, g.name, "turno_inicial", v[`t_${i}`] || null);
					});
				});
				frm.refresh_field("tab_vigilante_do_posto");
				_snapshot_slots(frm);

				const dups = vals.filter((x, i) => x && vals.indexOf(x) !== i);
				if (dups.length) {
					frappe.show_alert({
						message: __(`Atenção: turnos repetidos (${[...new Set(dups)].join(", ")}) — pode causar cobertura duplicada.`),
						indicator: "orange",
					}, 6);
				} else {
					frappe.show_alert({ message: __("Turnos atribuídos. Guarde para gerar."), indicator: "green" }, 4);
				}
				d.hide();
			},
			secondary_action_label: __("Escalonar Automaticamente"),
			secondary_action() {
				// Stagger by unit order: unit i → sequence[i % L]
				unidades.forEach((u, i) => {
					d.set_value(`t_${i}`, seq[i % seq.length].turno);
				});
			},
		});
		d.show();
	});
}

// ─── Combined Equipas & Turnos modal (customer-specific, turno_equipa_activo) ──
// One live-updating view that does both halves at once: tag each guard into a
// Turno Da Equipa, AND set each team's shared turno_inicial — every member's
// turno updates on screen the instant their team's turno changes, before
// anything is written back to the form. (_sincronizar_turno_por_equipa remains
// the server-side authority; this is just a nicer way to arrive at the same
// end-state in one pass instead of two separate dialogs.)
function _atribuir_equipas(frm) {
	const guards = frm.doc.tab_vigilante_do_posto || [];
	if (!guards.length) {
		frappe.msgprint(__("Sincronize ou adicione vigilantes primeiro."));
		return;
	}
	if (!frm.doc.regime_do_vigilante) {
		frappe.msgprint(__("Defina o Regime primeiro."));
		return;
	}

	Promise.all([
		frappe.xcall("sigos.api.get_regime_turnos", { regime: frm.doc.regime_do_vigilante }),
		frappe.db.get_list("Turno Da Equipa", { filters: { activo: 1 }, fields: ["name"], order_by: "name asc", limit: 0 }),
	]).then(([seq, equipasRaw]) => {
		seq = seq || [];
		if (!seq.length) { frappe.msgprint(__("Regime sem turnos.")); return; }
		if (!equipasRaw.length) {
			frappe.msgprint(__("Nenhuma Turno da Equipa activa. Crie as equipas primeiro (ex: Equipa A, B, C)."));
			return;
		}

		_inject_equipas_modal_css();

		const CORES = ["#7a5ee0", "#1f9d7c", "#d6336c", "#c9821a", "#3a7ec5", "#5a3fc0"];
		const equipas = equipasRaw.map((e, i) => ({ nome: e.name, cor: CORES[i % CORES.length], turno: null }));
		const equipaByName = new Map(equipas.map(e => [e.nome, e]));
		const turnoOpts = seq.map(t => t.turno);

		const model = guards.map(g => ({ row: g, nome: g.nome_completo || g.vigilante, equipa: g.turno_equipa || null }));
		// Seed each equipa's turno from whichever member already has one set, so
		// re-opening the dialog picks up where the roster currently stands.
		model.forEach(m => {
			if (m.equipa && m.row.turno_inicial && equipaByName.has(m.equipa) && !equipaByName.get(m.equipa).turno) {
				equipaByName.get(m.equipa).turno = m.row.turno_inicial;
			}
		});

		const d = new frappe.ui.Dialog({
			title: __("Equipas & Turnos"),
			size: "large",
			fields: [{ fieldname: "body", fieldtype: "HTML" }],
			primary_action_label: __("Aplicar"),
			primary_action() {
				model.forEach(m => {
					const turno = m.equipa ? (equipaByName.get(m.equipa)?.turno || null) : m.row.turno_inicial;
					frappe.model.set_value(m.row.doctype, m.row.name, "turno_equipa", m.equipa || null);
					frappe.model.set_value(m.row.doctype, m.row.name, "turno_inicial", turno || null);
				});
				frm.refresh_field("tab_vigilante_do_posto");
				frappe.show_alert({ message: __("Equipas e turnos atribuídos. Guarde para gerar."), indicator: "green" }, 5);
				d.hide();
			},
		});
		d.show();
		_render_equipas_modal(d.fields_dict.body.$wrapper, { model, equipas, equipaByName, turnoOpts });
	});
}

function _render_equipas_modal($body, ctx) {
	const { model, equipas, equipaByName, turnoOpts } = ctx;
	const esc = frappe.utils.escape_html;

	const turnoOptsHtml = `<option value="">${__("— turno —")}</option>` +
		turnoOpts.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
	const equipaOptsHtml = `<option value="">${__("— sem equipa —")}</option>` +
		equipas.map(e => `<option value="${esc(e.nome)}">${esc(e.nome)}</option>`).join("");

	$body.html(`
		<div id="sigos-eq-modal">
			<div class="eqm-hint">${__("Atribua cada vigilante a uma equipa e o turno de cada equipa — os membros herdam automaticamente o turno da sua equipa.")}</div>
			<div class="eqm-quick">
				<button type="button" class="eqm-qbtn" data-qact="split">${__("Repartir Equipas Automaticamente")}</button>
				<button type="button" class="eqm-qbtn" data-qact="stagger">${__("Escalonar Turnos das Equipas")}</button>
			</div>
			<div class="eqm-teams" data-eqm-teams></div>
			<table class="eqm-table">
				<thead><tr><th>${__("Vigilante")}</th><th>${__("Equipa")}</th><th>${__("Turno")}</th></tr></thead>
				<tbody data-eqm-rows></tbody>
			</table>
		</div>
	`);

	const $teams = $body.find("[data-eqm-teams]");
	const $rows = $body.find("[data-eqm-rows]");
	const turnoDe = (m) => m.equipa ? (equipaByName.get(m.equipa)?.turno || null) : m.row.turno_inicial;

	function redrawTeams() {
		$teams.empty();
		equipas.forEach(e => {
			const n = model.filter(m => m.equipa === e.nome).length;
			const $card = $(`
				<div class="eqm-team" style="--eqm-c:${e.cor}">
					<span class="eqm-team-dot"></span>
					<span class="eqm-team-name">${esc(e.nome)}</span>
					<span class="eqm-team-n">${n} ${n === 1 ? __("vigilante") : __("vigilantes")}</span>
					<select class="eqm-team-turno">${turnoOptsHtml}</select>
				</div>
			`);
			$card.find("select").val(e.turno || "").on("change", function () {
				e.turno = $(this).val() || null;
				redrawRows();
			});
			$teams.append($card);
		});
	}

	function redrawRows() {
		$rows.empty();
		model.forEach((m) => {
			const turno = turnoDe(m);
			const cor = m.equipa ? (equipaByName.get(m.equipa)?.cor || "") : "";
			const $tr = $(`
				<tr>
					<td>${esc(m.nome)}</td>
					<td><select class="eqm-row-equipa">${equipaOptsHtml}</select></td>
					<td><span class="eqm-row-turno"${cor ? ` style="--eqm-c:${cor}"` : ""}>${turno ? esc(turno) : "—"}</span></td>
				</tr>
			`);
			$tr.find("select").val(m.equipa || "").on("change", function () {
				m.equipa = $(this).val() || null;
				redrawTeams();
				redrawRows();
			});
			$rows.append($tr);
		});
	}

	$body.find('[data-qact="split"]').on("click", () => {
		model.forEach((m, i) => { m.equipa = equipas[i % equipas.length].nome; });
		redrawTeams();
		redrawRows();
	});
	$body.find('[data-qact="stagger"]').on("click", () => {
		equipas.forEach((e, i) => { e.turno = turnoOpts[i % turnoOpts.length]; });
		redrawRows();
	});

	redrawTeams();
	redrawRows();
}

function _inject_equipas_modal_css() {
	if (document.getElementById("sigos-eq-modal-css")) return;
	const css = `
#sigos-eq-modal { font-size: 13px; }
.eqm-hint { color: var(--text-muted, #8d99a6); margin-bottom: 12px; font-size: .92em; }
.eqm-quick { display: flex; gap: 8px; margin-bottom: 14px; }
.eqm-qbtn {
	border: 1px solid var(--border-color, #d1d8dd); background: var(--fg-color, #fff);
	border-radius: 8px; padding: 6px 12px; font-size: .82em; font-weight: 600; cursor: pointer;
}
.eqm-qbtn:hover { border-color: #7a5ee0; color: #7a5ee0; }
.eqm-teams { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
.eqm-team {
	display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 10px;
	background: var(--fg-color, #fff); border: 1px solid var(--border-color, #d1d8dd);
	flex: 1 1 220px; min-width: 210px;
}
.eqm-team-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--eqm-c, #999); flex: none; }
.eqm-team-name { font-weight: 700; flex: 1; }
.eqm-team-n { font-size: .78em; color: var(--text-muted, #8d99a6); white-space: nowrap; }
.eqm-team-turno { border: 1px solid var(--border-color, #d1d8dd); border-radius: 6px; padding: 3px 6px; font-size: .85em; max-width: 110px; }
.eqm-table { width: 100%; border-collapse: collapse; }
.eqm-table th {
	text-align: left; font-size: .75em; text-transform: uppercase; letter-spacing: .04em;
	color: var(--text-muted, #8d99a6); padding: 4px 8px; border-bottom: 1px solid var(--border-color, #d1d8dd);
}
.eqm-table td { padding: 5px 8px; border-bottom: 1px solid var(--border-color, #ecf0f2); }
.eqm-row-equipa { width: 100%; border: 1px solid var(--border-color, #d1d8dd); border-radius: 6px; padding: 3px 6px; font-size: .85em; }
.eqm-row-turno { font-weight: 700; font-size: .85em; }
.eqm-row-turno[style*="--eqm-c"] { color: var(--eqm-c); }
`;
	$(`<style id="sigos-eq-modal-css">${css}</style>`).appendTo("head");
}

// ─── Grid render (loads regime info first for the coverage row) ───────────────
function _load_and_render(frm) {
	if (!frm.doc.regime_do_vigilante) { _render_grid(frm, null, []); return; }
	const licencas = (frm.doc.name && !frm.is_new())
		? frappe.xcall("sigos.api.licencas_na_escala", { escala_name: frm.doc.name }).catch(() => ({}))
		: Promise.resolve({});
	// Fetched unconditionally (cheap, small table) rather than gated on
	// turno_equipa_activo — on non-team escalas every row's turno_equipa is
	// simply empty, so the label suffix is a no-op either way.
	const equipas = frappe.db.get_list("Turno Da Equipa", { fields: ["name", "codigo"], limit_page_length: 0 })
		.catch(() => []);
	Promise.all([
		frappe.db.get_value("Regime", frm.doc.regime_do_vigilante, "tipo_ciclo"),
		frappe.xcall("sigos.api.get_regime_turnos", { regime: frm.doc.regime_do_vigilante }),
		licencas,
		equipas,
	]).then(([tc, seq, lic, eqs]) => {
		frm._esc_licencas = lic || {};
		const equipaLabel = {};
		(eqs || []).forEach(e => { equipaLabel[e.name] = _short_equipa(e.name, e.codigo); });
		_render_grid(frm, tc?.message?.tipo_ciclo || null, seq || [], equipaLabel);
	});
}

// Short display label for a Turno Da Equipa: its own codigo if set, otherwise
// the name with a leading "Equipa " (or similar) stripped — "Equipa A" -> "A".
function _short_equipa(nome, codigo) {
	if (codigo) return codigo;
	const m = (nome || "").match(/\S+$/);
	return m ? m[0] : (nome || "");
}

// "24" + "Equipa A" -> "24 - A"; no equipa -> just the turno, unchanged.
function _turno_com_equipa(turno, turnoEquipa, equipaLabel) {
	if (!turnoEquipa) return turno;
	const lbl = (equipaLabel && equipaLabel[turnoEquipa]) || turnoEquipa;
	return `${turno} - ${lbl}`;
}

// Read-only "on approved leave" flag for a guard/day — returns the Leave Type
// name (or null). Does not change the scheduled turno; any Leave Type flags the
// cell, not just "Ferias".
function _licenca_do_dia(frm, vig, d) {
	return (frm._esc_licencas && frm._esc_licencas[`${vig}|${d}`]) || null;
}
const _SEM_ACENTO = {
	"a": "aàáâã", "e": "eèéê", "i": "iìí", "o": "oòóôõ", "u": "uùú", "c": "cç",
};
function _abrev_licenca(tipo) {
	if (!tipo) return "LIC";
	// Strip diacritics (Ferias -> FER, not the visually-odd "FRI" you'd get by
	// just dropping accented letters outright) via an explicit lookup table.
	let limpo = tipo.toLowerCase();
	Object.keys(_SEM_ACENTO).forEach((base) => {
		[..._SEM_ACENTO[base]].slice(1).forEach((acc) => { limpo = limpo.split(acc).join(base); });
	});
	const letras = (limpo.match(/[a-z]/g) || []).slice(0, 3).join("");
	return (letras || "LIC").toUpperCase();
}
function _badge_licenca(tipo) {
	if (!tipo) return "";
	const esc = frappe.utils.escape_html(tipo);
	return `<span class="esc-fer-badge" title="${esc} (aprovada)">${_abrev_licenca(tipo)}</span>`;
}

const _PERIODO_CLS = { "Manhã": "cell-manha", "Noite": "cell-noite", "Tarde": "cell-tarde", "Único": "cell-outro" };
const _DOW = ["D", "S", "T", "Q", "Q", "S", "S"];
const _MES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function _render_grid(frm, tipo_ciclo, seq, equipaLabel) {
	_inject_ferias_css();
	// Cache for instant re-render when the range/week changes
	frm._esc_tc = tipo_ciclo;
	frm._esc_seq = seq;
	frm._esc_equipaLabel = equipaLabel || frm._esc_equipaLabel || {};
	if (frm._esc_range === undefined) frm._esc_range = "7";

	const wrapper = frm.fields_dict.grid_escala?.$wrapper;
	if (!wrapper) return;

	const rows = frm.doc.tabela_de_escala || [];
	if (!rows.length) {
		wrapper.html(`<div class="esc-empty-state">
			<div class="esc-empty-icon">📅</div>
			<div class="esc-empty-title">${__("Sem escala gerada")}</div>
			<div class="esc-empty-sub">${__("Sincronize os vigilantes, defina o turno inicial e clique em <b>Gerar / Estender Escala</b>.")}</div>
		</div>`);
		_update_deck_stats(frm, null, tipo_ciclo);
		return;
	}

	const hoje = frappe.datetime.get_today();
	const todasDatas = [...new Set(rows.map(r => r.data))].sort();

	const guardOrder = (frm.doc.tab_vigilante_do_posto || []).map(g => g.vigilante);
	const guardsInRows = [...new Set(rows.map(r => r.vigilante))];
	const guards = guardOrder.filter(g => guardsInRows.includes(g))
		.concat(guardsInRows.filter(g => !guardOrder.includes(g)));

	const nameMap = {};
	(frm.doc.tab_vigilante_do_posto || []).forEach(g => { nameMap[g.vigilante] = g.nome_completo || g.vigilante; });

	const cellMap = {};
	rows.forEach(r => { cellMap[`${r.vigilante}|${r.data}`] = r; });

	// Turnos flagged e_folga in the regime — used to tell a real rest day apart
	// from a working turno whose período has no dedicated colour yet (e.g. a
	// team-rostered "24"/Único turno) so the latter never gets styled grey.
	const folgaTurnos = new Set((seq || []).filter(s => s.e_folga).map(s => s.turno));

	const ctx = { frm, tipo_ciclo, seq, todasDatas, guards, nameMap, cellMap, hoje, folgaTurnos, equipaLabel: frm._esc_equipaLabel };

	_update_deck_stats(frm, ctx, tipo_ciclo);

	const toolbar = _render_toolbar(frm);
	if (frm._esc_range === "7") {
		_render_week(wrapper, toolbar, ctx);
	} else {
		_render_compact(wrapper, toolbar, ctx);
	}

	// Range toggle (shared)
	wrapper.find(".esc-range-btn").on("click", function () {
		frm._esc_range = $(this).attr("data-range");
		frm._esc_week_start = undefined;   // reset week nav on mode change
		_render_grid(frm, frm._esc_tc, frm._esc_seq, frm._esc_equipaLabel);
	});

	_bind_cell_clicks(frm, wrapper, hoje);
}

// ─── Coverage helper (shared) ─────────────────────────────────────────────────
// Coverage is per PERÍODO, not per turno-slot: "1a Manhã" vs "2a Manhã" is just
// the guard's position in the rotation — the posto needs at least ONE guard on
// Manhã and ONE on Noite (and Tarde, if the regime has it) each day.
function _coverage_for_day(d, ctx) {
	const periodoDe = {};   // working turno -> its período (falls back to its own
	// name when the Turno has no categorical período set — e.g. a team-rostered
	// "24" turno — so coverage still works without requiring that field filled in)
	(ctx.seq || []).forEach(s => { if (!s.e_folga) periodoDe[s.turno] = s.periodo || s.turno; });
	const periodos = [...new Set(Object.values(periodoDe))];
	if (!periodos.length) return null;

	const counts = {};
	ctx.guards.forEach(vig => {
		const r = ctx.cellMap[`${vig}|${d}`];
		const p = r && periodoDe[r.turno];   // folga rows don't count
		if (p) counts[p] = (counts[p] || 0) + 1;
	});

	const gap = periodos.filter(p => !counts[p]);
	const dbl = periodos.filter(p => (counts[p] || 0) > 1);
	if (gap.length) return { icon: "▲", cls: "cov-gap",    tip: "Sem cobertura: " + gap.join(", ") };
	if (dbl.length) return { icon: "●", cls: "cov-double", tip: "Mais de um vigilante: " + dbl.join(", ") };
	return { icon: "✓", cls: "cov-ok", tip: "Todos os períodos cobertos" };
}

function _coverage_legend(tipo_ciclo) {
	if (tipo_ciclo !== "Rotativo") return "";
	return `
		<div class="esc-cobertura-help">
			<span class="esc-ch-title">${__("Cobertura")}</span>
			<span class="esc-ch-desc">${__("cada período do dia tem vigilante?")}</span>
			<span class="esc-ch-item"><span class="esc-ch-dot cov-ok">✓</span> ${__("completo")}</span>
			<span class="esc-ch-item"><span class="esc-ch-dot cov-gap">▲</span> ${__("falta alguém")}</span>
			<span class="esc-ch-item"><span class="esc-ch-dot cov-double">●</span> ${__("a mais")}</span>
		</div>`;
}

function _legend(tipo_ciclo) {
	return `
		<div class="esc-legend">
			<span class="esc-lg cell-manha">Manhã</span>
			<span class="esc-lg cell-noite">Noite</span>
			<span class="esc-lg cell-tarde">Tarde</span>
			<span class="esc-lg cell-outro">${__("Único / Outro")}</span>
			<span class="esc-lg cell-folga">Folga</span>
			<span class="esc-lg esc-override-lg">Manual</span>
			<span class="esc-lg esc-ferias-lg">Licença</span>
		</div>
		${_coverage_legend(tipo_ciclo)}`;
}

// ─── WEEKLY board — spacious, navigable, full labels ──────────────────────────
const _DOW_FULL = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function _week_window(frm, todasDatas, hoje) {
	// Anchor: stored start, else first date >= today, else first date
	let start = frm._esc_week_start;
	if (!start || todasDatas.indexOf(start) < 0) {
		const futureIdx = todasDatas.findIndex(d => d >= hoje);
		start = todasDatas[futureIdx >= 0 ? futureIdx : 0];
	}
	let s = todasDatas.indexOf(start);
	if (s < 0) s = 0;
	return { start: s, dias: todasDatas.slice(s, s + 7) };
}

function _render_week(wrapper, toolbar, ctx) {
	const { frm, tipo_ciclo, todasDatas, guards, nameMap, cellMap, hoje } = ctx;
	const { start, dias } = _week_window(frm, todasDatas, hoje);

	const canPrev = start > 0;
	const canNext = start + 7 < todasDatas.length;

	const fmtRange = () => {
		if (!dias.length) return "";
		const a = new Date(dias[0]), b = new Date(dias[dias.length - 1]);
		const fa = `${a.getDate()} ${_MES[a.getMonth()]}`;
		const fb = `${b.getDate()} ${_MES[b.getMonth()]} ${b.getFullYear()}`;
		return `${fa} – ${fb}`;
	};

	const nav = `
		<div class="esc-week-nav">
			<button class="esc-wk-btn" data-wk="prev" ${canPrev ? "" : "disabled"}>‹ ${__("Anterior")}</button>
			<span class="esc-wk-range">${fmtRange()}</span>
			<button class="esc-wk-btn" data-wk="next" ${canNext ? "" : "disabled"}>${__("Próxima")} ›</button>
		</div>`;

	// Header row
	let head = `<th class="esc-wk-name">${__("Vigilante")}</th>`;
	dias.forEach(d => {
		const dt = new Date(d), dow = dt.getDay();
		const we = dow === 0 || dow === 6, td = d === hoje;
		head += `<th class="esc-wk-dayhead ${we ? "esc-wk-weekend" : ""} ${td ? "esc-wk-today" : ""}">
			<div class="esc-wk-dow">${_DOW_FULL[dow]}</div>
			<div class="esc-wk-dnum">${dt.getDate()}</div>
		</th>`;
	});

	// Precompute weekend flag per day so the column tint runs down the whole table
	const weekend = dias.map(d => { const w = new Date(d).getDay(); return w === 0 || w === 6; });
	const weCls = i => weekend[i] ? "esc-wk-weekend-col" : "";

	// Coverage row
	let cov = "";
	if (tipo_ciclo === "Rotativo") {
		cov = `<tr class="esc-wk-covrow"><td class="esc-wk-name">${__("Cobertura")}</td>`;
		dias.forEach(d => {
			const c = _coverage_for_day(d, ctx);
			cov += c
				? `<td class="esc-wk-cov ${c.cls}" title="${c.tip}">${c.icon}</td>`
				: `<td class="esc-wk-cov"></td>`;
		});
		cov += `</tr>`;
	}

	// Guard rows — big cells with full turno labels, staggered entrance
	let body = cov;
	guards.forEach((vig, gi) => {
		body += `<tr class="esc-wk-row" style="animation-delay:${Math.min(gi * 28, 320)}ms">
			<td class="esc-wk-name" title="${vig}">${nameMap[vig] || vig}</td>`;
		dias.forEach((d, di) => {
			const r = cellMap[`${vig}|${d}`];
			const isPast = d < hoje;
			const lic = _licenca_do_dia(frm, vig, d);
			const ferCls = lic ? "esc-wk-fer" : "";
			const ferBadge = _badge_licenca(lic);
			if (!r) {
				body += `<td class="esc-wk-cell esc-wk-blank ${ferCls} ${weCls(di)} ${isPast ? "esc-wk-past" : ""}">${ferBadge}</td>`;
			} else {
				const cls = _PERIODO_CLS[r.periodo] || (ctx.folgaTurnos.has(r.turno) ? "cell-folga" : "cell-outro");
				const ovr = r.override ? "esc-wk-override" : "";
				body += `<td class="esc-wk-cell ${ferCls} ${weCls(di)} ${isPast ? "esc-wk-past" : ""}"
					${isPast ? "" : `data-vig="${vig}" data-data="${d}"`}>
					${ferBadge}
					<div class="esc-wk-chip ${cls} ${ovr}" title="${_turno_com_equipa(r.turno, r.turno_equipa, ctx.equipaLabel)}${r.override ? " (manual)" : ""}">
						${frappe.utils.escape_html(_turno_com_equipa(r.turno, r.turno_equipa, ctx.equipaLabel))}${r.override ? ' <span class="esc-wk-star">✎</span>' : ""}
					</div>
				</td>`;
			}
		});
		body += `</tr>`;
	});

	wrapper.html(`
		${toolbar}
		${nav}
		<div class="esc-wk-wrap">
			<table class="esc-wk-table">
				<thead><tr>${head}</tr></thead>
				<tbody>${body}</tbody>
			</table>
		</div>
		${_legend(tipo_ciclo)}`);

	wrapper.find('.esc-wk-btn[data-wk="prev"]').on("click", () => {
		frm._esc_week_start = todasDatas[Math.max(0, start - 7)];
		_render_grid(frm, frm._esc_tc, frm._esc_seq, frm._esc_equipaLabel);
	});
	wrapper.find('.esc-wk-btn[data-wk="next"]').on("click", () => {
		frm._esc_week_start = todasDatas[Math.min(todasDatas.length - 1, start + 7)];
		_render_grid(frm, frm._esc_tc, frm._esc_seq, frm._esc_equipaLabel);
	});
}

// ─── COMPACT dense grid — month / full overview ───────────────────────────────
function _render_compact(wrapper, toolbar, ctx) {
	const { tipo_ciclo, todasDatas, guards, nameMap, cellMap, hoje } = ctx;
	const datas = ctx.frm._esc_range === "all" ? todasDatas : todasDatas.slice(0, 30);

	// Month header
	let mesHeader = `<th class="esc-name-col"></th>`;
	let curMes = null, span = 0;
	const flushMes = () => {
		if (curMes !== null) {
			const [y, m] = curMes.split("-");
			mesHeader += `<th colspan="${span}" class="esc-mes">${_MES[parseInt(m) - 1]} ${y}</th>`;
		}
	};
	datas.forEach(d => { const ym = d.slice(0, 7); if (ym !== curMes) { flushMes(); curMes = ym; span = 0; } span++; });
	flushMes();

	// Day header
	let dayHeader = `<th class="esc-name-col">${__("Vigilante")}</th>`;
	datas.forEach(d => {
		const dt = new Date(d); const dow = dt.getDay();
		const we = dow === 0 || dow === 6; const td = d === hoje;
		dayHeader += `<th class="esc-day ${we ? "esc-weekend" : ""} ${td ? "esc-today" : ""}">
			<div class="esc-dow">${_DOW[dow]}</div><div class="esc-dnum">${dt.getDate()}</div></th>`;
	});

	// Coverage row
	let coverageRow = "";
	if (tipo_ciclo === "Rotativo") {
		coverageRow = `<tr class="esc-cov-row"><td class="esc-name-col">${__("Cobertura")}</td>`;
		datas.forEach(d => {
			const c = _coverage_for_day(d, ctx);
			coverageRow += c
				? `<td class="esc-cov ${c.cls}" title="${c.tip}">${c.icon}</td>`
				: `<td class="esc-cov"></td>`;
		});
		coverageRow += `</tr>`;
	}

	// Body
	let body = coverageRow;
	guards.forEach(vig => {
		body += `<tr><td class="esc-name-col" title="${vig}">${nameMap[vig] || vig}</td>`;
		datas.forEach(d => {
			const r = cellMap[`${vig}|${d}`];
			const isPast = d < hoje;
			const lic = _licenca_do_dia(ctx.frm, vig, d);
			const ferCls = lic ? "esc-fer" : "";
			if (!r) {
				body += `<td class="esc-cell esc-empty ${ferCls} ${isPast ? "esc-pastcell" : ""}"></td>`;
			} else {
				const cls = _PERIODO_CLS[r.periodo] || (ctx.folgaTurnos.has(r.turno) ? "cell-folga" : "cell-outro");
				const ovr = r.override ? "esc-override" : "";
				const fTitle = lic ? ` · ${frappe.utils.escape_html(lic)}` : "";
				const eqShort = r.turno_equipa ? (ctx.equipaLabel?.[r.turno_equipa] || r.turno_equipa) : "";
				const abbr = _abbr(r.turno) + (eqShort ? `·${eqShort}` : "");
				body += `<td class="esc-cell ${cls} ${ovr} ${ferCls} ${isPast ? "esc-pastcell" : ""}"
					data-vig="${vig}" data-data="${d}" title="${_turno_com_equipa(r.turno, r.turno_equipa, ctx.equipaLabel)}${r.override ? " (manual)" : ""}${fTitle}">${frappe.utils.escape_html(abbr)}</td>`;
			}
		});
		body += `</tr>`;
	});

	wrapper.html(`
		${toolbar}
		<div class="esc-grid-wrap">
			<table class="esc-grid">
				<thead><tr>${mesHeader}</tr><tr>${dayHeader}</tr></thead>
				<tbody>${body}</tbody>
			</table>
		</div>
		${_legend(tipo_ciclo)}`);
}

function _bind_cell_clicks(frm, wrapper, hoje) {
	wrapper.find("[data-vig][data-data]").on("click", function () {
		const vig = $(this).attr("data-vig");
		const data = $(this).attr("data-data");
		if (!vig || !data) return;
		if (data < hoje) {
			frappe.show_alert({ message: __("Não é possível editar dias passados."), indicator: "orange" }, 3);
			return;
		}
		_override_dialog(frm, vig, data);
	});
}

// ─── Toolbar (range toggle) ────────────────────────────────────────────────────
function _render_toolbar(frm) {
	const ranges = [["7", __("Semana")], ["30", __("Mês")], ["all", __("Tudo")]];
	const btns = ranges.map(([val, label]) =>
		`<button class="esc-range-btn ${frm._esc_range === val ? "esc-range-active" : ""}" data-range="${val}">${label}</button>`
	).join("");
	return `
		<div class="esc-toolbar">
			<div class="esc-range-group">${btns}</div>
			<div class="esc-showing">${frm._esc_range === "7"
				? __("Vista semanal — navegue com ‹ ›")
				: (frm._esc_range === "30" ? __("Vista mensal compacta") : __("Toda a janela gerada"))}</div>
		</div>`;
}

function _abbr(turno) {
	if (!turno) return "";
	const m = turno.match(/^(\d)a?\s*(Manhã|Noite|Tarde|Folga)/i);
	if (m) return m[1] + m[2][0].toUpperCase();
	if (/folga/i.test(turno)) return "F";
	if (/único/i.test(turno)) return "U";
	return turno.length <= 4 ? turno : turno.slice(0, 4);
}

// ─── Leave indicator styles (read-only flag, any Leave Type; ASCII-only CSS) ───
function _inject_ferias_css() {
	if (document.getElementById("sigos-esc-ferias-css")) return;
	const css = `
.esc-wk-cell { position: relative; }
.esc-cell { position: relative; }
.esc-fer-badge {
	position: absolute; top: 2px; right: 2px; z-index: 2;
	font-size: 8px; font-weight: 800; letter-spacing: .03em;
	color: #7a5300; background: #ffd864; border: 1px solid #e8a020;
	border-radius: 3px; padding: 0 3px; line-height: 1.5; pointer-events: none;
}
.esc-wk-fer { box-shadow: inset 0 0 0 2px #e8a020; }
.esc-fer::after {
	content: ""; position: absolute; top: 1px; right: 1px;
	width: 0; height: 0; border-top: 6px solid #e8a020; border-left: 6px solid transparent;
}
.esc-ferias-lg { background: #ffd864; color: #7a5300; border: 1px solid #e8a020; }
`;
	const s = document.createElement("style");
	s.id = "sigos-esc-ferias-css";
	s.textContent = css;
	document.head.appendChild(s);
}

// ─── DECK — navy command panel (house pattern: HTML field + mounted controls) ──
function _render_deck(frm) {
	_inject_deck_css();
	const w = frm.fields_dict.deck_escala?.$wrapper;
	if (!w) return;   // field arrives with the next migrate — degrade gracefully

	const editable = frm.doc.estado !== "Arquivado";
	const key = `${frm.doc.name || "new"}|${frm.doc.estado}|${editable}`;
	if (w.find("#sigos-esc-deck").attr("data-key") !== key) _build_deck_shell(frm, w, editable, key);
	_deck_identity(frm);
	_render_deck_tiles(frm);
}

function _build_deck_shell(frm, w, editable, key) {
	w.html(`
		<div id="sigos-esc-deck" data-key="${key}" class="${editable ? "" : "is-arquivada"}">
			<div class="escd-top">
				<div class="escd-id">
					<div class="escd-kicker" data-escd-kicker></div>
					<div class="escd-title" data-escd-title></div>
					<div class="escd-sub" data-escd-sub></div>
				</div>
				<div class="escd-state">
					<span data-escd-chip></span>
					<span data-escd-stateact></span>
				</div>
			</div>
			<div class="escd-controls">
				<div class="escd-field"><label>${__("Tipo")}</label><div id="escd-c-tipo"></div></div>
				<div class="escd-field" id="escd-wrap-posto"><label>${__("Posto")}</label><div id="escd-c-posto"></div></div>
				<div class="escd-field" id="escd-wrap-delegacao"><label>${__("Delegação")}</label><div id="escd-c-delegacao"></div></div>
				<div class="escd-field"><label>${__("Regime")}</label><div id="escd-c-regime"></div></div>
				<div class="escd-field"><label>${__("Início do Ciclo")}</label><div id="escd-c-inicio"></div></div>
			</div>
			<div class="escd-tiles" data-escd-tiles></div>
			<div class="escd-actions">
				<button type="button" class="escd-btn" data-act="sync">${__("Sincronizar Vigilantes")}</button>
				<button type="button" class="escd-btn" data-act="equipas">${__("Equipas & Turnos")}</button>
				<button type="button" class="escd-btn" data-act="dist">${__("Distribuir Turnos")}</button>
				<button type="button" class="escd-btn escd-btn-danger" data-act="limpar">${__("Limpar Futuro")}</button>
				<button type="button" class="escd-btn escd-btn-danger" data-act="limpar-tudo">${__("Limpar Escala")}</button>
				<span class="escd-spacer"></span>
				<button type="button" class="escd-btn escd-btn-primary" data-act="gerar">${__("Gerar / Estender Escala")}</button>
			</div>
		</div>`);

	const ro = editable ? 0 : 1;

	// Tipo de Escala: Posto (normal) vs Reserva (delegação-scoped, no posto at
	// all — see escala_do_vigilante.py._validar_um_por_delegacao). Locked after
	// the first save (set_only_once) — switching tipo on an escala that
	// may already have generated rows tied to a real posto would be confusing
	// at best, so it's a one-time choice made when the escala is created.
	const _toggle_tipo_wrap = () => {
		const reserva = frm.doc.tipo_de_escala === "Reserva";
		w.find("#escd-wrap-posto").toggle(!reserva);
		w.find("#escd-wrap-delegacao").toggle(reserva);
	};
	const c_tipo = frappe.ui.form.make_control({
		df: { fieldtype: "Select", fieldname: "tipo_de_escala", options: "Posto\nReserva",
			read_only: ro || !frm.is_new() ? 1 : 0,
			onchange: () => {
				const v = c_tipo.get_value();
				if ((v || "Posto") !== (frm.doc.tipo_de_escala || "Posto")) {
					frm.set_value("tipo_de_escala", v || "Posto").then(() => { _toggle_tipo_wrap(); _deck_identity(frm); });
				}
			} },
		parent: w.find("#escd-c-tipo"), render_input: true,
	});
	c_tipo.set_value(frm.doc.tipo_de_escala || "Posto");
	_toggle_tipo_wrap();

	const c_posto = frappe.ui.form.make_control({
		df: { fieldtype: "Link", fieldname: "posto_de_vigilancia", options: "Posto De Vigilancia", read_only: ro,
			get_query: () => ({ filters: { estado: "Activo" } }),
			onchange: () => {
				const v = c_posto.get_value();
				if ((v || "") !== (frm.doc.posto_de_vigilancia || "")) frm.set_value("posto_de_vigilancia", v || null).then(() => _deck_identity(frm));
			} },
		parent: w.find("#escd-c-posto"), render_input: true,
	});
	if (frm.doc.posto_de_vigilancia) c_posto.set_value(frm.doc.posto_de_vigilancia);

	const c_delegacao = frappe.ui.form.make_control({
		df: { fieldtype: "Link", fieldname: "delegacao", options: "Delegacao", read_only: ro,
			onchange: () => {
				const v = c_delegacao.get_value();
				if ((v || "") !== (frm.doc.delegacao || "")) frm.set_value("delegacao", v || null).then(() => _deck_identity(frm));
			} },
		parent: w.find("#escd-c-delegacao"), render_input: true,
	});
	if (frm.doc.delegacao) c_delegacao.set_value(frm.doc.delegacao);

	const c_regime = frappe.ui.form.make_control({
		df: { fieldtype: "Link", fieldname: "regime_do_vigilante", options: "Regime", read_only: ro,
			onchange: () => {
				const v = c_regime.get_value();
				if ((v || "") !== (frm.doc.regime_do_vigilante || "")) frm.set_value("regime_do_vigilante", v || null).then(() => { _deck_identity(frm); _load_and_render(frm); });
			} },
		parent: w.find("#escd-c-regime"), render_input: true,
	});
	if (frm.doc.regime_do_vigilante) c_regime.set_value(frm.doc.regime_do_vigilante);

	const c_inicio = frappe.ui.form.make_control({
		df: { fieldtype: "Date", fieldname: "data_de_inicio", read_only: ro,
			onchange: () => {
				const v = c_inicio.get_value();
				if ((v || "") !== (frm.doc.data_de_inicio || "")) frm.set_value("data_de_inicio", v || null);
			} },
		parent: w.find("#escd-c-inicio"), render_input: true,
	});
	if (frm.doc.data_de_inicio) c_inicio.set_value(frm.doc.data_de_inicio);

	w.find('[data-act="sync"]').on("click", () => _sincronizar_vigilantes(frm));
	w.find('[data-act="equipas"]').on("click", () => _atribuir_equipas(frm));
	w.find('[data-act="dist"]').on("click", () => _distribuir_turnos(frm));
	w.find('[data-act="limpar"]').on("click", () => _limpar_futuro(frm));
	w.find('[data-act="limpar-tudo"]').on("click", () => _limpar_tudo(frm));
	w.find('[data-act="gerar"]').on("click", () => _gerar_escala(frm));
}

function _deck_identity(frm) {
	const w = frm.fields_dict.deck_escala?.$wrapper;
	if (!w || !w.find("#sigos-esc-deck").length) return;

	const reserva = frm.doc.tipo_de_escala === "Reserva";
	w.find("[data-escd-kicker]").text(reserva ? __("Escala de Reserva") : __("Escala do Posto"));
	w.find("[data-escd-title]").text(
		reserva ? (frm.doc.delegacao || __("Nova Escala de Reserva")) : (frm.doc.posto_de_vigilancia || __("Nova Escala"))
	);
	const sub = reserva
		? [frm.doc.regime_do_vigilante].filter(Boolean).join("  ·  ")
		: [frm.doc.cliente, frm.doc.regime_do_vigilante].filter(Boolean).join("  ·  ");
	w.find("[data-escd-sub]").text(sub);

	const chips = {
		"Rascunho":  ["escd-chip-draft", __("Rascunho")],
		"Activo":    ["escd-chip-on",    __("Activa")],
		"Arquivado": ["escd-chip-off",   __("Arquivada")],
	};
	const [cls, label] = chips[frm.doc.estado] || chips["Rascunho"];
	w.find("[data-escd-chip]").html(`<span class="escd-chip ${cls}">${label}</span>`);

	// estado transition (mirrors the Estado menu buttons)
	const $act = w.find("[data-escd-stateact]").empty();
	if (!frm.is_new()) {
		let btn = null;
		if (frm.doc.estado === "Rascunho")  btn = ["Activar", () => _set_estado(frm, "Activo"), "escd-state-on"];
		if (frm.doc.estado === "Activo")    btn = ["Arquivar", () => frappe.confirm(__("Arquivar esta escala? Deixará de gerar e de ser usada."), () => _set_estado(frm, "Arquivado")), ""];
		if (frm.doc.estado === "Arquivado") btn = ["Reactivar", () => _set_estado(frm, "Activo"), "escd-state-on"];
		if (btn) {
			$(`<button type="button" class="escd-state-btn ${btn[2]}">${__(btn[0])}</button>`)
				.on("click", btn[1]).appendTo($act);
		}
	}
}

// Tiles: guards / horizon / coverage health for the next 7 days (Rotativo only).
function _update_deck_stats(frm, ctx, tipo_ciclo) {
	frm._escd_stats = { ctx, tipo_ciclo };
	_render_deck_tiles(frm);
}

function _render_deck_tiles(frm) {
	const w = frm.fields_dict.deck_escala?.$wrapper;
	if (!w || !w.find("#sigos-esc-deck").length) return;
	const $t = w.find("[data-escd-tiles]");
	if (!$t.length) return;

	const { ctx, tipo_ciclo } = frm._escd_stats || {};
	const nGuards = (frm.doc.tab_vigilante_do_posto || []).length;
	const tile = (n, lbl, cls) => `<div class="escd-tile ${cls || ""}"><span class="n">${n}</span><span class="lbl">${lbl}</span></div>`;

	let html = tile(nGuards, __("vigilantes"), "t-vig");

	if (ctx) {
		const horizonte = frm.doc.gerado_ate || ctx.todasDatas[ctx.todasDatas.length - 1];
		if (horizonte) {
			const d = new Date(horizonte);
			html += tile(`${d.getDate()} ${_MES[d.getMonth()]}`, __("gerada até"), "t-hor");
		}
		if (tipo_ciclo === "Rotativo") {
			const dias7 = ctx.todasDatas.filter(d => d >= ctx.hoje).slice(0, 7);
			let falhas = 0, dobras = 0;
			dias7.forEach(d => {
				const c = _coverage_for_day(d, ctx);
				if (c && c.cls === "cov-gap") falhas++;
				else if (c && c.cls === "cov-double") dobras++;
			});
			if (falhas)      html += tile(falhas, __("dias c/ falha (7d)"), "t-gap");
			else if (dias7.length) html += tile("OK", __("cobertura (7d)"), "t-ok");
			if (dobras)      html += tile(dobras, __("dias a mais (7d)"), "t-dbl");
		}
	} else if (!nGuards) {
		html += `<div class="escd-hint">${__("Defina posto, regime e início do ciclo — depois sincronize os vigilantes.")}</div>`;
	}

	$t.html(html);
}

function _inject_deck_css() {
	if (document.getElementById("sigos-esc-deck-css")) return;
	const css = `
#sigos-esc-deck {
	margin: 0 0 14px; padding: 16px 18px; border-radius: 14px; color: #fff;
	background: linear-gradient(135deg, #234a73 0%, #1a3a5c 60%, #14304c 100%);
	box-shadow: 0 8px 24px rgba(20,48,76,.28), inset 0 1px 0 rgba(255,255,255,.08);
	border: 1px solid rgba(255,255,255,.06);
}
#sigos-esc-deck.is-arquivada { filter: saturate(.6); }
.escd-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.escd-kicker { font-size: .68em; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: rgba(255,255,255,.55); }
.escd-title { font-family: var(--sigos-display, system-ui); font-weight: 700; font-size: 1.5em; letter-spacing: .02em; line-height: 1.15; }
.escd-sub { font-size: .8em; font-weight: 600; color: #8fd0ff; margin-top: 2px; }
.escd-state { display: flex; align-items: center; gap: 8px; flex: none; }
.escd-chip { padding: 5px 12px; border-radius: 999px; font-size: .72em; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; border: 1px solid transparent; white-space: nowrap; }
.escd-chip-on    { background: rgba(47,165,106,.18); color: #8fe6b8; border-color: rgba(47,165,106,.4); }
.escd-chip-draft { background: rgba(232,160,32,.2); color: #f4cd84; border-color: rgba(232,160,32,.45); }
.escd-chip-off   { background: rgba(255,255,255,.1); color: rgba(255,255,255,.6); }
.escd-state-btn { background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.22); color: #fff; border-radius: 8px; padding: 5px 13px; font-size: .76em; font-weight: 700; cursor: pointer; }
.escd-state-btn:hover { background: rgba(255,255,255,.2); }
.escd-state-btn.escd-state-on { background: rgba(47,165,106,.8); border-color: rgba(47,165,106,.9); }
.escd-state-btn.escd-state-on:hover { background: #2fa56a; }
.escd-controls { display: flex; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
.escd-field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 160px; }
.escd-field > label { font-size: .7em; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: rgba(255,255,255,.65); margin: 0; }
#sigos-esc-deck .frappe-control { margin: 0 !important; }
#sigos-esc-deck .control-label, #sigos-esc-deck .help-box { display: none !important; }
#sigos-esc-deck .control-input input, #sigos-esc-deck .control-input .input-with-feedback {
	background: rgba(255,255,255,.96); border: 1px solid rgba(255,255,255,.25); border-radius: 8px; color: #1a3a5c; font-weight: 600; height: 32px;
}
#sigos-esc-deck .control-value, #sigos-esc-deck .like-disabled-input { color: #fff; background: rgba(255,255,255,.08); border-radius: 8px; border-color: rgba(255,255,255,.15); }
.escd-tiles { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; align-items: center; }
.escd-tile { min-width: 88px; padding: 9px 14px; border-radius: 10px; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.1); display: flex; flex-direction: column; gap: 2px; }
.escd-tile .n { font-family: var(--sigos-display, system-ui); font-weight: 700; font-size: 1.55em; line-height: 1; font-variant-numeric: tabular-nums; }
.escd-tile .lbl { font-size: .66em; text-transform: uppercase; letter-spacing: .05em; color: rgba(255,255,255,.65); white-space: nowrap; }
.escd-tile.t-vig .n { color: #8fd0ff; }
.escd-tile.t-hor .n { color: #fff; font-size: 1.2em; padding-top: 4px; }
.escd-tile.t-ok  .n { color: #8fe6b8; }
.escd-tile.t-dbl .n { color: #f4cd84; }
.escd-tile.t-gap { background: rgba(224,92,92,.18); border-color: rgba(224,92,92,.5); animation: escd-alarm 1.6s ease-in-out infinite; }
.escd-tile.t-gap .n { color: #ffb4b4; }
@keyframes escd-alarm { 50% { background: rgba(224,92,92,.3); } }
.escd-hint { font-size: .82em; font-style: italic; color: rgba(255,255,255,.6); }
.escd-actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; align-items: center; border-top: 1px solid rgba(255,255,255,.12); padding-top: 13px; }
.escd-spacer { flex: 1; }
.escd-btn { background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2); color: #fff; border-radius: 9px; padding: 7px 15px; font-size: .82em; font-weight: 700; cursor: pointer; transition: background .12s; }
.escd-btn:hover { background: rgba(255,255,255,.18); }
.escd-btn-danger { border-color: rgba(224,92,92,.5); color: #ffb4b4; }
.escd-btn-danger:hover { background: rgba(224,92,92,.2); }
.escd-btn-primary { background: #e8a020; border-color: #e8a020; color: #14304c; font-weight: 800; padding: 8px 20px; box-shadow: 0 3px 10px rgba(0,0,0,.25); }
.escd-btn-primary:hover { background: #f2b542; }
@media (max-width: 640px) {
	.escd-field { min-width: calc(50% - 8px); }
	.escd-btn-primary { width: 100%; order: 9; }
	.escd-spacer { display: none; }
}
`;
	const s = document.createElement("style");
	s.id = "sigos-esc-deck-css";
	s.textContent = css;
	document.head.appendChild(s);
}

function _override_dialog(frm, vig, data) {
	const nome = (frm.doc.tab_vigilante_do_posto || []).find(g => g.vigilante === vig)?.nome_completo || vig;
	const d = new frappe.ui.Dialog({
		title: __("Alterar Turno — {0}", [data]),
		fields: [
			{ fieldname: "info", fieldtype: "HTML",
			  options: `<div style="margin-bottom:8px;color:#555;"><b>${nome}</b> · ${data}</div>` },
			{
				fieldname: "turno", fieldtype: "Link", label: __("Turno"), options: "Turno", reqd: 1,
				get_query: () => ({
					query: "sigos.api.get_turnos_do_regime_query",
					filters: { regime: frm.doc.regime_do_vigilante || "" },
				}),
			},
		],
		primary_action_label: __("Aplicar"),
		primary_action(v) {
			const row = (frm.doc.tabela_de_escala || []).find(r => r.vigilante === vig && r.data === data);
			if (!row) { d.hide(); return; }
			frappe.db.get_value("Turno", v.turno, "periodo").then(res => {
				frappe.model.set_value(row.doctype, row.name, "turno", v.turno);
				frappe.model.set_value(row.doctype, row.name, "periodo", res.message?.periodo || "");
				frappe.model.set_value(row.doctype, row.name, "override", 1);
				d.hide();
				_load_and_render(frm);
				frappe.show_alert({ message: __("Turno alterado. Guarde para confirmar."), indicator: "blue" }, 4);
			});
		},
	});
	d.show();
}
