// SIGOS — Customer helpers.
frappe.ui.form.on("Customer", {
	refresh(frm) {
		_resumo_faturacao(frm);
		if (frm.is_new()) return;
		frm.add_custom_button(__("Faturar Mês"), () => sigos.faturar_mes(frm.doc.name), __("SIGOS"));
		frm.add_custom_button(__("Previsão de Faturação"), () => frappe.set_route("previsao-de-faturacao"), __("SIGOS"));
	},

	custom_perfil_faturacao(frm) { _resumo_faturacao(frm); },
});

// Billing card: the profile that applies (the unsaved choice too), what it means in
// plain words, and this month's invoice lines with its text.
function _resumo_faturacao(frm) {
	const f = frm.get_field("custom_perfil_resumo");
	if (!f) return;
	if (frm.is_new()) {
		f.$wrapper.empty();
		return;
	}
	const pedido = (frm._sigos_fat_n = (frm._sigos_fat_n || 0) + 1);
	frappe.call({
		method: "sigos.perfil_faturacao.resumo_cliente",
		args: { customer: frm.doc.name, perfil: frm.doc.custom_perfil_faturacao || "" },
	}).then((r) => {
		if (pedido !== frm._sigos_fat_n) return;
		const m = r.message || {};
		const esc = frappe.utils.escape_html;
		const nome = m.perfil
			? `<a href="/app/perfil-de-faturacao/${encodeURIComponent(m.perfil)}">${esc(m.perfil)}</a>`
			: __("SIGOS (sem perfil configurado)");
		const origem = m.proprio ? "" : ` <span class="text-muted">· ${__("padrão")}</span>`;
		const pontos = (m.resumo || []).map((t) => `<li>${esc(t)}</li>`).join("");
		const linhas = (m.linhas || []).map((l) => `<tr>
			<td>${esc(l.descricao || "")}</td>
			<td style="text-align:right;white-space:nowrap">${l.quantidade}</td>
			<td style="text-align:right;white-space:nowrap">${format_currency(l.total)}</td>
		</tr>`).join("");
		f.$wrapper.html(`<div style="border:1px solid var(--border-color);border-radius:8px;padding:12px 14px;margin-top:4px">
			<div style="font-weight:600;margin-bottom:6px">${__("Perfil")}: ${nome}${origem}</div>
			<ul style="margin:0 0 10px 18px;padding:0;font-size:12.5px">${pontos}</ul>
			${linhas ? `<div class="text-muted small" style="margin-bottom:4px">${__("Factura deste mês")}</div>
			<table class="table table-sm table-bordered" style="font-size:12px;margin:0">
				<thead><tr><th>${__("Descrição")}</th><th style="text-align:right">${__("Qtd")}</th><th style="text-align:right">${__("Total")}</th></tr></thead>
				<tbody>${linhas}</tbody>
			</table>` : `<div class="text-muted small">${__("Sem linhas a facturar este mês.")}</div>`}
		</div>`);
	}, () => {
		if (pedido !== frm._sigos_fat_n) return;
		f.$wrapper.empty();
	});
}
