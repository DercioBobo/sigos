frappe.ui.form.on("Processo Disciplinar", {

	refresh(frm) {
		_mostrar_preview_participacao(frm);
	},
});

// Read-only preview of the original Participação that opened this process.
// gravidade/motivo/detalhes below are just a snapshot HR can freely edit while
// working the process, so this keeps the untouched original report visible for
// reference (testemunhas has no equivalent field on the Processo Disciplinar).
function _mostrar_preview_participacao(frm) {
	const w = frm.fields_dict.participacao_preview?.$wrapper;
	if (!w) return;
	if (!frm.doc.participacao_referente) { w.html(""); return; }

	frappe.db.get_value("Participacao", frm.doc.participacao_referente, [
		"data", "horas", "posto", "posto_nome", "gravidade", "tipo_de_infracao", "relato", "testemunhas",
	]).then((r) => {
		const p = r.message;
		if (!p) { w.html(""); return; }

		const esc = frappe.utils.escape_html;
		const celula = (label, val) => val
			? `<div class="pdp-cell"><span class="pdp-label">${esc(label)}</span><span class="pdp-val">${esc(val)}</span></div>`
			: "";
		const bloco = (label, val) => val
			? `<div class="pdp-block"><span class="pdp-label">${esc(label)}</span><div class="pdp-text">${esc(val)}</div></div>`
			: "";

		const quando = p.data
			? frappe.datetime.str_to_user(p.data) + (p.horas ? " " + p.horas : "")
			: "";

		w.html(`
			<div class="sigos-pd-part-preview">
				<div class="pdp-head">${__("Registo original")} — ${esc(frm.doc.participacao_referente)}</div>
				<div class="pdp-grid">
					${celula(__("Data"), quando)}
					${celula(__("Posto"), p.posto_nome || p.posto)}
					${celula(__("Gravidade"), p.gravidade)}
					${celula(__("Tipo de Infracção"), p.tipo_de_infracao)}
				</div>
				${bloco(__("Relato dos Factos"), p.relato)}
				${bloco(__("Testemunhas"), p.testemunhas)}
			</div>
		`);
	});
}
