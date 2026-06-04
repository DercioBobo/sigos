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

		// Bulk-allocate reserves ONLY for active temporary posts (deploy a team).
		// Permanent posts never bulk-allocate — reserves there are one-off
		// (substituto in Ausencias, single add in Escala).
		if (!frm.is_new() && frm.doc.estado === "Ativo" && frm.doc.tipo_de_posto === "Temporário") {
			frm.add_custom_button(__("Alocar Reservas"), () => _alocar_reservas(frm), __("Acções"));
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
