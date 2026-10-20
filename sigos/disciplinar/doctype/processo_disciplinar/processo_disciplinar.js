frappe.ui.form.on("Processo Disciplinar", {

	onload(frm) {
		_filtro_vigilante(frm);
	},

	refresh(frm) {
		_filtro_vigilante(frm);
		_mostrar_preview_participacao(frm);
		_ficha(frm);
		_tramitacao(frm);
	},

	vigilante(frm) {
		_ficha(frm);
	},

	// Multa: preview base/30 × days; Despromoção: default to the immediately lower category
	multa_dias(frm) {
		if (!frm.doc.vigilante || !frm.doc.multa_dias) return;
		frappe.xcall("sigos.disciplinar.tramitacao.simular_multa", { vigilante: frm.doc.vigilante, dias: frm.doc.multa_dias })
			.then((v) => frm.set_value("multa_valor", v));
	},
	decisao(frm) {
		if (frm.doc.decisao !== "Despromoção" || frm.doc.despromocao_categoria || !frm.doc.vigilante) return;
		frappe.db.get_value("Vigilante", frm.doc.vigilante, "categoria").then((r) => {
			const cat = r.message && r.message.categoria;
			if (!cat) return;
			frappe.db.get_value("Categoria Vigilante", cat, "categoria_inferior").then((c) => {
				const inf = c.message && c.message.categoria_inferior;
				if (inf) frm.set_value("despromocao_categoria", inf);
				else frappe.show_alert({ message: __("Defina a Categoria Imediatamente Inferior na categoria {0}.", [cat]), indicator: "orange" }, 7);
			});
		});
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

// Ficha do Vigilante — the decision dossier (public/js/ficha_vigilante.js +
// sigos.disciplinar.dossie): seniority, situation, attendance, férias, pay and debts,
// disciplinary history, material to return. The current process is excluded from
// "processos anteriores".
function _ficha(frm) {
	const f = frm.fields_dict.ficha_vigilante;
	if (!f || !(window.sigos && window.sigos.ficha_vigilante)) return;
	sigos.ficha_vigilante.render(f.$wrapper, frm.doc.vigilante, { processo: frm.is_new() ? null : frm.doc.name });
}

// ─── Tramitação (sigos/disciplinar/tramitacao.py) ─────────────────────────────
// Stepper: Abertura → Defesa (15d) → Diligências (5d, optional) → Decisão (30d),
// with Sindicato / Caducado states, deadline chips and the actions.
const _PD_PAPEIS_TRAM = ["Jurista", "Aprovador RH", "SIGOS Manager", "System Manager"];

function _tramitacao(frm) {
	_pd_css();
	const f = frm.fields_dict.painel_tramitacao;
	if (!f || frm.is_new()) { if (f) f.$wrapper.html(""); return; }
	const hoje = frappe.datetime.get_today();
	const d = frm.doc;
	const dt = (x) => (x ? frappe.datetime.str_to_user(x) : "—");
	const faltam = (x) => (x ? frappe.datetime.get_diff(x, hoje) : null);
	const chip = (x, terminado) => {
		if (!x) return "";
		const n = faltam(x);
		if (terminado) return `<span class="pdt-chip ok">${__("concluído")}</span>`;
		if (n < 0) return `<span class="pdt-chip exp">${__("expirou há {0} dia(s)", [-n])}</span>`;
		return `<span class="pdt-chip ${n <= 3 ? "perto" : ""}">${__("faltam {0} dia(s)", [n])}</span>`;
	};
	const fase = d.fase || "Defesa";
	const passos = [
		{ k: "Abertura", t: __("Abertura"), sub: dt(d.data), on: true, done: true },
		{ k: "Defesa", t: __("Defesa"), sub: d.defesa_apresentada ? __("apresentada a {0}", [dt(d.data_defesa)])
			: __("até {0}", [dt(d.prazo_defesa)]), chip: chip(d.prazo_defesa, !!d.defesa_apresentada),
			done: d.defesa_apresentada || faltam(d.prazo_defesa) < 0, perdeu: !d.defesa_apresentada && faltam(d.prazo_defesa) < 0 },
		{ k: "Diligências", t: __("Diligências"), opcional: !d.data_pedido_diligencias,
			sub: d.data_pedido_diligencias ? (d.diligencias_concluidas_em ? __("concluídas a {0}", [dt(d.diligencias_concluidas_em)])
				: __("até {0}", [dt(d.prazo_diligencias)])) : __("não pedidas"),
			chip: d.data_pedido_diligencias ? chip(d.prazo_diligencias, !!d.diligencias_concluidas_em) : "",
			done: !!d.diligencias_concluidas_em },
		{ k: "Decisão", t: __("Decisão Final"), sub: d.docstatus === 1 ? (d.decisao || "—") : __("até {0}", [dt(d.prazo_decisao)]),
			chip: d.docstatus === 1 ? "" : chip(d.prazo_decisao), done: d.docstatus === 1 },
	];
	const alerta = fase === "Caducado"
		? `<div class="pdt-alert exp">${__("<b>Processo caducado</b> — a decisão final tinha de ser tomada até {0}. Só um gestor pode decidir, com justificação.", [dt(d.prazo_decisao)])}</div>`
		: fase === "Sindicato"
			? `<div class="pdt-alert sind">${__("<b>Com o Sindicato</b> desde {0} — as diligências ultrapassaram o prazo. Registe o parecer do Sindicato e a decisão.", [dt(d.sindicato_desde)])}</div>`
			: (passos[1].perdeu && d.docstatus === 0
				? `<div class="pdt-alert">${__("O prazo de defesa terminou a {0} sem defesa — o vigilante perdeu o direito de a apresentar.", [dt(d.prazo_defesa)])}</div>` : "");

	f.$wrapper.html(`<div class="pdt">
		<div class="pdt-head"><span>${__("Fase")}</span><b class="pdt-fase pdt-f-${fase.normalize("NFD").replace(/[^A-Za-z]/g, "").toLowerCase()}">${__(fase)}</b></div>
		${alerta}
		<div class="pdt-steps">${passos.map((p) => `
			<div class="pdt-step ${p.done ? "done" : ""} ${fase === p.k || (p.k === "Diligências" && fase === "Sindicato") ? "cur" : ""} ${p.opcional ? "opc" : ""} ${p.perdeu ? "lost" : ""}">
				<div class="pdt-dot"></div>
				<div class="pdt-t">${p.t}</div>
				<div class="pdt-sub">${p.sub}</div>
				${p.chip || ""}
			</div>`).join("")}
		</div>
	</div>`);

	if (d.docstatus !== 0 || !_PD_PAPEIS_TRAM.some((r) => frappe.user.has_role(r))) return;
	const em_defesa = faltam(d.prazo_defesa) !== null && faltam(d.prazo_defesa) >= 0;
	if (!d.defesa_apresentada && em_defesa) {
		frm.add_custom_button(__("Registar Defesa"), () => frappe.prompt([
			{ fieldname: "data", fieldtype: "Date", label: __("Data da Defesa"), reqd: 1, default: hoje },
			{ fieldname: "texto", fieldtype: "Text", label: __("Defesa (resumo)") },
			{ fieldname: "anexo", fieldtype: "Attach", label: __("Documento da Defesa") },
		], (v) => frm.call("registar_defesa", v).then(() => frm.reload_doc()),
		__("Registar Defesa"), __("Registar")), __("Tramitação"));
	}
	if (!d.data_pedido_diligencias && em_defesa) {
		frm.add_custom_button(__("Pedido de Diligências"), () => frappe.prompt([
			{ fieldtype: "HTML", options: `<p class="text-muted">${__("O vigilante pede diligências/investigação durante o prazo de defesa. Duram até ao prazo definido (5 dias por defeito); ultrapassado, o processo passa para o Sindicato.")}</p>` },
			{ fieldname: "data", fieldtype: "Date", label: __("Data do Pedido"), reqd: 1, default: hoje },
			{ fieldname: "descricao", fieldtype: "Text", label: __("Diligências pedidas"), reqd: 1 },
		], (v) => frm.call("pedir_diligencias", v).then(() => frm.reload_doc()),
		__("Pedido de Diligências"), __("Registar")), __("Tramitação"));
	}
	if (d.data_pedido_diligencias && !d.diligencias_concluidas_em) {
		frm.add_custom_button(__("Concluir Diligências"), () => frappe.prompt([
			{ fieldname: "data", fieldtype: "Date", label: __("Concluídas em"), reqd: 1, default: hoje },
			{ fieldname: "resultado", fieldtype: "Text", label: __("Resultado") },
		], (v) => frm.call("concluir_diligencias", v).then(() => frm.reload_doc()),
		__("Concluir Diligências"), __("Concluir")), __("Tramitação"));
	}
}

function _pd_css() {
	if (document.getElementById("sigos-pdt-css")) return;
	const c = `
.pdt { border: 1px solid #e3e8ef; border-radius: 12px; padding: 14px 16px; background: #fbfcfe; }
.pdt-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 12px; color: #5b6b7c;
	text-transform: uppercase; letter-spacing: .06em; }
.pdt-fase { font-size: 13px; padding: 3px 12px; border-radius: 999px; background: #e8eef6; color: #1a3a5c; text-transform: none; letter-spacing: 0; }
.pdt-f-caducado { background: #fde8e8; color: #a32020; } .pdt-f-sindicato { background: #f3e8ff; color: #6b21a8; }
.pdt-f-concluido { background: #e7f6ee; color: #1f7a4c; } .pdt-f-diligencias { background: #fff3dd; color: #8a5a00; }
.pdt-alert { padding: 8px 12px; border-radius: 9px; font-size: 12.5px; margin-bottom: 10px; background: #fff8e6; border-left: 4px solid #e8a020; }
.pdt-alert.exp { background: #fff1f1; border-left-color: #d64545; }
.pdt-alert.sind { background: #f8f0ff; border-left-color: #8b5cf6; }
.pdt-steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; position: relative; }
.pdt-step { position: relative; padding: 10px 10px 10px 30px; border: 1px solid #e3e8ef; border-radius: 10px; background: #fff; }
.pdt-step.cur { border-color: #1a3a5c; box-shadow: 0 0 0 2px rgba(26, 58, 92, .12); }
.pdt-step.opc { opacity: .6; }
.pdt-step.lost { border-color: #f3b4b4; background: #fff7f7; }
.pdt-dot { position: absolute; left: 10px; top: 13px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #9fb3c8; background: #fff; }
.pdt-step.done .pdt-dot { background: #2fa56a; border-color: #2fa56a; }
.pdt-step.cur .pdt-dot { border-color: #1a3a5c; background: #1a3a5c; }
.pdt-step.lost .pdt-dot { background: #d64545; border-color: #d64545; }
.pdt-t { font-weight: 700; font-size: 12.5px; color: #1f2933; }
.pdt-sub { font-size: 11.5px; color: #5b6b7c; margin: 2px 0 4px; }
.pdt-chip { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 999px; background: #e7f6ee; color: #1f7a4c; }
.pdt-chip.perto { background: #fff3dd; color: #8a5a00; }
.pdt-chip.exp { background: #fde8e8; color: #a32020; font-weight: 600; }
.pdt-chip.ok { background: #e8eef6; color: #1a3a5c; }
@media (max-width: 900px) { .pdt-steps { grid-template-columns: 1fr 1fr; } }`;
	$(`<style id="sigos-pdt-css">${c}</style>`).appendTo("head");
}

