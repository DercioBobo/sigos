// Perfil De Faturacao — live example of the line text.
frappe.ui.form.on("Perfil De Faturacao", {
	refresh(frm) { _pf_exemplo(frm); },
	modelo_descricao(frm) {
		clearTimeout(frm._pf_t);
		frm._pf_t = setTimeout(() => _pf_exemplo(frm), 400);
	},
	detalhe_fatura(frm) { _pf_exemplo(frm); },
});

function _pf_exemplo(frm) {
	const f = frm.get_field("pre_visualizacao");
	if (!f) return;
	frappe.call({
		method: "sigos.descricao_fatura.previsualizar_modelo",
		args: { modelo: frm.doc.modelo_descricao || "", detalhe: frm.doc.detalhe_fatura || "Por Contrato" },
	}).then((r) => {
		const m = r.message || {};
		const esc = frappe.utils.escape_html;
		f.$wrapper.html(m.erro
			? `<div class="text-danger small">${esc(m.erro)}</div>`
			: `<div class="text-muted small" style="margin-bottom:4px">${__("Exemplo")}</div>
			   <div style="padding:8px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--subtle-fg)">${esc(m.texto || "")}</div>`);
	});
}
