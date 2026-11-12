// SIGOS — contract (Project) helpers.
// "Aplicar Salário Base" pushes the per-regime base salary defined in this
// contract onto every active vigilante's Salary Structure Assignment. Vigilantes
// with a manual override keep it (the resolver prefers the override), so re-running
// is always safe.
frappe.ui.form.on("Project", {
	refresh(frm) {
		if (frm.is_new()) return;

		// Grid-level button, always visible above the Subsídios table (not tucked
		// into the form's own button bar) — the subsídios table only defines the
		// component + valor now; WHO on the project actually receives each one is
		// managed here, in the matrix modal (sigos.project_subsidios). Grid.
		// add_custom_button is itself idempotent (re-shows the same button by
		// label instead of duplicating it), so this is safe to call on every refresh.
		const grid = frm.fields_dict.custom_subsidios && frm.fields_dict.custom_subsidios.grid;
		if (grid) {
			grid.add_custom_button(__("Gerir Subsídios..."), () => {
				sigos.project_subsidios.abrir_matriz(frm);
			}, "top");
		}

		// Billing runs are per customer, so this bills ALL of the customer's contracts.
		frm.add_custom_button(__("Faturar Mês"), () => sigos.faturar_mes(frm.doc.customer), __("SIGOS"));

		frm.add_custom_button(__("Aplicar Salário Base"), () => {
			const d = new frappe.ui.Dialog({
				title: __("Aplicar Salário Base"),
				fields: [
					{
						fieldname: "aviso",
						fieldtype: "HTML",
						options: `<p>${__(
							"Isto vai atribuir o salário base (por regime, definido neste contrato) " +
							"a todos os vigilantes <b>Activos</b> deste contrato, criando/actualizando " +
							"a respectiva Salary Structure Assignment.<br><br>" +
							"Vigilantes com <b>Salário Base (manual)</b> mantêm o valor manual."
						)}</p>`,
					},
					{
						fieldname: "from_date",
						label: __("Data de Efeito"),
						fieldtype: "Date",
						reqd: 1,
						default: frappe.datetime.month_start(),
						description: __(
							"Para quem já tem Salary Structure Assignment (ajuste, não 1ª atribuição). " +
							"Use o 1º dia do mês para que a folha do mês inteiro reflicta o novo valor " +
							"— uma data a meio do mês só se aplica a partir desse dia em diante."
						),
					},
				],
				primary_action_label: __("Aplicar"),
				primary_action(vals) {
					d.hide();
					frappe.call({
						method: "sigos.api.aplicar_salario_base",
						args: { project: frm.doc.name, from_date: vals.from_date },
						freeze: true,
						freeze_message: __("A atribuir salário base…"),
					});
				},
			});
			d.show();
		}, __("SIGOS"));
	},
});

// Faturação por Regime (Finance): keep line totals + Total Mensal Contratado live.
// A row without its own price uses the customer's Tarifas por Regime (loaded once per
// customer). The server (sigos.contrato.project_validate) recomputes the same on save.
function _sigos_carregar_tarifas_cliente(frm) {
	const cliente = frm.doc.customer;
	if (!cliente) { frm._sigos_tarifas_cliente = {}; _sigos_recalcular_faturacao(frm); return; }
	if (frm._sigos_tarifas_de === cliente) return;
	frm._sigos_tarifas_de = cliente;
	frappe.xcall("sigos.contrato.get_tarifas_cliente", { customer: cliente }).then(t => {
		if (frm.doc.customer !== cliente) return;
		frm._sigos_tarifas_cliente = t || {};
		_sigos_recalcular_faturacao(frm);
	});
}

function _sigos_recalcular_faturacao(frm) {
	const do_cliente = frm._sigos_tarifas_cliente || {};
	let total = 0;
	(frm.doc.custom_faturacao_regimes || []).forEach(r => {
		// customer rates are keyed "<regime>|<categoria>"; "<regime>|" = any categoria
		const valor = flt(r.valor) || flt(do_cliente[`${r.regime}|${r.categoria || ""}`])
			|| flt(do_cliente[`${r.regime}|`]) || 0;
		const t = (cint(r.quantidade) || 0) * valor;
		if (r.total !== t) frappe.model.set_value(r.doctype, r.name, "total", t);
		total += t;
	});
	if (frm.fields_dict.custom_total_contratual) frm.set_value("custom_total_contratual", total);
}

frappe.ui.form.on("Project", {
	refresh: _sigos_carregar_tarifas_cliente,
	customer: _sigos_carregar_tarifas_cliente,
	custom_faturacao_regimes_remove: _sigos_recalcular_faturacao,
});

frappe.ui.form.on("Project Faturacao Regime", {
	regime: _sigos_recalcular_faturacao,
	categoria: _sigos_recalcular_faturacao,
	quantidade: _sigos_recalcular_faturacao,
	valor: _sigos_recalcular_faturacao,
});

// ─── Efectivo do contrato + "Distribuir por Posto" ───────────────────────────────
// The strip above Faturação por Regime always shows the contract's active postos and
// guards. On Contratual contracts it also shows how much of the contracted quantity
// is split over postos, and opens the modal that edits the split (hidden table
// custom_distribuicao_postos): a posto x contract-row matrix pre-filled from the
// active guards, so nobody types row by row. Por Posto customers then get one
// invoice line per posto; what is not split stays on one contract line.

const _DPP_CSS = `
.dpp-strip{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:2px 0 10px}
.dpp-chip{display:inline-flex;align-items:baseline;gap:6px;padding:5px 10px;border:1px solid var(--border-color);border-radius:999px;background:var(--fg-color);font-size:12px;color:var(--text-muted)}
.dpp-chip b{font-size:14px;color:var(--text-color);font-variant-numeric:tabular-nums}
.dpp-chip.ok b{color:var(--green-600,#16a34a)}
.dpp-chip.warn b{color:var(--orange-600,#d97706)}
.dpp-chip.bad b{color:var(--red-600,#dc2626)}
.dpp-strip .btn{margin-left:auto}
.dpp-nota{font-size:11.5px;color:var(--text-muted);width:100%}
.dpp-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.dpp-bar input{max-width:240px}
.dpp-bar .dpp-sp{flex:1}
.dpp-wrap{max-height:58vh;overflow:auto;border:1px solid var(--border-color);border-radius:8px}
.dpp-t{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}
.dpp-t th,.dpp-t td{padding:7px 10px;border-bottom:1px solid var(--border-color);background:var(--fg-color);text-align:center}
.dpp-t thead th{position:sticky;top:0;z-index:2;background:var(--subtle-fg,var(--fg-color));font-weight:600}
.dpp-t tfoot td{position:sticky;bottom:0;z-index:2;background:var(--subtle-fg,var(--fg-color));font-weight:600}
.dpp-t th:first-child,.dpp-t td:first-child{text-align:left;position:sticky;left:0;z-index:1;min-width:200px}
.dpp-t thead th:first-child,.dpp-t tfoot td:first-child{z-index:3}
.dpp-sub{display:block;font-weight:400;font-size:11px;color:var(--text-muted)}
.dpp-posto{font-weight:600}
.dpp-tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:4px;font-size:10.5px;background:var(--bg-orange,#fff4e5);color:var(--text-on-orange,#b45309)}
.dpp-step{display:inline-flex;align-items:center;border:1px solid var(--border-color);border-radius:6px;overflow:hidden}
.dpp-step button{border:0;background:transparent;width:24px;height:26px;line-height:1;color:var(--text-muted);cursor:pointer}
.dpp-step button:hover{background:var(--bg-light-gray,#f3f4f6);color:var(--text-color)}
.dpp-step input{width:38px;height:26px;border:0;text-align:center;background:transparent;font-variant-numeric:tabular-nums;-moz-appearance:textfield}
.dpp-step input::-webkit-inner-spin-button{-webkit-appearance:none}
.dpp-step.on{border-color:var(--primary)}
.dpp-hint{display:block;font-size:10.5px;color:var(--text-muted);margin-top:2px}
.dpp-hint.diff{color:var(--orange-600,#d97706)}
.dpp-tot.ok{color:var(--green-600,#16a34a)}
.dpp-tot.warn{color:var(--orange-600,#d97706)}
.dpp-tot.bad{color:var(--red-600,#dc2626)}
`;

function _dpp_css() {
	if (document.getElementById("dpp-css")) return;
	const s = document.createElement("style");
	s.id = "dpp-css";
	s.textContent = _DPP_CSS;
	document.head.appendChild(s);
}

const _dpp_esc = (t) => frappe.utils.escape_html(t == null ? "" : String(t));
const _dpp_chave = (regime, cat) => `${regime}|${cat || ""}`;

// Contract rows that can be split: regime set and a contracted quantity.
function _dpp_colunas(frm) {
	return (frm.doc.custom_faturacao_regimes || [])
		.filter(r => r.regime && cint(r.quantidade) > 0)
		.map(r => ({
			chave: _dpp_chave(r.regime, r.categoria),
			regime: r.regime, categoria: r.categoria || "",
			rotulo: [r.regime, r.categoria].filter(Boolean).join(" · "),
			contratado: cint(r.quantidade),
		}));
}

function _dpp_distribuido(frm) {
	const out = {};
	(frm.doc.custom_distribuicao_postos || []).forEach(r => {
		if (cint(r.quantidade) > 0) out[`${r.posto}::${_dpp_chave(r.regime, r.categoria)}`] = cint(r.quantidade);
	});
	return out;
}

function _dpp_metodo(frm, ef) {
	const m = frm.doc.custom_metodo_faturacao;
	return m && m !== "Predefinido" ? m : (ef && ef.metodo);
}

function _dpp_carregar(frm) {
	const f = frm.get_field("custom_efectivo_contrato");
	if (!f) return;
	if (frm.is_new()) { f.$wrapper.empty(); return; }
	const pedido = (frm._dpp_n = (frm._dpp_n || 0) + 1);
	frappe.xcall("sigos.contrato.efectivo_contrato", { project: frm.doc.name }).then(ef => {
		if (pedido !== frm._dpp_n) return;
		frm._dpp_ef = ef || {};
		_dpp_strip(frm);
	}, () => f.$wrapper.empty());
}

function _dpp_strip(frm) {
	const f = frm.get_field("custom_efectivo_contrato");
	const ef = frm._dpp_ef;
	if (!f || !ef) return;
	_dpp_css();
	const unidade = ef.faturar_por === "Serviço" ? __("serviços") : __("vigilantes");
	const contratual = _dpp_metodo(frm, ef) === "Contratual";
	const cols = _dpp_colunas(frm);
	const contratado = cols.reduce((a, c) => a + c.contratado, 0);
	const dist = Object.values(_dpp_distribuido(frm)).reduce((a, q) => a + q, 0);
	const estado = !dist ? "" : dist === contratado ? "ok" : dist > contratado ? "bad" : "warn";

	let html = `<div class="dpp-strip">
		<span class="dpp-chip"><b>${ef.postos_activos || 0}</b>${__("postos activos")}</span>
		<span class="dpp-chip"><b>${ef.vigilantes_activos || 0}</b>${__("vigilantes activos")}</span>`;
	if (contratual) {
		html += `<span class="dpp-chip"><b>${contratado}</b>${__("{0} contratados", [unidade])}</span>
			<span class="dpp-chip ${estado}"><b>${dist}/${contratado}</b>${__("por posto")}</span>`;
		if (cols.length && ef.pode_editar) {
			html += `<button class="btn btn-xs btn-default dpp-abrir">${__("Distribuir por Posto…")}</button>`;
		}
		if (dist && ef.detalhe === "Por Contrato") {
			html += `<div class="dpp-nota">${__("O perfil do cliente factura por contrato: a distribuição só aparece na factura com detalhe Por Posto.")}</div>`;
		}
	}
	html += `</div>`;
	f.$wrapper.html(html);
	f.$wrapper.find(".dpp-abrir").on("click", () => _dpp_modal(frm));
}

function _dpp_modal(frm) {
	if (frm.is_dirty()) {
		frappe.msgprint(__("Grave o contrato antes de distribuir por posto."));
		return;
	}
	const cols = _dpp_colunas(frm);
	if (!cols.length) {
		frappe.msgprint(__("Indique as quantidades em Faturação por Regime primeiro."));
		return;
	}
	frappe.xcall("sigos.contrato.efectivo_contrato", { project: frm.doc.name }).then(ef => {
		frm._dpp_ef = ef;
		_dpp_mostrar(frm, ef, cols);
	});
}

function _dpp_mostrar(frm, ef, cols) {
	_dpp_css();
	const postos = ef.postos || [];
	const colDe = new Set(cols.map(c => c.chave));
	const unidade = ef.faturar_por === "Serviço" ? __("serviços") : __("vigilantes");
	const valores = _dpp_distribuido(frm);

	// Postos the saved split points at but that are no longer listed still appear,
	// so their quantity stays visible and removable.
	const conhecidos = new Set(postos.map(p => p.name));
	(frm.doc.custom_distribuicao_postos || []).forEach(r => {
		if (r.posto && !conhecidos.has(r.posto)) {
			conhecidos.add(r.posto);
			postos.push({ name: r.posto, nome: r.posto, estado: "Inactivo", vigilantes: 0, partes: [] });
		}
	});

	// What the active guards of each posto would bill, per contract column (a guard's
	// categoria uses its own column, else the regime's column without categoria).
	const sugerido = {};
	postos.forEach(p => (p.partes || []).forEach(x => {
		const k = colDe.has(_dpp_chave(x.regime, x.categoria)) ? _dpp_chave(x.regime, x.categoria)
			: colDe.has(_dpp_chave(x.regime, "")) ? _dpp_chave(x.regime, "") : null;
		if (k) sugerido[`${p.name}::${k}`] = (sugerido[`${p.name}::${k}`] || 0) + cint(x.servicos);
	}));

	const cab = cols.map(c => `<th>${_dpp_esc(c.rotulo)}<span class="dpp-sub">${__("contratado")} ${c.contratado}</span></th>`).join("");
	const linhas = postos.map(p => {
		const tag = p.estado !== "Activo" ? `<span class="dpp-tag">${__("Inactivo")}</span>`
			: p.tipo === "Temporário" ? `<span class="dpp-tag">${__("Temporário")}</span>` : "";
		const cel = cols.map(c => {
			const k = `${p.name}::${c.chave}`;
			const v = valores[k] || 0;
			const s = sugerido[k] || 0;
			return `<td data-k="${_dpp_esc(k)}">
				<span class="dpp-step ${v ? "on" : ""}"><button data-d="-1">-</button><input type="number" min="0" value="${v}"><button data-d="1">+</button></span>
				<span class="dpp-hint ${s !== v ? "diff" : ""}">${__("efectivo")} ${s}</span>
			</td>`;
		}).join("");
		return `<tr data-busca="${_dpp_esc((p.nome + " " + p.name).toLowerCase())}">
			<td><span class="dpp-posto">${_dpp_esc(p.nome)}</span>${tag}<span class="dpp-sub">${__("{0} vigilantes activos", [p.vigilantes || 0])}</span></td>${cel}</tr>`;
	}).join("");
	const rodape = cols.map(c => `<td class="dpp-tot" data-col="${_dpp_esc(c.chave)}"></td>`).join("");

	const d = new frappe.ui.Dialog({
		title: __("Distribuir por Posto"),
		size: "extra-large",
		fields: [{ fieldname: "corpo", fieldtype: "HTML" }],
		primary_action_label: __("Aplicar"),
		primary_action: () => aplicar(),
	});
	const $c = d.get_field("corpo").$wrapper;
	$c.html(`
		<div class="dpp-strip">
			<span class="dpp-chip"><b>${ef.postos_activos || 0}</b>${__("postos activos")}</span>
			<span class="dpp-chip"><b>${ef.vigilantes_activos || 0}</b>${__("vigilantes activos")}</span>
			<span class="dpp-chip dpp-geral"></span>
		</div>
		<div class="dpp-bar">
			<input type="search" class="form-control input-xs dpp-busca" placeholder="${__("Procurar posto…")}">
			<span class="dpp-sp"></span>
			<button class="btn btn-xs btn-default dpp-encher">${__("Preencher com o efectivo")}</button>
			<button class="btn btn-xs btn-default dpp-limpar">${__("Limpar")}</button>
		</div>
		${postos.length ? `<div class="dpp-wrap"><table class="dpp-t">
			<thead><tr><th>${__("Posto")}</th>${cab}</tr></thead>
			<tbody>${linhas}</tbody>
			<tfoot><tr><td>${__("Distribuído")}</td>${rodape}</tr></tfoot>
		</table></div>` : `<div class="text-muted">${__("Este contrato não tem postos activos.")}</div>`}
	`);

	const ler = () => {
		const out = {};
		$c.find("td[data-k]").each(function () {
			const q = cint($(this).find("input").val());
			if (q > 0) out[$(this).attr("data-k")] = q;
		});
		return out;
	};
	// Footer per column + the overall chip; returns true when a column is over.
	const totais = () => {
		const v = ler();
		let tudo = 0, contratado = 0, excede = false;
		cols.forEach(c => {
			const t = Object.entries(v).filter(([k]) => k.endsWith(`::${c.chave}`)).reduce((a, [, q]) => a + q, 0);
			tudo += t; contratado += c.contratado;
			if (t > c.contratado) excede = true;
			const estado = t > c.contratado ? "bad" : t === c.contratado ? "ok" : "warn";
			const txt = t > c.contratado ? __("excede {0}", [t - c.contratado])
				: t < c.contratado ? __("resta {0}", [c.contratado - t]) : __("completo");
			$c.find(".dpp-tot").filter(function () { return $(this).attr("data-col") === c.chave; })
				.attr("class", `dpp-tot ${estado}`)
				.html(`${t}/${c.contratado}<span class="dpp-sub">${txt}</span>`);
		});
		$c.find(".dpp-geral").attr("class", `dpp-chip dpp-geral ${excede ? "bad" : tudo === contratado ? "ok" : "warn"}`)
			.html(`<b>${tudo}/${contratado}</b>${__("{0} por posto", [unidade])}`);
		return excede;
	};
	const definir = ($td, q) => {
		q = Math.max(0, cint(q));
		$td.find("input").val(q);
		$td.find(".dpp-step").toggleClass("on", q > 0);
		$td.find(".dpp-hint").toggleClass("diff", cint(sugerido[$td.attr("data-k")]) !== q);
	};

	$c.on("click", ".dpp-step button", function (e) {
		e.preventDefault();
		const $td = $(this).closest("td");
		definir($td, cint($td.find("input").val()) + cint($(this).attr("data-d")));
		totais();
	});
	$c.on("change", ".dpp-step input", function () { definir($(this).closest("td"), this.value); totais(); });
	$c.on("input", ".dpp-step input", () => totais());
	$c.find(".dpp-busca").on("input", function () {
		const q = (this.value || "").toLowerCase().trim();
		$c.find("tbody tr").each(function () {
			$(this).toggle(!q || ($(this).attr("data-busca") || "").includes(q));
		});
	});
	$c.find(".dpp-encher").on("click", () => {
		$c.find("td[data-k]").each(function () { definir($(this), sugerido[$(this).attr("data-k")] || 0); });
		if (totais()) {
			frappe.show_alert({ message: __("O efectivo excede o contratado: ajuste as colunas a vermelho."), indicator: "orange" });
		}
	});
	$c.find(".dpp-limpar").on("click", () => {
		$c.find("td[data-k]").each(function () { definir($(this), 0); });
		totais();
	});

	function aplicar() {
		if (totais()) {
			frappe.msgprint(__("Há colunas com mais do que o contratado."));
			return;
		}
		const porCol = Object.fromEntries(cols.map(c => [c.chave, c]));
		frm.clear_table("custom_distribuicao_postos");
		Object.entries(ler()).forEach(([k, q]) => {
			const i = k.indexOf("::");
			const c = porCol[k.slice(i + 2)];
			if (!c) return;
			frm.add_child("custom_distribuicao_postos",
				{ posto: k.slice(0, i), regime: c.regime, categoria: c.categoria || null, quantidade: q });
		});
		d.hide();
		frm.save().then(() => _dpp_carregar(frm));
	}

	totais();
	d.show();
}

frappe.ui.form.on("Project", {
	refresh: _dpp_carregar,
	custom_metodo_faturacao: _dpp_strip,
	custom_faturacao_regimes_remove: _dpp_strip,
});

frappe.ui.form.on("Project Faturacao Regime", {
	regime: _dpp_strip,
	categoria: _dpp_strip,
	quantidade: _dpp_strip,
});
