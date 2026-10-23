// Faturação Mensal — snapshot billing run with a premium preview deck.
// Pré-visualizar -> server counts per (contrato, regime) by the contract's método
//                   (Vigilantes Activos | Contratual) x the contract's Finance tariff.
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

		// Stays available after a run: re-running only invoices the customers still
		// missing (already-invoiced ones are skipped server-side).
		if (temLinhas) {
			frm.add_custom_button(gerado ? __("Gerar Faturas em Falta") : __("Gerar Faturas"), () => _gerar(frm))
				.removeClass("btn-default").addClass("btn-primary");
			frm.add_custom_button(__("Pré-visualizar Factura"), () => _pre_visualizar_impressao(frm));
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
	// Pre-flight first (server re-checks on generate): show every problem in one go.
	const run = () => frm.call("verificar").then(r => {
		const v = r.message || {};
		const erros = v.erros || [], avisos = v.avisos || [], clientes = v.clientes || {};
		const nomes = Object.keys(clientes);
		const lista = (arr) => `<ul style="margin:4px 0 10px 18px;padding:0">${arr.map(x => `<li>${x}</li>`).join("")}</ul>`;

		if (erros.length) {
			frappe.msgprint({
				title: __("Não é possível gerar"),
				indicator: "red",
				message: lista(erros),
			});
			return;
		}

		let html = __("Gerar uma factura (rascunho) por cliente para <b>{0}</b>? Total: <b>{1}</b>.", [
			frappe.format(frm.doc.mes_referencia, { fieldtype: "Date" }),
			frappe.format(frm.doc.total_geral || 0, { fieldtype: "Currency" }),
		]);
		if (nomes.length) {
			html += `<br><br><b>${__("Clientes que serão ignorados:")}</b>` + lista(
				nomes.map(c => `<b>${frappe.utils.escape_html(c)}</b>: ${clientes[c].join("; ")}`));
		}
		if (avisos.length) {
			html += `<br><b>${__("Avisos:")}</b>` + lista(avisos);
		}
		frappe.confirm(html, () => frm.call("gerar_faturas").then(() => frm.reload_doc()));
	});
	(frm.is_dirty() ? frm.save() : Promise.resolve()).then(run);
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
			const contr = r.metodo === "Contratual"
				? `<span class="fat-metodo">${__("Contratual")}</span>` : "";
			// Activos lines: flag a headcount that differs from the contract;
			// Contratual lines: flag a contracted qty that differs from the active guards.
			let dif = "";
			if (r.metodo !== "Contratual" && r.quantidade_contratada && r.quantidade_contratada !== r.quantidade) {
				dif = `<span class="fat-dif" title="${__("Contratados no contrato")}">${__("contr.")} ${r.quantidade_contratada}</span>`;
			} else if (r.metodo === "Contratual" && (r.quantidade_real || 0) !== (r.quantidade || 0)) {
				const mais = (r.quantidade || 0) > (r.quantidade_real || 0);
				dif = `<span class="fat-dif" title="${mais ? __("A facturar mais do que os activos") : __("A facturar menos do que os activos")}">${__("activos")} ${r.quantidade_real || 0}</span>`;
			}
			// Per-service customers: billed services, with the guards behind them.
			const qtd = r.adicional ? `${r.quantidade || 0} ${__("un.")}`
				: r.faturar_por === "Serviço"
				? `${r.quantidade || 0} ${__("serv.")} · ${r.vigilantes || 0} ${__("vig.")}`
				: `${r.quantidade || 0} ${__("vig.")}`;
			return `
			<div class="fat-line">
				<span class="fat-reg">${r.linha_unica ? __("Posto") : r.adicional ? __("Adicional") : frappe.utils.escape_html(r.regime || "—")}${!r.linha_unica && r.categoria ? ` <span class="text-muted">· ${frappe.utils.escape_html(r.categoria)}</span>` : ""}${temp}${contr}</span>
				<span class="fat-proj" title="${frappe.utils.escape_html(r.project || "")}">${frappe.utils.escape_html(r.descricao || r.project || "")}</span>
				<span class="fat-q">${qtd}${dif}</span>
				<span class="fat-u">${fmtC(r.valor_unitario)}${r.origem_tarifa === "Cliente"
					? ` <span class="fat-metodo" title="${__("Tarifa por regime do cliente")}">${__("cliente")}</span>` : ""}</span>
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
.fat-line { display: grid; grid-template-columns: 150px 1fr 80px 110px 120px; gap: 8px; align-items: baseline; padding: 3px 0; font-size: .86em; }
.fat-reg { font-weight: 700; color: #f4cd84; }
.fat-temp { margin-left: 6px; padding: 1px 6px; border-radius: 999px; font-size: .82em; font-weight: 700; background: rgba(232,160,32,.22); color: #f4cd84; border: 1px solid rgba(232,160,32,.45); }
.fat-metodo { margin-left: 6px; padding: 1px 6px; border-radius: 999px; font-size: .82em; font-weight: 700; background: rgba(143,182,230,.18); color: #bcd6f2; border: 1px solid rgba(143,182,230,.4); }
.fat-dif { display: block; font-size: .8em; color: #f4a28c; }
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


// Print preview: the customer's invoice built exactly as Gerar Faturas would and
// rendered with the Sales Invoice print format (server rolls it back afterwards).
function _pre_visualizar_impressao(frm) {
	const clientes = [...new Set((frm.doc.linhas || [])
		.filter(l => l.cliente && l.quantidade && l.valor_unitario)
		.map(l => l.cliente))].sort();
	if (!clientes.length) {
		frappe.msgprint(__("Sem linhas facturáveis."));
		return;
	}
	const d = new frappe.ui.Dialog({
		title: __("Pré-visualizar Factura"),
		size: "extra-large",
		fields: [
			{ fieldname: "cliente", fieldtype: "Select", label: __("Cliente"), options: clientes,
				default: clientes[0], change: () => carregar() },
			{ fieldtype: "Section Break" },
			{ fieldname: "folha", fieldtype: "HTML" },
		],
	});
	const $folha = () => d.fields_dict.folha.$wrapper;
	let pedido = 0;
	function carregar() {
		const cliente = d.get_value("cliente");
		if (!cliente) return;
		if (frm.is_dirty()) {
			$folha().html(`<div class="text-muted" style="padding:24px">${__("Guarde o documento primeiro.")}</div>`);
			return;
		}
		const meu = ++pedido;
		$folha().html(`<div class="text-muted" style="padding:24px">${__("A preparar a factura...")}</div>`);
		frm.call("pre_visualizar_impressao", { cliente }).then((r) => {
			if (meu === pedido) sigos.mostrar_previa_fatura($folha(), r.message || {});
		}, () => {
			if (meu === pedido) $folha().html(`<div class="text-danger" style="padding:24px">${__("Não foi possível pré-visualizar.")}</div>`);
		});
	}
	d.show();
	carregar();
}
