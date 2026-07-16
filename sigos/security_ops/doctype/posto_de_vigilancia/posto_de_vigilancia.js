frappe.ui.form.on("Posto De Vigilancia", {

	onload(frm) {
		// Project (contract) is the driver; Cliente is derived from project.customer.
		frm.set_query("project", () => ({ filters: { is_active: "Yes" } }));
		_aplicar_posto_interno_por_omissao(frm);
	},

	refresh(frm) {
		_mostrar_indicador(frm);
		_mostrar_aviso_temporario(frm);

		if (!frm.is_new()) {
			// Schedule preview — available for any saved posto (Activo, Inactivo, or Arquivado)
			frm.add_custom_button(__("Ver Escala"), () => _ver_escala_preview(frm), __("Acções"));
		}

		if (!frm.is_new() && frm.doc.estado === "Activo") {
			// General assignment: admitted vigilantes without a posto
			frm.add_custom_button(__("Atribuir Vigilantes"), () => _atribuir_vigilantes(frm), __("Acções"));

			// Bulk-allocate reserves ONLY for active temporary posts (deploy a team).
			if (frm.doc.tipo_de_posto === "Temporário") {
				frm.add_custom_button(__("Alocar Reservas"), () => _alocar_reservas(frm), __("Acções"));
			}
		}

		// Close-down helper: bench this posto's whole team to Reserva in one action
		// (keeps the posto open — e.g. a temporary lull).
		if (!frm.is_new() && (frm.doc.ocupacao_atual || 0) > 0) {
			frm.add_custom_button(__("Enviar Vigilantes para Reserva"), () => _enviar_reserva(frm), __("Acções"));
		}

		// Full teardown: bench the team + archive escalas + inactivate, in one guided step.
		if (!frm.is_new() && frm.doc.estado === "Activo") {
			frm.add_custom_button(__("Encerrar Posto"), () => _encerrar_posto(frm), __("Acções"))
				.removeClass("btn-default").addClass("btn-danger");
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

	posto_interno(frm) {
		// Internal posts carry no contract — clear the project (customer follows).
		if (frm.doc.posto_interno) frm.set_value("project", "");
	},
});

// ─── Customer-specific: default new posts to "Interno" ────────────────────────
// SIGOS Settings.posto_interno_por_omissao — for clients who operate only with
// their own effective (no billable contracts). New posts start pre-checked;
// still editable per-posto.
let _posto_interno_por_omissao = null;
function _aplicar_posto_interno_por_omissao(frm) {
	if (!frm.is_new() || frm.doc.posto_interno) return;
	const aplicar = () => {
		if (_posto_interno_por_omissao) frm.set_value("posto_interno", 1);
	};
	if (_posto_interno_por_omissao === null) {
		frappe.db.get_single_value("SIGOS Settings", "posto_interno_por_omissao").then(v => {
			_posto_interno_por_omissao = !!v;
			aplicar();
		});
	} else {
		aplicar();
	}
}

// ─── Bench the posto's whole team to Reserva (posto closing) ──────────────────
function _enviar_reserva(frm) {
	frappe.call({
		method: "frappe.client.get_list",
		args: {
			doctype: "Vigilante",
			filters: { posto_de_vigilancia: frm.doc.name, status: "Activo" },
			fields: ["name", "nome_completo"], limit_page_length: 0,
		},
		callback(r) {
			const guards = r.message || [];
			if (!guards.length) {
				frappe.msgprint(__("Não há vigilantes activos neste posto."));
				return;
			}
			const lista = guards.map(g => `<li>${frappe.utils.escape_html(g.nome_completo || g.name)}</li>`).join("");
			const d = new frappe.ui.Dialog({
				title: __("Enviar para Reserva — {0}", [frm.doc.nome_do_posto || frm.doc.name]),
				fields: [
					{ fieldtype: "HTML", options:
						`<div style="margin-bottom:10px">${__("Os seguintes <b>{0}</b> vigilante(s) sairão do posto e ficarão em <b>Reserva</b> (disponíveis, não demitidos):", [guards.length])}
						<ul style="margin-top:6px">${lista}</ul></div>` },
					{ fieldname: "motivo", fieldtype: "Small Text", label: __("Motivo (ex: encerramento do posto)"), reqd: 1 },
				],
				primary_action_label: __("Enviar para Reserva"),
				primary_action(v) {
					frappe.call({
						method: "sigos.api.enviar_posto_para_reserva",
						args: { posto: frm.doc.name, motivo: v.motivo },
						freeze: true, freeze_message: __("A enviar para reserva..."),
						callback(res) {
							d.hide();
							frappe.show_alert({ message: __("{0} vigilante(s) enviado(s) para Reserva.", [res.message?.benched || 0]), indicator: "green" }, 6);
							frm.reload_doc();
						},
					});
				},
			});
			d.show();
		},
	});
}

// ─── Full teardown: bench team + archive escalas + inactivate ─────────────────
function _encerrar_posto(frm) {
	frappe.call({
		method: "frappe.client.get_list",
		args: {
			doctype: "Vigilante",
			filters: { posto_de_vigilancia: frm.doc.name, status: "Activo" },
			fields: ["name", "nome_completo"], limit_page_length: 0,
		},
		callback(r) {
			const guards = r.message || [];
			const lista = guards.length
				? `<ul style="margin:6px 0 0">${guards.map(g => `<li>${frappe.utils.escape_html(g.nome_completo || g.name)}</li>`).join("")}</ul>`
				: `<div style="color:#888;margin-top:4px">${__("Nenhum vigilante activo neste posto.")}</div>`;

			const d = new frappe.ui.Dialog({
				title: __("Encerrar Posto — {0}", [frm.doc.nome_do_posto || frm.doc.name]),
				fields: [
					{ fieldtype: "HTML", options:
						`<div style="margin-bottom:10px">
							<div>${__("Encerrar este posto irá:")}</div>
							<ul style="margin:6px 0">
								<li>${__("Enviar <b>{0}</b> vigilante(s) para <b>Reserva</b> (disponíveis, não demitidos)", [guards.length])}</li>
								<li>${__("Arquivar as escalas activas (deixam de gerar)")}</li>
								<li>${__("Inactivar o posto")}</li>
							</ul>
							${lista}
						</div>` },
					{ fieldname: "motivo", fieldtype: "Small Text", reqd: 1,
						label: __("Motivo do encerramento (ex: fim do posto temporário)") },
				],
				primary_action_label: __("Encerrar Posto"),
				primary_action(v) {
					frappe.call({
						method: "sigos.api.encerrar_posto",
						args: { posto: frm.doc.name, motivo: v.motivo },
						freeze: true, freeze_message: __("A encerrar o posto..."),
						callback(res) {
							d.hide();
							const m = res.message || {};
							frappe.show_alert({
								message: __("Posto encerrado: {0} para Reserva, {1} escala(s) arquivada(s).",
									[m.benched || 0, m.arquivadas || 0]),
								indicator: "green",
							}, 7);
							frm.reload_doc();
						},
					});
				},
			});
			// Mark the confirm button as destructive
			d.show();
			d.get_primary_btn().removeClass("btn-primary").addClass("btn-danger");
		},
	});
}

// ─── 7-day Escala preview modal (shared renderer in sigos.js) ─────────────────
function _ver_escala_preview(frm) {
	sigos.show_escala_preview({
		posto: frm.doc.name,
		titulo: frm.doc.nome_do_posto || frm.doc.name,
		allow_create: true,
	});
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
						fieldname: "regime", fieldtype: "Link", label: __("Regime"),
						options: "Regime", reqd: 1,
						description: __("Atribuído a todos os vigilantes seleccionados — obrigatório (define escala e tarifa)"),
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
					if (!vals.regime) {
						frappe.show_alert({ message: __("Seleccione o Regime — é obrigatório para activar."), indicator: "orange" }, 3);
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
						args: { posto: frm.doc.name, vigilantes: escolhidos, regime: vals.regime },
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
