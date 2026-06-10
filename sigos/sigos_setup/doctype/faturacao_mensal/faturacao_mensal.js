// Faturação Mensal — snapshot billing run with a premium preview deck.
// Pré-visualizar -> server snapshots active headcount per (contrato, regime) x tarifa.
// Gerar Faturas  -> one DRAFT Sales Invoice per customer.

frappe.ui.form.on("Faturacao Mensal", {
	refresh(frm) {
		_inject_css();

		// Default the company on a fresh run.
		if (frm.is_new() && !frm.doc.company) {
			frappe.db.get_single_value("SIGOS Settings", "empresa_padrao").then(c => {
				if (c) frm.set_value("company", c);
			});
		}

		const gerado = !!frm.doc.faturas_geradas;
		const temLinhas = (frm.doc.linhas || []).length > 0;

		frm.add_custom_button(__("Pré-visualizar"), () => _previsualizar(frm));

		if (temLinhas && !gerado) {
			frm.add_custom_button(__("Gerar Faturas"), () => _gerar(frm))
				.removeClass("btn-default").addClass("btn-primary");
		}

		_render_deck(frm);
	},

	mes_referencia(frm) { _render_deck(frm); },
	cliente(frm)        { _render_deck(frm); },
});

function _previsualizar(frm) {
	const run = () => frm.call("preview")
		.then(() => frm.reload_doc())
		.then(() => frappe.show_alert({ message: __("Pré-visualização actualizada."), indicator: "blue" }, 4));
	// The server method reads the saved filters, so persist them first.
	(frm.is_dirty() || frm.is_new() ? frm.save() : Promise.resolve()).then(run);
}

function _gerar(frm) {
	frappe.confirm(
		__("Gerar uma factura (rascunho) por cliente para <b>{0}</b>? Total: <b>{1}</b>.", [
			frappe.format(frm.doc.mes_referencia, { fieldtype: "Date" }),
			frappe.format(frm.doc.total_geral || 0, { fieldtype: "Currency" }),
		]),
		() => frm.call("gerar_faturas").then(() => frm.reload_doc()),
	);
}

// ─── Preview deck ─────────────────────────────────────────────────────────────
function _render_deck(frm) {
	const w = frm.fields_dict.deck_faturacao?.$wrapper;
	if (!w) return;

	const linhas = frm.doc.linhas || [];
	const fmtC = v => frappe.format(v || 0, { fieldtype: "Currency" });

	// Group lines by customer
	const porCliente = {};
	linhas.forEach(ln => {
		(porCliente[ln.cliente || "—"] = porCliente[ln.cliente || "—"] || []).push(ln);
	});

	const mes = frm.doc.mes_referencia
		? frappe.format(frm.doc.mes_referencia, { fieldtype: "Date" }) : __("sem mês");
	const gerado = !!frm.doc.faturas_geradas;

	let cards = "";
	Object.keys(porCliente).sort().forEach(cli => {
		const rows = porCliente[cli];
		const sub = rows.reduce((s, r) => s + (r.total || 0), 0);
		const regRows = rows.map(r => {
			const temp = r.tipo_posto === "Temporário"
				? `<span class="fat-temp">${__("Temp.")}</span>` : "";
			return `
			<div class="fat-line">
				<span class="fat-reg">${frappe.utils.escape_html(r.regime || "—")}${temp}</span>
				<span class="fat-proj">${frappe.utils.escape_html(r.project || "")}</span>
				<span class="fat-q">${r.quantidade || 0} ${__("vig.")}</span>
				<span class="fat-u">${fmtC(r.valor_unitario)}</span>
				<span class="fat-t">${fmtC(r.total)}</span>
			</div>`;
		}).join("");
		cards += `
			<div class="fat-card">
				<div class="fat-card-h">
					<span class="fat-cli">${frappe.utils.escape_html(cli)}</span>
					<span class="fat-cli-sub">${fmtC(sub)}</span>
				</div>
				${regRows}
			</div>`;
	});

	const banner = gerado
		? `<div class="fat-banner">${__("Facturas geradas (rascunho):")} ${
			frm.doc.faturas_geradas.split(",").map(n => {
				const t = n.trim();
				return `<a href="/app/sales-invoice/${encodeURIComponent(t)}">${frappe.utils.escape_html(t)}</a>`;
			}).join(" · ")}</div>`
		: "";

	w.html(`
		<div id="sigos-fat-deck">
			<div class="fat-top">
				<div>
					<div class="fat-title">${__("Faturação Mensal")}</div>
					<div class="fat-ctx">${mes}${frm.doc.cliente ? "  ·  " + frappe.utils.escape_html(frm.doc.cliente) : "  ·  " + __("todos os clientes")}</div>
				</div>
				<div class="fat-grand">
					<span class="n">${fmtC(frm.doc.total_geral)}</span>
					<span class="lbl">${frm.doc.total_vigilantes || 0} ${__("vigilantes")}</span>
				</div>
			</div>
			${banner}
			<div class="fat-cards">${cards || `<div class="fat-empty">${__("Use “Pré-visualizar” para calcular a facturação do mês.")}</div>`}</div>
		</div>`);
}

function _inject_css() {
	if (document.getElementById("sigos-fat-css")) return;
	const css = `
#sigos-fat-deck {
	margin: 0 0 14px; padding: 16px 18px; border-radius: 14px; color: #fff;
	background: linear-gradient(135deg, #234a73 0%, #1a3a5c 60%, #14304c 100%);
	box-shadow: 0 8px 24px rgba(20,48,76,.28), inset 0 1px 0 rgba(255,255,255,.08);
	border: 1px solid rgba(255,255,255,.06);
}
.fat-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.fat-title { font-family: var(--sigos-display, system-ui); font-weight: 700; font-size: 1.18em; letter-spacing: .03em; text-transform: uppercase; line-height: 1; }
.fat-ctx { margin-top: 5px; font-size: .82em; color: rgba(255,255,255,.72); }
.fat-grand { text-align: right; }
.fat-grand .n { display: block; font-family: var(--sigos-display, system-ui); font-weight: 700; font-size: 1.7em; line-height: 1; color: #8fe6b8; font-variant-numeric: tabular-nums; }
.fat-grand .lbl { font-size: .7em; text-transform: uppercase; letter-spacing: .05em; color: rgba(255,255,255,.65); }
.fat-banner { margin-top: 12px; padding: 8px 12px; border-radius: 9px; font-size: .82em; background: rgba(47,165,106,.16); border: 1px solid rgba(47,165,106,.4); color: #cdeedd; }
.fat-banner a { color: #8fe6b8; font-weight: 600; }
.fat-cards { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.fat-card { background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.1); border-radius: 10px; padding: 10px 14px; }
.fat-card-h { display: flex; justify-content: space-between; align-items: baseline; padding-bottom: 6px; margin-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,.1); }
.fat-cli { font-weight: 700; font-size: 1.02em; }
.fat-cli-sub { font-family: var(--sigos-display, system-ui); font-weight: 700; color: #fff; font-variant-numeric: tabular-nums; }
.fat-line { display: grid; grid-template-columns: 70px 1fr 70px 110px 120px; gap: 8px; align-items: baseline; padding: 3px 0; font-size: .86em; }
.fat-reg { font-weight: 700; color: #f4cd84; }
.fat-temp { margin-left: 6px; padding: 1px 6px; border-radius: 999px; font-size: .82em; font-weight: 700; background: rgba(232,160,32,.22); color: #f4cd84; border: 1px solid rgba(232,160,32,.45); }
.fat-proj { color: rgba(255,255,255,.7); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fat-q { color: rgba(255,255,255,.85); text-align: right; }
.fat-u { color: rgba(255,255,255,.6); text-align: right; font-variant-numeric: tabular-nums; }
.fat-t { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.fat-empty { color: rgba(255,255,255,.6); font-style: italic; padding: 10px 0; }
`;
	const s = document.createElement("style");
	s.id = "sigos-fat-css";
	s.textContent = css;
	document.head.appendChild(s);
}
