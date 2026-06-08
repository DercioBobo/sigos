// The Rotatividade form IS the wizard (Option A).
//  - new / draft (docstatus 0)  -> inline wizard rendered into the canvas
//  - submitted   (docstatus 1)  -> read-only summary card
// Native fields are hidden in both modes; the canvas is the whole experience.

frappe.ui.form.on("Rotatividade", {
	refresh(frm) {
		if (typeof sigos.build_rotatividade_wizard !== "function") {
			// asset not loaded yet — show a hint instead of a broken form
			frm.fields_dict.wizard_canvas.$wrapper.html(
				`<div style="padding:24px;color:#888">${__("A carregar assistente… actualize a página (Ctrl+Shift+R).")}</div>`);
			return;
		}
		_hide_native(frm);
		if (frm.doc.docstatus === 1) _summary_mode(frm);
		else _wizard_mode(frm);
	},
});

// ─── hide the native field area, keep only the canvas ─────────────────────────
function _hide_native(frm) {
	frm.$wrapper.addClass("rotw-form-mode");
	(frm.fields || []).forEach((f) => {
		if (f.df.fieldname !== "wizard_canvas") frm.set_df_property(f.df.fieldname, "hidden", 1);
	});
}

// ─── wizard mode (new / draft) ────────────────────────────────────────────────
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
			return frm.save("Submit").then(() => {
				frappe.show_alert({ message: __("Rotatividade aplicada."), indicator: "green" }, 5);
			});
		},
	});
}

// ─── summary mode (submitted) ─────────────────────────────────────────────────
function _summary_mode(frm) {
	const d = frm.doc;
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
	if (d.nova_categoria) rows.push(cell(__("Categoria"), d.categoria_vigilante, d.nova_categoria));
	if (d.motivo === "Demissão") rows.push(cell(__("Estado"), __("Activo"), __("Demitido")));

	const sub = d.novo_vigilante ? `<div class="rotw-block"><div class="rotw-block-h">${__("Substituto")}</div>
		<div class="rotw-sub">${frappe.utils.escape_html(d.novo_vigilante)} ${__("assumiu")}
		<b>${frappe.utils.escape_html(d.alocado_ao_posto || "—")}</b></div></div>` : "";

	const html = `
		<div class="rotw-summary">
			<div class="rotw-head">
				<div class="rotw-op">${frappe.utils.escape_html((d.abreviatura_op || "") + " · " + (d.vigilante || ""))}</div>
				<div class="rotw-stepper"><div class="rotw-node done"><span class="rotw-dot">✓</span>
					<span class="rotw-nlabel">${__("Aplicada em")} ${frappe.datetime.str_to_user(d.data) || ""}</span></div></div>
			</div>
			<div class="rotw-preview">
				<div class="rotw-block"><div class="rotw-block-h">${__("Alterações")}</div>
					${rows.join("") || `<div class="rotw-none">${__("Sem alterações directas ao vigilante.")}</div>`}</div>
				${sub}
				${d.motivo ? `<div class="rotw-block"><div class="rotw-block-h">${__("Motivo")}</div>
					<div class="rotw-sub">${frappe.utils.escape_html(d.motivo)}${d.motiv_demi ? " · " + frappe.utils.escape_html(d.motiv_demi) : ""}</div></div>` : ""}
			</div>
		</div>`;

	frm.fields_dict.wizard_canvas.$wrapper.addClass("sigos-rotw2").html(html);
}
