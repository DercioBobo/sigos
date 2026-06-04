frappe.ui.form.on("Escala do Vigilante", {

	refresh(frm) {
		_estado_buttons(frm);
		_snapshot_slots(frm);
		_load_and_render(frm);
		if (frm.doc.estado === "Arquivado") frm.disable_save();
	},

	onload(frm) {
		frm.set_query("posto_de_vigilancia", () => ({ filters: { estado: "Ativo" } }));
	},

	posto_de_vigilancia(frm) {
		if (frm.doc.posto_de_vigilancia && !frm.doc.cliente) {
			frappe.db.get_value("Posto de Vigilancia", frm.doc.posto_de_vigilancia, "cliente")
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
		args: { doctype: "Escala do Vigilante", name: frm.doc.name, fieldname: "estado", value: novo },
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
				["status", "=", "Ativo"],
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
	const wrapper = frm.fields_dict.grid_escala?.$wrapper;
	if (!wrapper) return;

	const rows = frm.doc.tabela_de_escala || [];
	if (!rows.length) {
		wrapper.html(`<div class="text-muted" style="padding:20px;text-align:center;">
			${__("Sem escala gerada. Sincronize os vigilantes, defina o turno inicial e clique em <b>Gerar / Estender Escala</b>.")}
		</div>`);
		return;
	}

	const datas = [...new Set(rows.map(r => r.data))].sort();
	const guardOrder = (frm.doc.tab_vigilante_do_posto || []).map(g => g.vigilante);
	const guardsInRows = [...new Set(rows.map(r => r.vigilante))];
	const guards = guardOrder.filter(g => guardsInRows.includes(g))
		.concat(guardsInRows.filter(g => !guardOrder.includes(g)));

	const nameMap = {};
	(frm.doc.tab_vigilante_do_posto || []).forEach(g => { nameMap[g.vigilante] = g.nome_completo || g.vigilante; });

	const cellMap = {};
	rows.forEach(r => { cellMap[`${r.vigilante}|${r.data}`] = r; });

	const hoje = frappe.datetime.get_today();

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

	// Coverage row (Rotativo only — for TDU every guard shares the turn)
	let coverageRow = "";
	if (tipo_ciclo === "Rotativo") {
		const working = (seq || []).filter(s => !s.e_folga).map(s => s.turno);
		coverageRow = `<tr class="esc-cov-row"><td class="esc-name-col">${__("Cobertura")}</td>`;
		datas.forEach(d => {
			const counts = {};
			guards.forEach(vig => {
				const r = cellMap[`${vig}|${d}`];
				if (r && working.includes(r.turno)) counts[r.turno] = (counts[r.turno] || 0) + 1;
			});
			const gap = working.filter(w => !counts[w]);
			const dbl = working.filter(w => (counts[w] || 0) > 1);
			let icon, cls, tip;
			if (dbl.length)      { icon = "●"; cls = "cov-double"; tip = "Duplicado: " + dbl.join(", "); }
			else if (gap.length) { icon = "▲"; cls = "cov-gap";    tip = "Sem cobertura: " + gap.join(", "); }
			else                 { icon = "✓"; cls = "cov-ok";     tip = "Totalmente coberto"; }
			coverageRow += `<td class="esc-cov ${cls}" title="${tip}">${icon}</td>`;
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
		<div class="esc-grid-wrap">
			<table class="esc-grid">
				<thead><tr>${mesHeader}</tr><tr>${dayHeader}</tr></thead>
				<tbody>${body}</tbody>
			</table>
		</div>
		<div class="esc-legend">
			<span class="esc-lg cell-manha">Manhã</span>
			<span class="esc-lg cell-noite">Noite</span>
			<span class="esc-lg cell-tarde">Tarde</span>
			<span class="esc-lg cell-folga">Folga</span>
			<span class="esc-lg esc-override-lg">Manual</span>
			${tipo_ciclo === "Rotativo" ? `<span class="esc-lg" style="background:#eee;color:#333;">Cobertura: ✓ ok · ▲ falta · ● duplo</span>` : ""}
		</div>`);

	wrapper.find(".esc-cell[data-vig]").on("click", function () {
		const vig = $(this).attr("data-vig");
		const data = $(this).attr("data-data");
		if (data < hoje) {
			frappe.show_alert({ message: __("Não é possível editar dias passados."), indicator: "orange" }, 3);
			return;
		}
		_override_dialog(frm, vig, data);
	});
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
