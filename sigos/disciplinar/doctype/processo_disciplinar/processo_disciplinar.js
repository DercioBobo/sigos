frappe.ui.form.on("Processo Disciplinar", {

	onload(frm) {
		_filtro_vigilante(frm);
	},

	refresh(frm) {
		_filtro_vigilante(frm);
		_mostrar_preview_participacao(frm);
	},

	delegacao(frm) {
		if (frm.doc.vigilante) frm.set_value("vigilante", "");
		_filtro_vigilante(frm);
	},
});

// The doctype JSON's own field-level link_filters (status != Demitido) takes
// priority over frm.set_query when both are present — it wins silently,
// dropping delegação scoping entirely — so that condition is folded in here
// instead of living in the JSON (see Ocorrencia/Troca De Regime for precedent).
function _filtro_vigilante(frm) {
	const deleg = frm.doc.delegacao;
	frm.set_query("vigilante", () => ({
		filters: deleg ? { status: ["!=", "Demitido"], delegacao: deleg } : { status: ["!=", "Demitido"] },
	}));
}

// Read-only preview of the original Participação that opened this process.
// gravidade/motivo/detalhes below are just a snapshot HR can freely edit while
// working the process, so this keeps the untouched original report visible for
// reference (the witnesses have no equivalent on the Processo Disciplinar).
function _mostrar_preview_participacao(frm) {
	const w = frm.fields_dict.participacao_preview?.$wrapper;
	if (!w) return;
	if (!frm.doc.participacao_referente) { w.html(""); return; }

	frappe.db.get_doc("Participacao", frm.doc.participacao_referente).then((p) => {
		if (!p) { w.html(""); return; }
		const infracoes = (p.infracoes || []).map((r) => r.tipo_de_infracao).join(", ") || p.tipo_de_infracao;
		const testemunhas = (p.tabela_testemunhas || [])
			.map((t) => [t.nome, t.numero && `Nº ${t.numero}`, t.categoria].filter(Boolean).join(" · "))
			.join("\n") || p.testemunhas;
		const participante = [p.participante_nome, p.participante_numero && `Nº ${p.participante_numero}`,
			p.participante_categoria].filter(Boolean).join(" · ");

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
					${celula(__("Participante"), participante)}
				</div>
				${bloco(__("Infracções"), infracoes + (p.outras_descricao ? ` (${p.outras_descricao})` : ""))}
				${bloco(__("Reportagem"), p.relato)}
				${bloco(__("Testemunhas"), testemunhas)}
			</div>
		`);
	});
}
