frappe.ui.form.on("Escala Do Vigilante", {

	refresh(frm) {
		_estado_buttons(frm);
		_snapshot_slots(frm);
		_load_and_render(frm);
		if (frm.doc.estado === "Arquivado") frm.disable_save();
	},

	onload(frm) {
		frm.set_query("posto_de_vigilancia", () => ({ filters: { estado: "Activo" } }));
	},

	posto_de_vigilancia(frm) {
		if (frm.doc.posto_de_vigilancia && !frm.doc.cliente) {
			frappe.db.get_value("Posto De Vigilancia", frm.doc.posto_de_vigilancia, "cliente")
				.then(r => frm.set_value("cliente", r.message?.cliente));
		}
	},

	sincronizar_vigilantes(frm) { _sincronizar_vigilantes(frm); },

	distribuir_turnos(frm) { _distribuir_turnos(frm); },

	btn_gerar(frm) {
		if (frm.is_dirty()) {
			frm.save().then(() => frappe.show_alert({ message: __("Escala gerada."), indicator: "green" }, 3));
		} else {
			frappe.call({
				method: "sigos.api.gerar_escala_posto",
				args: { escala_name: frm.doc.name },
				freeze: true, freeze_message: __("A gerar escala..."),
				callback: () => frm.reload_doc(),
			});
		}
	},

	btn_limpar_futuro(frm) {
		frappe.confirm(
			__("Remover todos os dias futuros não-editados? Os dias com alteração manual são mantidos."),
			() => frappe.call({
				method: "sigos.api.limpar_futuro_escala",
				args: { escala_name: frm.doc.name },
				freeze: true,
				callback: () => frm.reload_doc(),
			})
		);
	},
});

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
				["categoria", "!=", "Administrativo"],
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
	Promise.all([
		frappe.db.get_value("Regime", frm.doc.regime_do_vigilante, "tipo_ciclo"),
		frappe.xcall("sigos.api.get_regime_turnos", { regime: frm.doc.regime_do_vigilante }),
	]).then(([tc, seq]) => {
		_render_grid(frm, tc?.message?.tipo_ciclo || null, seq || []);
	});
}

const _PERIODO_CLS = { "Manhã": "cell-manha", "Noite": "cell-noite", "Tarde": "cell-tarde" };
const _DOW = ["D", "S", "T", "Q", "Q", "S", "S"];
const _MES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function _render_grid(frm, tipo_ciclo, seq) {
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
function _coverage_for_day(d, ctx) {
	const working = (ctx.seq || []).filter(s => !s.e_folga).map(s => s.turno);
	if (!working.length) return null;
	const counts = {};
	ctx.guards.forEach(vig => {
		const r = ctx.cellMap[`${vig}|${d}`];
		if (r && working.includes(r.turno)) counts[r.turno] = (counts[r.turno] || 0) + 1;
	});
	const gap = working.filter(w => !counts[w]);
	const dbl = working.filter(w => (counts[w] || 0) > 1);
	if (dbl.length) return { icon: "●", cls: "cov-double", tip: "Duplicado: " + dbl.join(", ") };
	if (gap.length) return { icon: "▲", cls: "cov-gap",    tip: "Sem cobertura: " + gap.join(", ") };
	return { icon: "✓", cls: "cov-ok", tip: "Totalmente coberto" };
}

function _coverage_legend(tipo_ciclo) {
	if (tipo_ciclo !== "Rotativo") return "";
	return `
		<div class="esc-cobertura-help">
			<span class="esc-ch-title">${__("Cobertura")}</span>
			<span class="esc-ch-desc">${__("cada turno do dia tem vigilante?")}</span>
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
			if (!r) {
				body += `<td class="esc-wk-cell esc-wk-blank ${weCls(di)} ${isPast ? "esc-wk-past" : ""}"></td>`;
			} else {
				const cls = _PERIODO_CLS[r.periodo] || "cell-folga";
				const ovr = r.override ? "esc-wk-override" : "";
				body += `<td class="esc-wk-cell ${weCls(di)} ${isPast ? "esc-wk-past" : ""}"
					${isPast ? "" : `data-vig="${vig}" data-data="${d}"`}>
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
			if (!r) {
				body += `<td class="esc-cell esc-empty ${isPast ? "esc-pastcell" : ""}"></td>`;
			} else {
				const cls = _PERIODO_CLS[r.periodo] || "cell-folga";
				const ovr = r.override ? "esc-override" : "";
				body += `<td class="esc-cell ${cls} ${ovr} ${isPast ? "esc-pastcell" : ""}"
					data-vig="${vig}" data-data="${d}" title="${r.turno}${r.override ? " (manual)" : ""}">${_abbr(r.turno)}</td>`;
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
