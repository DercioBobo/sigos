frappe.ui.form.on("Posto De Vigilancia", {

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
