// The Rotatividade form IS the wizard (Option A), and it is WORKFLOW-AWARE.
//   - new / unsaved doc                    -> wizard canvas (nothing captured yet)
//   - saved, workflow-governed, docstatus 0 -> resumo; native workflow Actions
//     button drives the transitions (Enviar p/ Aprovação / Aprovar / Rejeitar)
//   - submitted / docstatus 1 (applied)    -> resumo + "Reverter"
// The wizard is ONLY ever shown for a brand-new doc. It has no memory of a saved
// record (it only ever pre-fills vigilante, nothing else it captured), so once
// something is saved the resumo is the only view that can be trusted to show what
// was actually proposed — which matters most for an approver reviewing a later
// step, who must never see a blank wizard in place of the other person's work.
// Native fields are hidden in every mode; the canvas is the whole experience.
//
// Confirmar behaviour adapts automatically:
//   - workflow attached  -> save draft + fire the 1st transition (send for approval)
//   - no workflow        -> save + submit (applies immediately, gated server-side anyway)

frappe.ui.form.on("Rotatividade", {
	refresh(frm) {
		if (typeof sigos.build_rotatividade_wizard !== "function") {
			// asset not loaded yet — show a hint instead of a broken form
			frm.fields_dict.wizard_canvas.$wrapper.html(
				`<div style="padding:24px;color:#888">${__("A carregar assistente… actualize a página (Ctrl+Shift+R).")}</div>`);
			return;
		}
		_hide_native(frm);

		const mode = _mode(frm);
		if (mode === "wizard") {
			_wizard_mode(frm);
		} else {
			frm._rotw_mounted = false;     // if it ever becomes editable again, remount fresh
			_summary_mode(frm, mode);      // "applied" | "pending"
		}
	},
});

// ─── mode resolution (workflow-aware) ─────────────────────────────────────────
function _has_workflow(frm) {
	// The workflow_state field only exists once a Workflow governs the doctype.
	return !!frm.fields_dict.workflow_state;
}

function _mode(frm) {
	if (frm.doc.docstatus === 1) return "applied";           // Aprovado + submitted
	// A brand-new, unsaved doc is always the wizard — nothing has been captured yet.
	if (frm.is_new()) return "wizard";
	// Once a workflow-governed doc has been SAVED, always show the resumo — never
	// the wizard again. The wizard has no memory of a saved doc (it only ever
	// pre-fills vigilante, nothing else), so re-entering it for an existing
	// record silently discards the view of everything already captured — exactly
	// what an approver reviewing a later step must NOT see. There is no in-place
	// edit: corrections happen via a fresh Rotatividade (see "Nova Rotatividade"
	// in _summary_mode), same pattern as "Reverter" on an applied doc.
	if (_has_workflow(frm)) return "pending";
	return "wizard";
}

// ─── hide the native field area, keep only the canvas ─────────────────────────
function _hide_native(frm) {
	frm.$wrapper.addClass("rotw-form-mode");
	(frm.fields || []).forEach((f) => {
		if (f.df.fieldname !== "wizard_canvas") frm.set_df_property(f.df.fieldname, "hidden", 1);
	});
}

// ─── wizard mode (new / Rascunho) ─────────────────────────────────────────────
function _wizard_mode(frm) {
	const $canvas = frm.fields_dict.wizard_canvas.$wrapper;
	if (frm._rotw_mounted) return;          // mount once; keep wizard state across refreshes
	frm._rotw_mounted = true;

	$canvas.addClass("sigos-rotw2");
	const $inner = $('<div class="rotw-inline"></div>').appendTo($canvas.empty());

	sigos.build_rotatividade_wizard({
		$mount: $inner,
		prefill: frm.doc.vigilante ? { vigilante: frm.doc.vigilante } : {},
		cancelLabel: __("Recomeçar"),
		onCancel: () => { frm._rotw_mounted = false; _wizard_mode(frm); },   // reset fresh
		onConfirm: (docData) => {
			Object.entries(docData).forEach(([k, v]) => {
				if (k !== "doctype" && v != null) frm.doc[k] = v;
			});
			frm.dirty();

			if (_has_workflow(frm)) {
				// Save the Rascunho draft only -- the transition itself (e.g. "Submeter
				// para Aprovação") is a native workflow action, listed on the page's
				// own Actions button, so it is not duplicated here.
				return frm.save().then(() => {
					frm.refresh();
					frappe.show_alert({
						message: __("Guardado como Rascunho. Use o botão de acções no topo para enviar para aprovação."),
						indicator: "blue",
					}, 7);
				});
			}
			// No workflow: apply immediately (direct submit).
			return frm.save("Submit").then(() => {
				frappe.show_alert({ message: __("Rotatividade aplicada."), indicator: "green" }, 5);
			});
		},
	});
}

// ─── summary mode (pending approval OR applied) ────────────────────────────────
// Same level of detail in both states — approval only gates whether it's applied,
// it shouldn't hide what was proposed. Only the wizard's CTA/navigation disappears;
// everything else (changes, escala, ocupação, substituto, motivo) stays visible.
function _summary_mode(frm, mode) {
	const d = frm.doc;
	const applied = mode === "applied";

	// Header badge reflects the state: applied vs. out for approval (with the workflow state).
	const nodeClass = applied ? "done" : "pending";
	const dot = applied ? "✓" : "⏳";
	const stateLabel = applied
		? `${__("Aplicada em")} ${frappe.datetime.str_to_user(d.data) || ""}`
		: (d.workflow_state || __("Pendente de Aprovação"));
	// The very first save (still at the workflow's own starting state) hasn't
	// actually been sent for approval yet — say so, instead of implying it's
	// already out for review when it's just sitting as a draft.
	const isDraftState = !applied && _has_workflow(frm)
		&& d.workflow_state === frappe.workflow.get_default_state(frm.doctype, 0);
	const pendingNote = isDraftState
		? __("Rascunho guardado — use o botão de acções no topo para enviar para aprovação.")
		: __("Esta rotatividade aguarda aprovação — só será aplicada ao vigilante depois de aprovada.");

	const extras = `
		${d.motivo ? `<div class="rotw-block"><div class="rotw-block-h">${__("Motivo")}</div>
			<div class="rotw-sub">${frappe.utils.escape_html(d.motivo)}${d.motiv_demi ? " · " + frappe.utils.escape_html(d.motiv_demi) : ""}${d.data_de_demissao ? " · " + __("Demissão em") + " " + (frappe.datetime.str_to_user(d.data_de_demissao) || "") : ""}</div></div>` : ""}
		${d.motivo_rotatividade ? `<div class="rotw-block"><div class="rotw-block-h">${__("Justificação")}</div>
			<div class="rotw-sub">${frappe.utils.escape_html(d.motivo_rotatividade)}</div></div>` : ""}`;

	const shell = (bodyHtml) => `
		<div class="rotw-summary">
			<div class="rotw-head">
				<div class="rotw-op">${frappe.utils.escape_html((d.abreviatura_op || "") + " · " + (d.vigilante || ""))}</div>
				<div class="rotw-stepper"><div class="rotw-node ${nodeClass}"><span class="rotw-dot">${dot}</span>
					<span class="rotw-nlabel">${frappe.utils.escape_html(stateLabel)}</span></div></div>
			</div>
			${applied ? "" : `<div class="rotw-pending-note">${pendingNote}</div>`}
			${bodyHtml}
		</div>`;

	const $wrapper = frm.fields_dict.wizard_canvas.$wrapper.addClass("sigos-rotw2");

	if (applied) {
		// Historical record: the vigilante has already moved, so a fresh dry-run
		// preview would diff "before" against the NOW-current (already new) state
		// and show nothing. Render from the doc's own stored values instead.
		const cell = (label, from, to) => `
			<div class="rotw-change">
				<span class="rotw-cfield">${label}</span>
				<span class="rotw-cflow">
					<span class="rotw-cfrom">${frappe.utils.escape_html(from || "—")}</span>
					<span class="rotw-carrow">→</span>
					<span class="rotw-cto">${frappe.utils.escape_html(to || "—")}</span>
				</span>
			</div>`;
		const rows = [];
		if (d.novo_posto) rows.push(cell(__("Posto"), d.antigo_posto, d.novo_posto));
		if (d.novo_regime) rows.push(cell(__("Regime"), d.regime, d.novo_regime));
		if (d.motivo === "Demissão") rows.push(cell(__("Estado"), __("Activo"), __("Demitido")));
		const sub = d.novo_vigilante ? `<div class="rotw-block"><div class="rotw-block-h">${__("Substituto")}</div>
			<div class="rotw-sub">${frappe.utils.escape_html(d.novo_vigilante)} ${__("assumiu")}
			<b>${frappe.utils.escape_html(d.alocado_ao_posto || "—")}</b></div></div>` : "";
		const body = `<div class="rotw-preview">
			<div class="rotw-block"><div class="rotw-block-h">${__("Alterações")}</div>
				${rows.join("") || `<div class="rotw-none">${__("Sem alterações directas ao vigilante.")}</div>`}</div>
			${sub}${extras}
		</div>`;
		$wrapper.html(shell(body));
		frm.add_custom_button(__("Reverter (Nova Rotatividade)"), () => {
			frappe.route_options = { vigilante: d.vigilante };
			frappe.new_doc("Rotatividade");
		});
		return;
	}

	// Corrections always happen via a fresh Rotatividade (same pattern as
	// "Reverter" once applied) — there's no in-place edit, so make sure that
	// path is just as reachable here as it is once applied.
	frm.add_custom_button(__("Nova Rotatividade"), () => {
		frappe.route_options = { vigilante: d.vigilante };
		frappe.new_doc("Rotatividade");
	});

	// Pending: dry-run the same preview the wizard showed on confirmation (escala
	// movement, ocupação deltas, substituto, warnings) — full detail stays visible
	// while it awaits approval, only the wizard's own CTA is gone.
	if (!d.vigilante || !d.abreviatura_op) {
		// Defensive only — a "pending" doc should always have both by now.
		$wrapper.html(shell(`<div class="rotw-none">${__("Sem alterações directas ao vigilante.")}</div>${extras}`));
		return;
	}
	$wrapper.html(shell(`<div class="rotw-prev-loading">${__("A calcular efeitos…")}</div>`));
	frappe.call({
		method: "sigos.api.preview_rotatividade",
		args: {
			vigilante: d.vigilante, abreviatura_op: d.abreviatura_op,
			novo_posto: d.novo_posto, novo_regime: d.novo_regime,
			novo_vigilante: d.novo_vigilante, motivo: d.motivo, motivo_3meses: d.motivo_3meses,
		},
		callback: (r) => {
			const body = sigos.render_rotatividade_preview(r.message || {}) + extras;
			frm.fields_dict.wizard_canvas.$wrapper.html(shell(body));
		},
	});
}
