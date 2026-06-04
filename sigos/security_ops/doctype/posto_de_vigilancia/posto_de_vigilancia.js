frappe.ui.form.on("Posto de Vigilancia", {

	onload(frm) {
		frm.set_query("cliente", () => ({ filters: { disabled: 0 } }));
		frm.set_query("project", () => ({
			filters: { customer: frm.doc.cliente, is_active: "Yes" },
		}));
	},

	refresh(frm) {
		_mostrar_indicador(frm);
		_mostrar_aviso_temporario(frm);

		if (!frm.is_new()) {
			// Schedule preview — available for any saved posto (Ativo, Inativo, or Arquivado)
			frm.add_custom_button(__("Ver Escala"), () => _ver_escala_preview(frm), __("Acções"));
		}

		if (!frm.is_new() && frm.doc.estado === "Ativo") {
			// General assignment: admitted vigilantes without a posto
			frm.add_custom_button(__("Atribuir Vigilantes"), () => _atribuir_vigilantes(frm), __("Acções"));

			// Bulk-allocate reserves ONLY for active temporary posts (deploy a team).
			if (frm.doc.tipo_de_posto === "Temporário") {
				frm.add_custom_button(__("Alocar Reservas"), () => _alocar_reservas(frm), __("Acções"));
			}
		}

		if (!frm.is_new() && frm.doc.tipo_de_posto === "Temporário") {
			frm.add_custom_button(__("Tornar Permanente"), () => {
				frappe.confirm(
					__("Converter este posto temporário em permanente? O fim previsto será removido."),
					() => frm.call("tornar_permanente").then(() => frm.reload_doc())
				);
			}, __("Acções"));
		}
	},

	tipo_de_posto(frm) { _mostrar_aviso_temporario(frm); },
	data_fim_prevista(frm) { _mostrar_aviso_temporario(frm); },

	numero_de_vagas(frm) {
		_mostrar_indicador(frm);
	},

	cliente(frm) {
		frm.set_value("project", "");
		frm.set_query("project", () => ({
			filters: { customer: frm.doc.cliente, is_active: "Yes" },
		}));
	},
});

// ─── 7-day Escala preview modal ──────────────────────────────────────────────
function _ver_escala_preview(frm) {
	frappe.call({
		method: "sigos.api.get_escala_preview_posto",
		args: { posto: frm.doc.name, dias: 7 },
		freeze: true,
		freeze_message: __("A carregar escala..."),
		callback(r) {
			const escalas = r.message || [];
			const titulo  = frm.doc.nome_do_posto || frm.doc.name;

			let body = "";

			if (!escalas.length) {
				const nova_url = `/app/escala-do-vigilante/new-escala-do-vigilante-1?posto_de_vigilancia=${encodeURIComponent(frm.doc.name)}`;
				body = `
					<div style="text-align:center;padding:48px 24px">
						<div style="font-size:2.5em;margin-bottom:12px">📅</div>
						<h4 style="margin:0 0 8px;color:#333">${__("Nenhuma escala criada")}</h4>
						<p style="color:#777;margin:0 0 20px">${__("Crie uma escala para começar a gerir os turnos deste posto.")}</p>
						<a href="${nova_url}" class="btn btn-primary btn-sm">
							${__("+ Criar Escala para este Posto")}
						</a>
					</div>`;
			} else {
				body = escalas.map(_render_escala_bloco).join("");
			}

			const d = new frappe.ui.Dialog({
				title: `📋 ${__("Escala — {0}", [titulo])}`,
				fields: [{
					fieldname: "preview",
					fieldtype: "HTML",
					options: `<div style="padding:4px 0">${body}</div>`,
				}],
				size: "extra-large",
			});
			d.show();
		},
	});
}

// Render one escala block inside the modal
function _render_escala_bloco(esc) {
	const ESTADO_STYLE = {
		"Activo":    { bg: "#d1e7dd", fg: "#0f5132", dot: "#198754" },
		"Rascunho":  { bg: "#fff3cd", fg: "#856404", dot: "#ffc107" },
		"Arquivado": { bg: "#e2e3e5", fg: "#41464b", dot: "#adb5bd" },
	};
	const es = ESTADO_STYLE[esc.estado] || ESTADO_STYLE["Rascunho"];

	const DIAS_PT  = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
	const hoje_str = frappe.datetime.get_today();

	const PERIODO_COLOR = {
		"Manhã": { bg: "#4a90d9", label: "MNH" },
		"Noite": { bg: "#2c3e57", label: "NOT" },
		"Tarde": { bg: "#e8a020", label: "TAR" },
		"":      { bg: "#adb5bd", label: "FLG" },
	};

	// ── Header ────────────────────────────────────────────────────────────────
	const gerado_info = esc.gerado_ate
		? `<span style="color:#888;font-size:.8em">${__("Gerado até")} ${esc.gerado_ate}</span>`
		: "";

	let html = `
		<div style="margin-bottom:20px;border:1px solid #dee2e6;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.06)">
			<div style="background:#f8f9fa;padding:10px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #dee2e6;flex-wrap:wrap">
				<span style="display:inline-flex;align-items:center;gap:5px;background:${es.bg};color:${es.fg};padding:3px 12px;border-radius:20px;font-size:.8em;font-weight:600">
					<span style="width:7px;height:7px;border-radius:50%;background:${es.dot};display:inline-block"></span>
					${esc.estado}
				</span>
				<span style="font-weight:600;color:#333;font-size:.95em">Regime: ${esc.regime}</span>
				${gerado_info}
				<a href="/app/escala-do-vigilante/${esc.name}" target="_blank"
				   style="margin-left:auto;font-size:.85em;color:#1565C0;text-decoration:none;white-space:nowrap;font-weight:500">
					${__("Ver Escala Completa")} →
				</a>
			</div>`;

	// ── Guard grid ────────────────────────────────────────────────────────────
	if (!esc.guards.length) {
		html += `<div style="padding:20px;text-align:center;color:#888;font-size:.9em">${__("Nenhum vigilante na escala")}</div>`;
	} else {
		// Day header row
		const day_headers = esc.days.map(d => {
			const dt   = new Date(d + "T00:00:00");
			const dow  = DIAS_PT[dt.getDay()];
			const num  = dt.getDate();
			const isHj = d === hoje_str;
			return `<th style="min-width:52px;padding:5px 2px;text-align:center;background:${isHj ? "#fff3cd" : "#f4f5f6"};border:1px solid #e8ebed;${isHj ? "box-shadow:inset 0 -2px 0 #e8a020" : ""}">
				<div style="font-size:9px;color:#999;line-height:1;font-weight:500">${dow}</div>
				<div style="font-weight:700;font-size:.95em;line-height:1.5;color:${isHj ? "#856404" : "#333"}">${num}</div>
			</th>`;
		}).join("");

		html += `<div style="overflow-x:auto">
			<table style="border-collapse:collapse;width:100%;font-size:.82em">
				<thead><tr>
					<th style="min-width:150px;max-width:180px;padding:6px 12px;text-align:left;background:#f4f5f6;border:1px solid #e8ebed;position:sticky;left:0;z-index:2;color:#555;font-weight:600">
						${__("Vigilante")}
					</th>
					${day_headers}
				</tr></thead>
				<tbody>`;

		for (const g of esc.guards) {
			const cells = g.dias.map(dia => {
				if (!dia) {
					return `<td style="border:1px solid #e8ebed;background:#fafbfc;height:30px"></td>`;
				}
				const pc   = PERIODO_COLOR[dia.periodo] || PERIODO_COLOR[""];
				const ring = dia.override ? "box-shadow:inset 0 0 0 2px #e05c5c;" : "";
				return `<td style="border:1px solid #e8ebed;height:30px;padding:2px;${ring}">
					<div style="background:${pc.bg};color:#fff;border-radius:3px;height:100%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:10px;letter-spacing:.3px" title="${dia.turno}">
						${pc.label}
					</div>
				</td>`;
			}).join("");

			html += `<tr>
				<td style="padding:4px 12px;border:1px solid #e8ebed;font-weight:500;background:#fff;position:sticky;left:0;z-index:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px" title="${g.nome}">
					${g.nome}
				</td>
				${cells}
			</tr>`;
		}

		html += `</tbody></table></div>`;
	}

	// ── Legend ────────────────────────────────────────────────────────────────
	html += `
		<div style="padding:8px 14px;background:#fafbfc;border-top:1px solid #f0f1f3;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
			<span style="font-size:.75em;color:#888;margin-right:4px">${__("Legenda")}:</span>
			${[["#4a90d9","Manhã"],["#2c3e57","Noite"],["#e8a020","Tarde"],["#adb5bd","Folga"]].map(([c, l]) =>
				`<span style="background:${c};color:#fff;padding:2px 10px;border-radius:10px;font-size:.75em;font-weight:600">${l}</span>`
			).join("")}
			<span style="border:2px solid #e05c5c;border-radius:3px;padding:1px 8px;font-size:.75em;color:#e05c5c;font-weight:600">${__("Override")}</span>
		</div>
	</div>`;

	return html;
}

// ─── Assign unassigned admitted vigilantes to this post ──────────────────────
function _atribuir_vigilantes(frm) {
	const max   = frm.doc.numero_de_vagas || 0;
	const atual = frm.doc.ocupacao_atual  || 0;
	const livres = max ? max - atual : null;

	frappe.call({
		method: "sigos.api.get_vigilantes_sem_posto",
		args: { delegacao: frm.doc.delegacao || null },
		freeze: true,
		freeze_message: __("A procurar vigilantes disponíveis..."),
		callback(r) {
			const lista = r.message || [];

			if (!lista.length) {
				frappe.msgprint(
					__("Nenhum vigilante disponível: todos os vigilantes admitidos já têm posto atribuído ou não têm Funcionário associado."),
					__("Sem Disponíveis")
				);
				return;
			}

			const capacidade_html = max
				? `<span style="color:${livres <= 0 ? '#e05c5c' : '#555'}">
					${__("Vagas livres")}: <b>${livres}</b> (${atual}/${max})
				   </span>`
				: `<span style="color:#888">${__("Sem limite de vagas definido")}</span>`;

			const d = new frappe.ui.Dialog({
				title: __("Atribuir Vigilantes a {0}", [frm.doc.nome_do_posto || frm.doc.name]),
				fields: [
					{
						fieldname: "info", fieldtype: "HTML",
						options: `<div style="margin-bottom:10px;font-size:.9em">${capacidade_html}</div>`,
					},
					{
						fieldname: "regime", fieldtype: "Link", label: __("Regime (opcional)"),
						options: "Regime",
						description: __("Se definido, atribuído a todos os vigilantes seleccionados"),
					},
					{
						fieldname: "vigilantes", fieldtype: "MultiSelectPills",
						label: __("Vigilantes sem posto"),
						get_data: () => lista.map(v => ({
							value: v.name,
							description: [
								v.nome_completo,
								v.categoria  || "",
								v.status,
								v.delegacao  ? `· ${v.delegacao}` : "",
							].filter(Boolean).join(" · "),
						})),
					},
				],
				primary_action_label: __("Atribuir"),
				primary_action(vals) {
					const escolhidos = vals.vigilantes || [];
					if (!escolhidos.length) {
						frappe.show_alert({ message: __("Seleccione pelo menos um vigilante."), indicator: "orange" }, 3);
						return;
					}
					if (livres !== null && escolhidos.length > livres) {
						frappe.show_alert({
							message: __("Selecção ({0}) excede as vagas livres ({1}).").format(escolhidos.length, livres),
							indicator: "red",
						}, 5);
						return;
					}

					frappe.call({
						method: "sigos.api.atribuir_vigilantes_ao_posto",
						args: { posto: frm.doc.name, vigilantes: escolhidos, regime: vals.regime || null },
						freeze: true,
						freeze_message: __("A atribuir..."),
						callback(res) {
							const { atribuidos, erros } = res.message || {};
							d.hide();

							if (atribuidos) {
								frappe.show_alert({
									message: __("{0} vigilante(s) atribuído(s) ao posto com sucesso.").format(atribuidos),
									indicator: "green",
								}, 6);
							}

							if (erros && erros.length) {
								frappe.msgprint({
									title: __("Avisos / Erros"),
									message: erros.map(e => `• ${e}`).join("<br>"),
									indicator: "orange",
								});
							}

							frm.reload_doc();
						},
					});
				},
			});
			d.show();
		},
	});
}

// ─── Allocate a team of reserves to this (temporary) post ─────────────────────
function _alocar_reservas(frm) {
	const max = frm.doc.numero_de_vagas || 0;
	const atual = frm.doc.ocupacao_atual || 0;
	const livres = max ? max - atual : null;

	frappe.call({
		method: "sigos.api.get_reservas_disponiveis",
		args: { delegacao: frm.doc.delegacao || null },
		freeze: true,
		freeze_message: __("A procurar reservas..."),
		callback(r) {
			const reservas = r.message || [];
			if (!reservas.length) {
				frappe.msgprint(__("Nenhuma reserva disponível (categoria de reserva, sem escala activa)."));
				return;
			}

			const d = new frappe.ui.Dialog({
				title: __("Alocar Reservas a {0}", [frm.doc.nome_do_posto || frm.doc.name]),
				fields: [
					{
						fieldname: "info", fieldtype: "HTML",
						options: `<div style="margin-bottom:8px;color:#555;">
							${max ? `${__("Vagas livres")}: <b>${livres}</b> (${atual}/${max})` : __("Posto sem limite de vagas")}
						</div>`,
					},
					{
						fieldname: "regime", fieldtype: "Link", label: __("Regime a atribuir"), options: "Regime", reqd: 1,
						description: __("Os reservas seleccionados passam a este posto e regime"),
					},
					{
						fieldname: "vigilantes", fieldtype: "MultiSelectPills", label: __("Reservas disponíveis"),
						get_data: () => reservas.map(v => ({
							value: v.name,
							description: v.posto_de_vigilancia
								? `${v.nome_completo} · já em ${v.posto_de_vigilancia}`
								: `${v.nome_completo} · livre`,
						})),
					},
				],
				primary_action_label: __("Alocar"),
				primary_action(v) {
					const escolhidos = v.vigilantes || [];
					if (!escolhidos.length) {
						frappe.show_alert({ message: __("Seleccione pelo menos um vigilante."), indicator: "orange" }, 3);
						return;
					}
					if (livres !== null && escolhidos.length > livres) {
						frappe.show_alert({
							message: __(`Apenas ${livres} vaga(s) livre(s). Reduza a selecção.`),
							indicator: "red",
						}, 5);
						return;
					}
					frappe.call({
						method: "sigos.api.alocar_reservas",
						args: { posto: frm.doc.name, vigilantes: escolhidos, regime: v.regime },
						freeze: true, freeze_message: __("A alocar..."),
						callback(res) {
							const n = res.message?.alocados || 0;
							frappe.show_alert({ message: __(`${n} vigilante(s) alocado(s). Crie/sincronize a escala do posto.`), indicator: "green" }, 6);
							d.hide();
							frm.reload_doc();
						},
					});
				},
			});
			d.show();
		},
	});
}

// ─── Temporary post banner ────────────────────────────────────────────────────
function _mostrar_aviso_temporario(frm) {
	const w = frm.fields_dict.aviso_temporario?.$wrapper;
	if (!w) return;
	if (frm.doc.tipo_de_posto !== "Temporário") { w.html(""); return; }

	if (!frm.doc.data_fim_prevista) {
		w.html(`<div class="sigos-posto-badge badge-sem-limite">
			⏳ ${__("Posto temporário sem fim previsto definido")}</div>`);
		return;
	}

	const hoje = frappe.datetime.get_today();
	const dias = frappe.datetime.get_day_diff(frm.doc.data_fim_prevista, hoje);
	let cls, icon, txt;
	if (dias < 0) {
		cls = "badge-excedido"; icon = "🚨";
		txt = `${__("EXPIRADO há")} ${Math.abs(dias)} ${__("dia(s)")} (${frm.doc.data_fim_prevista})`;
	} else if (dias <= 7) {
		cls = "badge-desfalcado"; icon = "⚠️";
		txt = `${__("Termina em")} ${dias} ${__("dia(s)")} — ${frm.doc.data_fim_prevista}`;
	} else {
		cls = "badge-sem-limite"; icon = "⏳";
		txt = `${__("Posto temporário — termina em")} ${frm.doc.data_fim_prevista} (${dias} ${__("dias")})`;
	}
	w.html(`<div class="sigos-posto-badge ${cls}"><span class="badge-icon">${icon}</span> ${txt}</div>`);
}

// ─── Occupation indicator ─────────────────────────────────────────────────────
function _mostrar_indicador(frm) {
	const max    = frm.doc.numero_de_vagas || 0;
	const atual  = frm.doc.ocupacao_atual  || 0;
	const status = frm.doc.status_ocupacao || "";

	if (!max) {
		frm.fields_dict.indicador_ocupacao.$wrapper.html(
			`<div class="sigos-posto-badge badge-sem-limite">Sem limite de vagas definido</div>`
		);
		return;
	}

	const configs = {
		"Desfalcado": { cls: "badge-desfalcado", icon: "⚠️", label: "DESFALCADO" },
		"Completo":   { cls: "badge-completo",   icon: "✅", label: "COMPLETO"   },
		"Excedido":   { cls: "badge-excedido",   icon: "🚨", label: "EXCEDIDO"   },
	};
	const cfg = configs[status] || { cls: "badge-sem-limite", icon: "ℹ️", label: status };

	frm.fields_dict.indicador_ocupacao.$wrapper.html(`
		<div class="sigos-posto-badge ${cfg.cls}">
			<span class="badge-icon">${cfg.icon}</span>
			<strong>${cfg.label}</strong>
			<span class="badge-count">${atual} / ${max} vigilantes</span>
			${status === "Desfalcado"
				? `<span class="badge-faltam">Faltam ${max - atual}</span>`
				: ""}
		</div>`);
}
