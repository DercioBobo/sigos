frappe.ui.form.on("Rotatividade", {

	onload(frm) {
		_set_queries(frm);
	},

	refresh(frm) {
		_apply_operacao(frm);
		_render_situacao(frm);

		// A friendly nudge towards the wizard for new docs
		if (frm.is_new()) {
			frm.add_custom_button(__("Abrir Assistente"), () => _launch_wizard(frm.doc.vigilante)).addClass("btn-primary");
		}
	},

	delegacao(frm) { _set_queries(frm); },

	abreviatura_op(frm) { _apply_operacao(frm); },

	motivo(frm) { _apply_operacao(frm); },

	vigilante(frm) {
		if (!frm.doc.vigilante) { _render_situacao(frm); return; }
		frappe.db.get_doc("Vigilante", frm.doc.vigilante).then((v) => {
			frm.set_value("antigo_posto", v.posto_de_vigilancia);
			frm.set_value("regime", v.regime_do_vigilante);
			frm.set_value("categoria_vigilante", v.categoria);
			frm.set_value("mecanografico", v.mecanografico);
			if (!frm.doc.delegacao) frm.set_value("delegacao", v.delegacao);
			frm._estado = {
				posto: v.posto_de_vigilancia, regime: v.regime_do_vigilante,
				categoria: v.categoria, delegacao: v.delegacao, status: v.status,
			};
			_render_situacao(frm);
		});
	},

	novo_vigilante(frm) {
		frm.set_value("alocado_ao_posto", frm.doc.antigo_posto);
	},
});

// ─── Launch wizard (defensive against stale asset cache) ──────────────────────
function _launch_wizard(vigilante) {
	if (typeof sigos.rotatividade_wizard !== "function") {
		frappe.msgprint({
			title: __("Assistente não carregado"),
			message: __("Os recursos do assistente ainda não foram carregados. Actualize a página (Ctrl+Shift+R)."),
			indicator: "orange",
		});
		return;
	}
	sigos.rotatividade_wizard({ vigilante: vigilante || undefined });
}

// ─── Apply the selected operation's flags to field visibility ─────────────────
function _apply_operacao(frm) {
	const op = frm.doc.abreviatura_op;
	if (!op) { _toggle(frm, {}); return; }

	frappe.db.get_doc("Operacao De Rotatividade", op).then((o) => {
		const demite = !!o.demite || frm.doc.motivo === "Demissão";
		_toggle(frm, {
			muda_posto: !!o.muda_posto,
			muda_regime: !!o.muda_regime,
			muda_categoria: !!o.muda_categoria,
			requer_substituto: !!o.requer_substituto,
			demite,
		});
	});
}

function _toggle(frm, f) {
	// posto / regime / categoria changes
	frm.toggle_display("novo_posto", !!f.muda_posto);
	frm.toggle_reqd("novo_posto", !!f.muda_posto);
	frm.toggle_display("novo_regime", !!f.muda_regime);
	frm.toggle_reqd("novo_regime", !!f.muda_regime);
	frm.toggle_display("nova_categoria", !!f.muda_categoria);
	frm.toggle_reqd("nova_categoria", !!f.muda_categoria);

	// substituto section
	const sub = !!f.requer_substituto;
	["sec_substituto", "alocar_vigilante_substituto", "novo_vigilante", "alocado_ao_posto",
		"cliente_novo_posto", "categoria_vigilante_a_alocar"].forEach((fn) => frm.toggle_display(fn, sub));

	// demissão section
	const dem = !!f.demite;
	["sec_demissao", "motiv_demi", "uniforme"].forEach((fn) => frm.toggle_display(fn, dem));
}

// ─── Situação actual card (matches the wizard) ────────────────────────────────
function _render_situacao(frm) {
	const w = frm.fields_dict.situacao_card?.$wrapper;
	if (!w) return;
	const e = frm._estado;
	if (!frm.doc.vigilante || !e) { w.html(""); return; }

	const cell = (label, val) => `<div class="rotw-scell">
		<span class="rotw-slabel">${label}</span>
		<span class="rotw-sval">${val ? frappe.utils.escape_html(val) : "—"}</span></div>`;

	w.html(`
		<div class="rotw-state" style="margin-top:4px">
			<div class="rotw-state-title">${__("Situação Actual")} — ${frappe.utils.escape_html(frm.doc.vigilante)}</div>
			<div class="rotw-state-grid">
				${cell(__("Posto"), e.posto)}
				${cell(__("Regime"), e.regime)}
				${cell(__("Categoria"), e.categoria)}
				${cell(__("Delegação"), e.delegacao)}
			</div>
		</div>`);
}

// ─── Link queries ─────────────────────────────────────────────────────────────
function _set_queries(frm) {
	frm.set_query("vigilante", () => ({
		filters: [["status", "=", "Activo"], ["categoria", "!=", "Administrativo"]],
	}));
	frm.set_query("novo_posto", () => ({
		filters: { delegacao: frm.doc.delegacao, estado: "Activo" },
	}));
	frm.set_query("novo_vigilante", () => ({
		query: "sigos.api.get_substitutos_disponiveis",
		filters: { delegacao: frm.doc.delegacao || "", excluir: frm.doc.vigilante || "" },
	}));
}
