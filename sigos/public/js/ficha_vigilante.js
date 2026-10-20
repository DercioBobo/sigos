// Ficha do Vigilante — decision dossier for the Jurista / RH (sigos.disciplinar.dossie).
// sigos.ficha_vigilante.render($wrapper, vigilante, {processo, forcar}) draws it into any
// HTML field; used by Processo Disciplinar (and reusable elsewhere).
frappe.provide("sigos.ficha_vigilante");

(function () {
	const esc = (v) => frappe.utils.escape_html(v == null ? "" : String(v));
	const dt = (d) => (d ? frappe.datetime.str_to_user(String(d).slice(0, 10)) : "—");
	const moeda = (v) => frappe.format(v || 0, { fieldtype: "Currency" });
	const lnk = (doctype, name, txt) => name
		? `<a href="/app/${frappe.router.slug(doctype)}/${encodeURIComponent(name)}">${esc(txt || name)}</a>` : "—";
	const cache = {};

	sigos.ficha_vigilante.render = function ($w, vigilante, opts) {
		opts = opts || {};
		css();
		if (!$w) return;
		if (!vigilante) { $w.html(""); return; }
		const chave = `${vigilante}|${opts.processo || ""}`;
		if (!opts.forcar && cache[chave]) { desenhar($w, cache[chave], vigilante, opts); return; }
		$w.html(`<div class="fv"><div class="fv-loading">${__("A carregar a ficha do vigilante…")}</div></div>`);
		frappe.xcall("sigos.disciplinar.dossie.dossie_vigilante", { vigilante, processo: opts.processo || null })
			.then((d) => {
				if (!d) { $w.html(""); return; }
				cache[chave] = d;
				desenhar($w, d, vigilante, opts);
			})
			.catch(() => $w.html(`<div class="fv"><div class="fv-loading">${__("Sem permissão para ver a ficha.")}</div></div>`));
	};

	function desenhar($w, d, vigilante, opts) {
		const id = d.identificacao || {}, a = d.assiduidade || {}, di = d.disciplinar || {},
			s = d.salario, po = d.posto || {};
		const ant = id.antiguidade;
		const antTxt = ant ? `${ant.anos} ${__("ano(s)")} ${ant.meses} ${__("mês(es)")}` : "—";
		const saldoFerias = (d.ferias || []).reduce((t, f) => t + (f.saldo || 0), 0);

		const kpis = [
			kpi(__("Antiguidade"), antTxt, id.data_admissao ? __("desde {0}", [dt(id.data_admissao)]) : ""),
			kpi(__("Faltas (12 meses)"), a.doze_meses || 0,
				__("{0} este mês · {1} dias c/ falta", [a.mes_atual || 0, a.dias_com_falta_12m || 0]),
				(a.doze_meses || 0) > 0 ? "warn" : ""),
			kpi(__("Participações"), di.total_participacoes || 0,
				__("{0} nos últimos 12 meses", [di.participacoes_12m || 0]), (di.participacoes_12m || 0) > 1 ? "bad" : ""),
			kpi(__("Repreensões"), di.total_repreensoes || 0,
				__("{0} desde o último processo (limite {1})", [di.repreensoes_desde_processo || 0, di.limite_repreensoes || 3]),
				(di.repreensoes_desde_processo || 0) >= (di.limite_repreensoes || 3) ? "bad" : ""),
			kpi(__("Processos Anteriores"), (di.processos_anteriores || []).length, ""),
			kpi(__("Saldo de Férias"), `${(Math.round(saldoFerias * 10) / 10)} ${__("dias")}`,
				(d.ferias || []).map((f) => `${esc(f.leave_type)}: ${f.saldo}`).join(" · ")),
		];
		if (s) {
			kpis.push(kpi(__("Salário Base"), moeda(s.base), s.ssa ? __("desde {0}", [dt(s.ssa.from_date)]) : ""));
			kpis.push(kpi(__("Dívida em Curso"), moeda(s.divida_total), __("empréstimos + deduções"),
				s.divida_total > 0 ? "warn" : ""));
		}

		const sit = (d.situacao || []).map((x) => `<div class="fv-sit fv-sit-${esc(x.tipo)}">
			<b>${esc(x.texto)}</b>${x.detalhe ? ` <span>· ${esc(x.detalhe)}</span>` : ""}
			${x.doc ? ` · ${lnk(x.doctype, x.doc)}` : ""}</div>`).join("");

		const linha = (k, v) => v || v === 0 ? `<div class="fv-kv"><span>${k}</span><b>${v}</b></div>` : "";
		const identificacao = card(__("Identificação"), `
			${linha(__("Estado"), `<span class="fv-st">${esc(id.status)}</span>`)}
			${linha(__("Categoria"), esc(id.categoria))}
			${linha(__("Tipo"), esc(id.tipo_de_vigilante))}
			${linha(__("Delegação"), esc(id.delegacao))}
			${linha(po.anterior ? __("Posto (antes de sair)") : __("Posto"),
				po.posto ? `${po.indicativo ? esc(po.indicativo) + " — " : ""}${esc(po.nome_do_posto || po.posto)}` : "—")}
			${linha(__("Regime"), esc(po.regime))}
			${linha(__("Cliente"), esc(po.cliente))}
			${linha(__("Idade / Sexo"), [id.idade ? `${id.idade} ${__("anos")}` : "", esc(id.sexo)].filter(Boolean).join(" · "))}
			${linha(__("Estado Civil"), esc(id.estado_civil))}
			${linha(__("Dependentes"), esc(id.dependentes))}
			${linha(__("Contacto"), esc(id.contacto))}
			${linha(__("Residência"), esc(id.residencia))}
			${id.numero_documento ? linha(esc(id.documento || __("Documento")), esc(id.numero_documento)) : ""}
			${linha(__("NUIT"), esc(id.nuit))}
			${linha(__("INSS"), esc(id.inss))}`);

		const g = di.por_gravidade || {};
		const disciplinar = card(__("Histórico Disciplinar"), `
			<div class="fv-grav">
				<span class="fv-g fv-g-b">${__("Baixa")} <b>${g["Baixa"] || 0}</b></span>
				<span class="fv-g fv-g-m">${__("Média")} <b>${g["Média"] || 0}</b></span>
				<span class="fv-g fv-g-a">${__("Alta")} <b>${g["Alta"] || 0}</b></span>
			</div>
			${(di.reincidencias || []).length ? `<div class="fv-reinc">${__("Reincidência")}: ${di.reincidencias
				.map((r) => `<b>${esc(r.tipo)}</b> ×${r.vezes}`).join(", ")}</div>` : ""}
			${tabela([__("Data"), __("Infracções"), __("Grav."), __("Processo")],
				(di.participacoes || []).map((p) => [
					lnk("Participacao", p.name, dt(p.data)),
					esc((p.infracoes || []).join(", ")),
					esc(p.gravidade || ""),
					p.processo_disciplinar ? lnk("Processo Disciplinar", p.processo_disciplinar) : "—",
				]), __("Sem participações submetidas."))}
			${(di.repreensoes || []).length ? `<div class="fv-sub">${__("Repreensões")}</div>` + tabela(
				[__("Data"), __("N.º"), __("Infracções"), __("Processo")],
				di.repreensoes.map((r) => [lnk("Repreensao", r.name, dt(r.data)), `${r.numero || "?"}.ª`,
					esc(r.infracoes || ""), r.processo_disciplinar ? lnk("Processo Disciplinar", r.processo_disciplinar) : "—"])) : ""}
			${(di.processos_anteriores || []).length ? `<div class="fv-sub">${__("Processos anteriores")}</div>` + tabela(
				[__("Data"), __("Motivo"), __("Decisão")],
				di.processos_anteriores.map((p) => [lnk("Processo Disciplinar", p.name, dt(p.data)),
					esc(p.motivo || ""), esc(p.decisao || (p.docstatus === 0 ? __("Em curso") : "—"))])) : ""}`);

		const assid = card(__("Assiduidade"), `
			<div class="fv-mini">
				<span>${__("Este mês")} <b>${a.mes_atual || 0}</b></span>
				<span>${__("Mês anterior")} <b>${a.mes_anterior || 0}</b></span>
				<span>${__("3 meses")} <b>${a.tres_meses || 0}</b></span>
				<span>${__("Justificadas 12m")} <b>${a.justificadas_12m || 0}</b></span>
				<span>${__("Dias de baixa 12m")} <b>${a.dias_baixa_12m || 0}</b></span>
			</div>
			${tabela([__("Data"), __("Turno"), __("Faltas"), __("Justificação")],
				(a.recentes || []).map((r) => [lnk("Ausencias", r.ausencia, dt(r.data)), esc(r.turno || ""),
					r.n || 0, esc(r.justificacao || "")]), __("Sem faltas nos últimos 12 meses."))}
			${(a.baixas_12m || []).length ? `<div class="fv-sub">${__("Baixas médicas")}</div>` + tabela(
				[__("Início"), __("Regresso"), __("Dias"), __("Pago por")],
				a.baixas_12m.map((b) => [lnk("Baixa Medica", b.name, dt(b.data_inicio)), dt(b.data_regresso),
					b.dias || "—", esc(b.pago_por || b.estado || "")])) : ""}
			${(a.presuncoes || []).length ? `<div class="fv-sub">${__("Presunções de abandono")}</div>` + tabela(
				[__("Data"), __("Estado"), __("Faltas")],
				a.presuncoes.map((p) => [lnk("Presuncao De Abandono", p.name, dt(p.data_deteccao)), esc(p.estado),
					p.total_faltas || 0])) : ""}`);

		const salario = s ? card(__("Salário e Dívidas"), `
			${linha(__("Salário base"), moeda(s.base))}
			${(s.folhas || []).length ? `<div class="fv-sub">${__("Últimas folhas")}</div>` + tabela(
				[__("Período"), __("Bruto"), __("Descontos"), __("Líquido")],
				s.folhas.map((f) => [lnk("Salary Slip", f.name, `${dt(f.start_date)} – ${dt(f.end_date)}`),
					moeda(f.gross_pay), moeda(f.total_deduction), `<b>${moeda(f.net_pay)}</b>`])) : ""}
			${(s.emprestimos || []).concat(s.deducoes || []).length ? `<div class="fv-sub">${__("Em dívida")}</div>` + tabela(
				[__("Documento"), __("Mensal"), __("Até"), __("Restante")],
				(s.emprestimos || []).map((e) => [lnk("Emprestimo", e.name, __("Empréstimo")), moeda(e.valor_mensal),
					dt(e.data_de_fim), moeda(e.restante)])
					.concat((s.deducoes || []).map((e) => [lnk("Outras Deducoes", e.name, esc(e.tipo || __("Dedução"))),
						moeda(e.valor_mensal), dt(e.data_de_fim), moeda(e.restante)]))) : ""}`) : "";

		const material = card(__("Material em Posse (a devolver)"), tabela(
			[__("Material"), __("Categoria"), __("Qtd."), __("Desde")],
			(d.material || []).map((m) => [lnk("Alocacao De Material", m.alocacao, m.material), esc(m.categoria || ""),
				m.em_posse, dt(m.data)]), __("Nenhum material retornável em posse.")));

		$w.html(`<div class="fv">
			<div class="fv-head">
				<div class="fv-who">
					${id.foto ? `<img class="fv-foto" src="${esc(id.foto)}">` : `<div class="fv-foto fv-ini">${esc(iniciais(id.nome))}</div>`}
					<div><div class="fv-nome">${esc(id.nome || vigilante)}</div>
					<div class="fv-meta">${__("Nº")} ${esc(id.mecanografico || "—")} · ${lnk("Vigilante", vigilante, __("abrir ficha"))}</div></div>
				</div>
				<button class="btn btn-xs btn-default fv-refresh">${__("Actualizar")}</button>
			</div>
			${sit ? `<div class="fv-sits">${sit}</div>` : ""}
			<div class="fv-kpis">${kpis.join("")}</div>
			<div class="fv-grid">${identificacao}${disciplinar}${assid}${salario}${material}</div>
		</div>`);
		$w.find(".fv-refresh").on("click", () =>
			sigos.ficha_vigilante.render($w, vigilante, Object.assign({}, opts, { forcar: true })));
	}

	function iniciais(n) {
		const p = (n || "?").split(/\s+/).filter(Boolean);
		return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
	}
	function kpi(lbl, val, sub, tom) {
		return `<div class="fv-kpi ${tom ? "fv-" + tom : ""}"><div class="fv-kpi-l">${lbl}</div>
			<div class="fv-kpi-v">${val}</div>${sub ? `<div class="fv-kpi-s">${sub}</div>` : ""}</div>`;
	}
	function card(titulo, corpo) {
		return `<section class="fv-card"><h5>${titulo}</h5>${corpo}</section>`;
	}
	function tabela(cols, linhas, vazio) {
		if (!linhas.length) return vazio ? `<div class="fv-empty">${vazio}</div>` : "";
		return `<table class="fv-tb"><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
			<tbody>${linhas.map((l) => `<tr>${l.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
	}

	function css() {
		if (document.getElementById("sigos-fv-css")) return;
		const c = `
.fv { --fv-navy: #1a3a5c; --fv-line: #e3e8ef; --fv-ink: #1f2933; --fv-ink2: #5b6b7c; display: flex; flex-direction: column; gap: 12px; }
.fv-loading, .fv-empty { font-size: 12px; color: var(--fv-ink2); font-style: italic; padding: 6px 0; }
.fv-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-radius: 12px; color: #fff;
	background: linear-gradient(135deg, #234a73, #1a3a5c 55%, #14304c); }
.fv-who { display: flex; gap: 12px; align-items: center; }
.fv-foto { width: 46px; height: 46px; border-radius: 50%; object-fit: cover; border: 2px solid rgba(255, 255, 255, .5); }
.fv-ini { display: flex; align-items: center; justify-content: center; background: rgba(255, 255, 255, .15); font-weight: 700; }
.fv-nome { font-size: 16px; font-weight: 700; letter-spacing: .02em; }
.fv-meta { font-size: 12px; opacity: .85; }
.fv-meta a { color: #fff; text-decoration: underline; }
.fv-sits { display: flex; flex-direction: column; gap: 6px; }
.fv-sit { padding: 8px 12px; border-radius: 9px; font-size: 12.5px; border-left: 4px solid #e8a020; background: #fff8e6; }
.fv-sit span { color: var(--fv-ink2); }
.fv-sit-suspenso, .fv-sit-abandono { border-left-color: #d64545; background: #fff1f1; }
.fv-sit-doente { border-left-color: #2563eb; background: #eef4ff; }
.fv-kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.fv-kpi { border: 1px solid var(--fv-line); border-radius: 10px; padding: 10px 12px; background: #fff; }
.fv-kpi-l { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--fv-ink2); }
.fv-kpi-v { font-size: 19px; font-weight: 700; color: var(--fv-ink); font-variant-numeric: tabular-nums; margin-top: 2px; }
.fv-kpi-s { font-size: 11px; color: var(--fv-ink2); }
.fv-warn { border-color: #f1c27d; background: #fffaf0; }
.fv-bad { border-color: #f3b4b4; background: #fff5f5; }
.fv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.fv-card { border: 1px solid var(--fv-line); border-radius: 12px; padding: 12px 14px; background: #fbfcfe; min-width: 0; }
.fv-card h5 { margin: 0 0 8px; font-size: 12px; font-weight: 700; color: var(--fv-navy); text-transform: uppercase; letter-spacing: .06em; }
.fv-kv { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; padding: 3px 0; border-bottom: 1px dashed var(--fv-line); }
.fv-kv span { color: var(--fv-ink2); }
.fv-kv b { text-align: right; font-weight: 600; }
.fv-st { padding: 1px 8px; border-radius: 999px; background: #e8eef6; font-size: 11.5px; }
.fv-sub { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--fv-ink2); margin: 10px 0 4px; }
.fv-tb { width: 100%; border-collapse: collapse; font-size: 12px; }
.fv-tb th { text-align: left; font-size: 10.5px; text-transform: uppercase; color: var(--fv-ink2); font-weight: 600;
	padding: 4px 6px; border-bottom: 1px solid var(--fv-line); }
.fv-tb td { padding: 5px 6px; border-bottom: 1px solid #f0f3f7; vertical-align: top; }
.fv-grav { display: flex; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
.fv-g { font-size: 11.5px; padding: 2px 10px; border-radius: 999px; }
.fv-g-b { background: #e7f6ee; color: #1f7a4c; } .fv-g-m { background: #fff3dd; color: #8a5a00; } .fv-g-a { background: #fde8e8; color: #a32020; }
.fv-reinc { font-size: 12px; margin: 4px 0 6px; color: #a32020; }
.fv-mini { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; color: var(--fv-ink2); margin-bottom: 6px; }
.fv-mini b { color: var(--fv-ink); }
@media (max-width: 900px) { .fv-grid { grid-template-columns: 1fr; } }`;
		$(`<style id="sigos-fv-css">${c}</style>`).appendTo("head");
	}
})();
