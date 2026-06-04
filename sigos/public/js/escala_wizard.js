/**
 * SIGOS — Wizard de Actualização de Escala
 *
 * Called after Rotatividade, Demissão, or Troca de Regime is submitted.
 * Walks the ops manager through each active Escala (one per posto) that still
 * has FUTURE rows for the affected vigilante. Updates the escala's guard list;
 * day rows regenerate automatically via reconciliar_escala() on the server.
 *
 * Usage:
 *   sigos.wizard_actualizar_escalas({
 *     vigilante,
 *     tipo: "rotatividade" | "demissao" | "troca_regime",
 *     novo_vigilante_sugerido,   // Rotatividade APV only
 *   });
 */

frappe.provide("sigos");

sigos.wizard_actualizar_escalas = function (opcoes) {
	const { vigilante, tipo, novo_vigilante_sugerido } = opcoes;

	frappe.call({
		method: "sigos.api.get_escalas_activas_para_vigilante",
		args: { vigilante },
		freeze: true,
		freeze_message: __("A verificar escalas activas..."),
		callback(r) {
			const escalas = r.message || [];
			if (!escalas.length) {
				frappe.show_alert({
					message: __("Nenhuma escala activa encontrada para este vigilante."),
					indicator: "green",
				}, 4);
				return;
			}
			_processar(escalas, 0, { vigilante, tipo, novo_vigilante_sugerido });
		},
	});
};

// ─── Step through each Escala ─────────────────────────────────────────────────
function _processar(escalas, idx, ctx) {
	if (idx >= escalas.length) {
		frappe.show_alert({
			message: __("Escalas actualizadas."),
			indicator: "green",
		}, 4);
		return;
	}
	const escala = escalas[idx];
	_dialog(escala, ctx, `${idx + 1} / ${escalas.length}`, () => _processar(escalas, idx + 1, ctx));
}

// ─── Dialog for one Escala ────────────────────────────────────────────────────
function _dialog(escala, ctx, progresso, on_next) {
	const { vigilante, tipo, novo_vigilante_sugerido } = ctx;

	const header = `
		<div style="background:#f8f8f8;border-radius:6px;padding:12px 14px;margin-bottom:4px;">
			<div style="display:flex;justify-content:space-between;align-items:center;">
				<b>${escala.name}</b>
				<span class="badge badge-pill badge-secondary">${progresso}</span>
			</div>
			<div style="margin-top:6px;color:#555;font-size:.9em;">
				<b>Posto:</b> ${escala.posto_de_vigilancia}
				&nbsp;|&nbsp; <b>Vigilante:</b> ${escala.nome_vigilante || vigilante}
				&nbsp;|&nbsp; <b>Dias futuros:</b> ${escala.linhas_futuras || 0}
			</div>
		</div>`;

	const default_accao = novo_vigilante_sugerido
		? "Substituir por outro vigilante"
		: "Remover apenas";

	const d = new frappe.ui.Dialog({
		title: __("Actualizar Escala do Posto"),
		fields: [
			{ fieldname: "header", fieldtype: "HTML", options: header },
			{
				fieldname: "accao",
				fieldtype: "Select",
				label: __("O que fazer?"),
				options: "\nSubstituir por outro vigilante\nRemover apenas\nMais tarde",
				default: default_accao,
				reqd: 1,
			},
			{
				fieldname: "sec_sub",
				fieldtype: "Section Break",
				depends_on: 'eval: doc.accao === "Substituir por outro vigilante"',
			},
			{
				fieldname: "novo_vigilante",
				fieldtype: "Link",
				label: __("Vigilante de Substituição"),
				options: "Vigilante",
				default: novo_vigilante_sugerido || "",
				get_query: () => ({
					query: "sigos.api.get_substitutos_para_wizard",
					filters: { escala_name: escala.name, excluir: vigilante },
				}),
				description: __("Categoria autorizada e sem escala activa"),
			},
			{
				fieldname: "detectar_turno",
				fieldtype: "Check",
				label: __("Detectar turno automaticamente (manter posição do ciclo)"),
				default: 1,
			},
			{
				fieldname: "turno_inicial",
				fieldtype: "Link",
				label: __("Turno Inicial"),
				options: "Turno",
				depends_on: "eval: !doc.detectar_turno",
				get_query: () => ({
					query: "sigos.api.get_turnos_do_regime_query",
					filters: { regime: escala.regime_do_vigilante || "" },
				}),
			},
		],
		primary_action_label: __("Confirmar"),
		primary_action(v) {
			if (v.accao === "Mais tarde") { d.hide(); on_next(); return; }

			const accao = v.accao === "Substituir por outro vigilante" ? "substituir" : "remover";
			if (accao === "substituir" && !v.novo_vigilante) {
				frappe.show_alert({ message: __("Seleccione o substituto."), indicator: "red" }, 3);
				return;
			}

			frappe.call({
				method: "sigos.api.actualizar_escala_apos_mudanca",
				args: {
					escala_name: escala.name,
					vigilante,
					accao,
					novo_vigilante: v.novo_vigilante || null,
					turno_inicial: v.detectar_turno ? null : (v.turno_inicial || null),
					detectar_turno: v.detectar_turno ? 1 : 0,
				},
				freeze: true,
				freeze_message: __("A actualizar escala..."),
				callback() {
					frappe.show_alert({ message: `${escala.name} actualizada.`, indicator: "green" }, 4);
					d.hide();
					on_next();
				},
			});
		},
		secondary_action_label: __("Pular"),
		secondary_action() { d.hide(); on_next(); },
	});

	d.show();
}
