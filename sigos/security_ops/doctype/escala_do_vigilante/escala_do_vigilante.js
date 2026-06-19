frappe.ui.form.on("Escala Do Vigilante", {

	refresh(frm) {
		// The DECK supersedes the native header fields and buttons — same data,
		// same handlers, premium chrome. Child tables stay native (inline editing).
		// Only hide the natives once the deck field actually exists on this site
		// (it arrives via migrate) — otherwise keep the classic form fully usable.
		if (frm.fields_dict.deck_escala) {
			["sec_cabecalho", "naming_series", "posto_de_vigilancia", "col_break_1", "cliente", "estado",
			 "sec_config", "regime_do_vigilante", "data_de_inicio", "col_break_per", "gerado_ate",
			 "sincronizar_vigilantes", "distribuir_turnos", "btn_gerar", "btn_limpar_futuro"]
				.forEach(f => frm.set_df_property(f, "hidden", 1));
			_render_deck(frm);
		}

		_estado_buttons(frm);
		_snapshot_slots(frm);
		_load_and_render(frm);
		if (frm.doc.estado === "Arquivado") frm.disable_save();
	},

	onload(frm) {
		frm.set_query("posto_de_vigilancia", () => ({ filters: { estado: "Activo" } }));
		// naming_series is hidden by the deck — make sure new docs still get it
		if (frm.is_new() && !frm.doc.naming_series) frm.set_value("naming_series", "ESC-.####");
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

	btn_gerar(frm) { _gerar_escala(frm); },

	btn_limpar_futuro(frm) { _limpar_futuro(frm); },
});

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

// ─── Auto-swap turno_inicial collisions in the guard list ─────────────────────
frappe.ui.form.on("Tab Vigilante Do Posto", {
	turno_inicial(frm, cdt, cdn) {
		const row = locals[cdt][cdn];
		const novo = row.turno_inicial;
		const antigo = frm._slot_snap?.[cdn];
		if (!novo) { _snapshot_slots(frm); return; }

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
	frappe.call({
		method: "frappe.client.set_value",
		args: { doctype: "Escala Do Vigilante", name: frm.doc.name, fieldname: "estado", value: novo },
		callback: () => frm.reload_doc(),
	});
}

// ─── Sync guards from posto, with STAGGERED turnos for coverage ───────────────
function _sincronizar_vigilantes(frm) {
	if (!frm.doc.posto_de_vigilancia || !frm.doc.regime_do_vigilante) {
		frappe.msgprint(__("Defina o Posto e o Regime primeiro."));
		return;
	}

	frappe.call({
		method: "frappe.client.get_list",
		args: {
			doctype: "Vigilante",
			filters: [
				["posto_de_vigilancia", "=", frm.doc.posto_de_vigilancia],
				["regime_do_vigilante", "=", frm.doc.regime_do_vigilante],
				["status", "=", "Activo"],
			],
			fields: ["name", "nome_completo"],
			limit_page_length: 0,
		},
		callback(r) {
			const guards = r.message || [];
			if (!guards.length) { frappe.msgprint(__("Nenhum vigilante activo neste posto e regime.")); return; }

			frappe.call({
				method: "sigos.api.get_regime_turnos",
				args: { regime: frm.doc.regime_do_vigilante },
				callback(res) {
					const seq = res.message || [];
					if (!seq.length) { frappe.msgprint(__("Regime sem turnos.")); return; }

					// Slots already taken
					const usados = new Set((frm.doc.tab_vigilante_do_posto || []).map(g => g.turno_inicial).filter(Boolean));
					const existentes = new Set((frm.doc.tab_vigilante_do_posto || []).map(g => g.vigilante));

					// Free slots in cycle order (working turns come first in the sequence)
					const livres = seq.map(t => t.turno).filter(t => !usados.has(t));
					let li = 0;
					let adicionados = 0;

					guards.forEach(g => {
						if (existentes.has(g.name)) return;
						let slot = livres[li];
						if (slot === undefined) slot = seq[(usados.size + li) % seq.length].turno; // overflow → wrap
						li++;
						const row = frm.add_child("tab_vigilante_do_posto");
						row.vigilante     = g.name;
						row.nome_completo = g.nome_completo;
						row.turno_inicial = slot;
						usados.add(slot);
						adicionados++;
					});

					frm.refresh_field("tab_vigilante_do_posto");
					_snapshot_slots(frm);
					frappe.show_alert({
						message: __(`${adicionados} vigilante(s) adicionado(s) com turnos escalonados. Reveja e guarde.`),
						indicator: adicionados ? "green" : "blue",
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

		// One Select per guard, pre-filled with current turno_inicial
		const fields = [
			{
				fieldname: "info", fieldtype: "HTML",
				options: `<div style="margin-bottom:6px;color:#555;">
					${__("Atribua o turno inicial de cada vigilante. Use <b>Escalonar Automaticamente</b> para distribuir em sequência (cobertura ideal).")}
				</div>`,
			},
		];
		guards.forEach((g, i) => {
			fields.push({
				fieldname: `t_${i}`,
				fieldtype: "Select",
				label: g.nome_completo || g.vigilante,
				options: opts,
				default: g.turno_inicial || "",
			});
		});

		const d = new frappe.ui.Dialog({
			title: __("Distribuir Turnos em Bloco"),
			fields,
			primary_action_label: __("Aplicar"),
			primary_action(v) {
				// Warn on duplicates (not blocking — overstaffed postos may repeat)
				const vals = guards.map((g, i) => v[`t_${i}`]);
				guards.forEach((g, i) => {
					frappe.model.set_value(g.doctype, g.name, "turno_inicial", v[`t_${i}`] || null);
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
				// Stagger by row order: guard i → sequence[i % L]
				guards.forEach((g, i) => {
					d.set_value(`t_${i}`, seq[i % seq.length].turno);
				});
			},
		});
		d.show();
	});
}

// ─── Grid render (loads regime info first for the coverage row) ───────────────
function _load_and_render(frm) {
	if (!frm.doc.regime_do_vigilante) { _render_grid(frm, null, []); return; }
	const ferias = (frm.doc.name && !frm.is_new())
		? frappe.xcall("sigos.api.ferias_na_escala", { escala_name: frm.doc.name }).catch(() => ({}))
		: Promise.resolve({});
	Promise.all([
		frappe.db.get_value("Regime", frm.doc.regime_do_vigilante, "tipo_ciclo"),
		frappe.xcall("sigos.api.get_regime_turnos", { regime: frm.doc.regime_do_vigilante }),
		ferias,
	]).then(([tc, seq, fer]) => {
		frm._esc_ferias = fer || {};
		_render_grid(frm, tc?.message?.tipo_ciclo || null, seq || []);
	});
}

// Read-only "Férias" flag for a guard/day (does not change the scheduled turno).
function _is_ferias(frm, vig, d) {
	return !!(frm._esc_ferias && frm._esc_ferias[`${vig}|${d}`]);
}
const _FER_BADGE = `<span class="esc-fer-badge" title="Em férias (aprovadas)">FÉR</span>`;

const _PERIODO_CLS = { "Manhã": "cell-manha", "Noite": "cell-noite", "Tarde": "cell-tarde" };
const _DOW = ["D", "S", "T", "Q", "Q", "S", "S"];
const _MES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function _render_grid(frm, tipo_ciclo, seq) {
	_inject_ferias_css();
	// Cache for instant re-render when the range/week changes
	frm._esc_tc = tipo_ciclo;
	frm._esc_seq = seq;
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

	const ctx = { frm, tipo_ciclo, seq, todasDatas, guards, nameMap, cellMap, hoje };

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
		_render_grid(frm, frm._esc_tc, frm._esc_seq);
	});

	_bind_cell_clicks(frm, wrapper, hoje);
}

// ─── Coverage helper (shared) ─────────────────────────────────────────────────
// Coverage is per PERÍODO, not per turno-slot: "1a Manhã" vs "2a Manhã" is just
// the guard's position in the rotation — the posto needs at least ONE guard on
// Manhã and ONE on Noite (and Tarde, if the regime has it) each day.
function _coverage_for_day(d, ctx) {
	const periodoDe = {};   // working turno -> its período
	(ctx.seq || []).forEach(s => { if (!s.e_folga && s.periodo) periodoDe[s.turno] = s.periodo; });
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
			<span class="esc-ch-desc">${__("cada período do dia (Manhã/Noite) tem vigilante?")}</span>
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
			<span class="esc-lg cell-folga">Folga</span>
			<span class="esc-lg esc-override-lg">Manual</span>
			<span class="esc-lg esc-ferias-lg">Ferias</span>
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
			const fer = _is_ferias(frm, vig, d);
			const ferCls = fer ? "esc-wk-fer" : "";
			const ferBadge = fer ? _FER_BADGE : "";
			if (!r) {
				body += `<td class="esc-wk-cell esc-wk-blank ${ferCls} ${weCls(di)} ${isPast ? "esc-wk-past" : ""}">${ferBadge}</td>`;
			} else {
				const cls = _PERIODO_CLS[r.periodo] || "cell-folga";
				const ovr = r.override ? "esc-wk-override" : "";
				body += `<td class="esc-wk-cell ${ferCls} ${weCls(di)} ${isPast ? "esc-wk-past" : ""}"
					${isPast ? "" : `data-vig="${vig}" data-data="${d}"`}>
					${ferBadge}
					<div class="esc-wk-chip ${cls} ${ovr}" title="${r.turno}${r.override ? " (manual)" : ""}">
						${frappe.utils.escape_html(r.turno)}${r.override ? ' <span class="esc-wk-star">✎</span>' : ""}
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
		_render_grid(frm, frm._esc_tc, frm._esc_seq);
	});
	wrapper.find('.esc-wk-btn[data-wk="next"]').on("click", () => {
		frm._esc_week_start = todasDatas[Math.min(todasDatas.length - 1, start + 7)];
		_render_grid(frm, frm._esc_tc, frm._esc_seq);
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
			const ferCls = _is_ferias(ctx.frm, vig, d) ? "esc-fer" : "";
			if (!r) {
				body += `<td class="esc-cell esc-empty ${ferCls} ${isPast ? "esc-pastcell" : ""}"></td>`;
			} else {
				const cls = _PERIODO_CLS[r.periodo] || "cell-folga";
				const ovr = r.override ? "esc-override" : "";
				const fTitle = ferCls ? " · em férias" : "";
				body += `<td class="esc-cell ${cls} ${ovr} ${ferCls} ${isPast ? "esc-pastcell" : ""}"
					data-vig="${vig}" data-data="${d}" title="${r.turno}${r.override ? " (manual)" : ""}${fTitle}">${_abbr(r.turno)}</td>`;
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
	return turno.length <= 4 ? turno : turno.slice(0, 4);
}

// ─── Férias indicator styles (read-only flag; ASCII-only per house rule) ───────
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
					<div class="escd-kicker">${__("Escala do Posto")}</div>
					<div class="escd-title" data-escd-title></div>
					<div class="escd-sub" data-escd-sub></div>
				</div>
				<div class="escd-state">
					<span data-escd-chip></span>
					<span data-escd-stateact></span>
				</div>
			</div>
			<div class="escd-controls">
				<div class="escd-field"><label>${__("Posto")}</label><div id="escd-c-posto"></div></div>
				<div class="escd-field"><label>${__("Regime")}</label><div id="escd-c-regime"></div></div>
				<div class="escd-field"><label>${__("Início do Ciclo")}</label><div id="escd-c-inicio"></div></div>
			</div>
			<div class="escd-tiles" data-escd-tiles></div>
			<div class="escd-actions">
				<button type="button" class="escd-btn" data-act="sync">${__("Sincronizar Vigilantes")}</button>
				<button type="button" class="escd-btn" data-act="dist">${__("Distribuir Turnos")}</button>
				<button type="button" class="escd-btn escd-btn-danger" data-act="limpar">${__("Limpar Futuro")}</button>
				<span class="escd-spacer"></span>
				<button type="button" class="escd-btn escd-btn-primary" data-act="gerar">${__("Gerar / Estender Escala")}</button>
			</div>
		</div>`);

	const ro = editable ? 0 : 1;
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
	w.find('[data-act="dist"]').on("click", () => _distribuir_turnos(frm));
	w.find('[data-act="limpar"]').on("click", () => _limpar_futuro(frm));
	w.find('[data-act="gerar"]').on("click", () => _gerar_escala(frm));
}

function _deck_identity(frm) {
	const w = frm.fields_dict.deck_escala?.$wrapper;
	if (!w || !w.find("#sigos-esc-deck").length) return;

	w.find("[data-escd-title]").text(frm.doc.posto_de_vigilancia || __("Nova Escala"));
	const sub = [frm.doc.cliente, frm.doc.regime_do_vigilante].filter(Boolean).join("  ·  ");
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
