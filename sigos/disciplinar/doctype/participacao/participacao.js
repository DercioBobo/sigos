// Participação — form-as-canvas following the paper form (XSS_OP.FR.006):
// O Participante · O Infractor · Tipo de Infracção (checklist) · Relatório ·
// Testemunhas · Gravidade. The native fields stay (hidden) as the data model;
// the deck mounts real two-way-bound controls (see memory: sigos-ui-pattern).

const _PT_NATIVOS_VISIVEIS = new Set(["sec_deck", "deck_participacao"]);
const _PT_GRAV = ["Baixa", "Média", "Alta"];

frappe.ui.form.on("Participacao", {
	setup(frm) {
		// Table MultiSelect: the query goes on the field itself (it has no grid).
		frm.set_query("infracoes", () => ({ filters: { ativo: 1 } }));
		const sem_demitidos = () => ({ filters: { status: ["!=", "Demitido"] } });
		frm.set_query("vigilante", sem_demitidos);
		frm.set_query("participante", sem_demitidos);
		frm.set_query("vigilante", "tabela_testemunhas", sem_demitidos);
	},

	onload(frm) {
		if (frm.is_new() && !frm.doc.participante_nome) {
			frappe.xcall("sigos.disciplinar.doctype.participacao.participacao.participante_padrao")
				.then((p) => {
					if (!p || frm.doc.participante_nome) return;
					Object.entries(p).forEach(([k, v]) => { if (v) frm.doc[k] = v; });
					frm.refresh_fields();
					_pt_sync(frm);
				});
		}
	},

	refresh(frm) {
		_pt_esconder_nativos(frm);
		_pt_render(frm);
		_botao_processo(frm);
		_pt_suspensao(frm);
		if (!frm.is_new()) {
			frm.add_custom_button(__("Imprimir Participação"), () => frm.print_doc());
		}
	},

	// fetch_from results land after the link is set — refresh the deck then
	nome_do_vigilante: (frm) => _pt_sync(frm),
	mecanografico: (frm) => _pt_sync(frm),
	categoria: (frm) => _pt_sync(frm),
	posto: (frm) => _pt_sync(frm),
	posto_nome: (frm) => _pt_sync(frm),
});

function _pt_esconder_nativos(frm) {
	(frm.meta.fields || []).forEach((df) => {
		if (!_PT_NATIVOS_VISIVEIS.has(df.fieldname)) frm.set_df_property(df.fieldname, "hidden", 1);
	});
}

// ─── Shell ────────────────────────────────────────────────────────────────────

function _pt_render(frm) {
	_pt_css();
	const $w = frm.fields_dict.deck_participacao && frm.fields_dict.deck_participacao.$wrapper;
	if (!$w) return;
	const ro = frm.doc.docstatus !== 0;
	const chave = `${frm.doc.name}|${frm.doc.docstatus}`;
	if (frm._pt_chave === chave && $w.find(".pt-deck").length) {
		_pt_sync(frm);
		return;
	}
	frm._pt_chave = chave;
	frm._pt_ctrl = {};

	$w.html(`
		<div class="pt-deck ${ro ? "pt-ro" : ""}">
			<div class="pt-head">
				<div>
					<div class="pt-kicker">${__("Disciplinar")}</div>
					<div class="pt-title">${__("Participação")}</div>
				</div>
				<div class="pt-head-r" data-pt="head"></div>
			</div>

			<div class="pt-grid2">
				<section class="pt-card">
					<h4><span class="pt-n">1</span>${__("O Participante")}</h4>
					<div class="pt-sub">${__("Quem participa (ex.: o supervisor)")}</div>
					<div data-pt="c-participante"></div>
					<div class="pt-row3">
						<div data-pt="c-participante_numero"></div>
						<div data-pt="c-participante_categoria"></div>
					</div>
					<div data-pt="c-participante_nome"></div>
				</section>
				<section class="pt-card pt-card-infr">
					<h4><span class="pt-n">2</span>${__("O Infractor")}</h4>
					<div class="pt-sub">${__("O vigilante participado")}</div>
					<div data-pt="c-vigilante"></div>
					<div data-pt="infractor"></div>
				</section>
			</div>

			<section class="pt-card">
				<h4><span class="pt-n">3</span>${__("Tipo de Infracção")}
					<span class="pt-hint">${ro ? "" : __("toque para marcar — uma ou mais")}</span></h4>
				<div class="pt-chk" data-pt="checklist"></div>
				<div class="pt-outras" data-pt="c-outras_descricao"></div>
			</section>

			<section class="pt-card">
				<h4><span class="pt-n">4</span>${__("Relatório")}</h4>
				<div class="pt-row3 pt-row3-rel">
					<div data-pt="c-posto"></div>
					<div data-pt="c-horas"></div>
					<div data-pt="c-data"></div>
				</div>
				<div data-pt="c-relato"></div>
				<div class="pt-conhec" data-pt="c-data_conhecimento_infracao"></div>
				<div class="pt-prazo" data-pt="prazo"></div>
				<div class="pt-just" data-pt="c-justificacao_fora_de_prazo"></div>
			</section>

			<section class="pt-card">
				<h4><span class="pt-n">5</span>${__("Do Facto Foram Testemunhas")}</h4>
				<div data-pt="testemunhas"></div>
				${ro ? "" : `<button class="btn btn-xs btn-default pt-add" data-pt="add-test">+ ${__("Adicionar testemunha")}</button>`}
			</section>

			<div class="pt-foot">
				<div class="pt-grav">
					<span class="pt-foot-l">${__("Gravidade")}</span>
					<div data-pt="gravidade"></div>
				</div>
				<div class="pt-meta" data-pt="meta"></div>
			</div>
		</div>`);

	const $ = (k) => $w.find(`[data-pt="${k}"]`);

	// Participante: link fills número/categoria/nome (all three stay editable —
	// the participante may be someone who isn't a Vigilante).
	_pt_ctrl(frm, $("c-participante"), {
		fieldtype: "Link", fieldname: "participante", options: "Vigilante",
		label: __("Vigilante (opcional)"), placeholder: __("Procurar participante…"),
		get_query: () => ({ filters: { status: ["!=", "Demitido"] } }),
	}, (v) => {
		if (!v) return;
		frappe.db.get_value("Vigilante", v, ["mecanografico", "categoria", "nome_completo"]).then((r) => {
			const x = r.message || {};
			frm.set_value({
				participante_numero: x.mecanografico || "",
				participante_categoria: x.categoria || "",
				participante_nome: x.nome_completo || "",
			}).then(() => _pt_sync(frm));
		});
	});
	_pt_ctrl(frm, $("c-participante_numero"), { fieldtype: "Data", fieldname: "participante_numero", label: __("Número") });
	_pt_ctrl(frm, $("c-participante_categoria"), { fieldtype: "Data", fieldname: "participante_categoria", label: __("Categoria") });
	_pt_ctrl(frm, $("c-participante_nome"), { fieldtype: "Data", fieldname: "participante_nome", label: __("Nome"), reqd: 1 });

	_pt_ctrl(frm, $("c-vigilante"), {
		fieldtype: "Link", fieldname: "vigilante", options: "Vigilante", label: __("Vigilante"), reqd: 1,
		placeholder: __("Procurar o vigilante participado…"),
		get_query: () => ({ filters: { status: ["!=", "Demitido"] } }),
	});

	_pt_ctrl(frm, $("c-outras_descricao"), {
		fieldtype: "Data", fieldname: "outras_descricao", label: __("Descreva a infracção (Outras)"),
	});
	_pt_ctrl(frm, $("c-posto"), {
		fieldtype: "Link", fieldname: "posto", options: "Posto De Vigilancia", label: __("Posto"),
	});
	_pt_ctrl(frm, $("c-horas"), { fieldtype: "Time", fieldname: "horas", label: __("Horas") },
		null, (v) => (v ? String(v).slice(0, 5) : v));
	_pt_ctrl(frm, $("c-data"), { fieldtype: "Date", fieldname: "data", label: __("Data"), reqd: 1 });
	_pt_ctrl(frm, $("c-data_conhecimento_infracao"), {
		fieldtype: "Date", fieldname: "data_conhecimento_infracao", label: __("Data de Conhecimento da Infracção"),
		reqd: 1, description: __("Conta o prazo para criar a participação e para abrir o Processo Disciplinar."),
	});
	_pt_ctrl(frm, $("c-justificacao_fora_de_prazo"), {
		fieldtype: "Small Text", fieldname: "justificacao_fora_de_prazo", label: __("Justificação (Fora de Prazo)"),
	});
	frappe.xcall("sigos.disciplinar.prazos.prazos").then((p) => { frm._pt_prazos = p; _pt_prazo(frm); });
	_pt_ctrl(frm, $("c-relato"), {
		fieldtype: "Small Text", fieldname: "relato", label: __("Reportagem"), reqd: 1,
		placeholder: __("O que aconteceu, onde, como foi detectado…"),
	});

	if (!ro) {
		$w.on("click", '[data-pt="add-test"]', () => {
			frm.add_child("tabela_testemunhas", {});
			frm.dirty();
			_pt_testemunhas(frm);
		});
	}

	frm._pt_tipos = frm._pt_tipos || null;
	_pt_carregar_tipos(frm).then(() => _pt_sync(frm));
}

// A real control bound to frm.doc[fieldname] — built once, value pushed on sync.
function _pt_ctrl(frm, $parent, df, depois, transformar) {
	// editavel_submetido: an allow_on_submit field — stays editable on a submitted
	// participação (not cancelled) and is saved straight away ("Update").
	const pos_submit = df.editavel_submetido && frm.doc.docstatus === 1;
	const ro = frm.doc.docstatus !== 0 && !pos_submit;
	const ctrl = frappe.ui.form.make_control({
		df: Object.assign({}, df, {
			read_only: ro ? 1 : 0,
			onchange() {
				let v = ctrl.get_value();
				if (transformar) v = transformar(v);
				if ((v || "") === (frm.doc[df.fieldname] || "")) return;
				frm.set_value(df.fieldname, v || null).then(() => {
					if (depois) depois(v);
					if (pos_submit) {
						frm.save("Update").then(() => frappe.show_alert({ message: __("Guardado."), indicator: "green" }, 3));
					}
					_pt_sync(frm);
				});
			},
		}),
		parent: $parent,
		render_input: true,
	});
	if (df.get_query) ctrl.get_query = df.get_query;
	ctrl.set_value(frm.doc[df.fieldname] || "");
	frm._pt_ctrl[df.fieldname] = ctrl;
	return ctrl;
}

function _pt_carregar_tipos(frm) {
	if (frm._pt_tipos) return Promise.resolve();
	return frappe.db.get_list("Tipo De Infracao", {
		filters: { ativo: 1 },
		fields: ["name", "gravidade_sugerida", "ordem", "pede_descricao"],
		limit_page_length: 0,
	}).then((tipos) => {
		// Paper order (ordem 1..n), then any type without an order, alphabetically.
		frm._pt_tipos = (tipos || []).sort((a, b) => {
			const oa = a.ordem || 9999, ob = b.ordem || 9999;
			return oa - ob || a.name.localeCompare(b.name);
		});
	});
}

// ─── Dynamic regions (re-rendered without touching the mounted inputs) ───────

function _pt_sync(frm) {
	const $w = frm.fields_dict.deck_participacao && frm.fields_dict.deck_participacao.$wrapper;
	if (!$w || !$w.find(".pt-deck").length) return;
	const $ = (k) => $w.find(`[data-pt="${k}"]`);
	const esc = frappe.utils.escape_html;

	// push doc values into controls that aren't being edited
	Object.entries(frm._pt_ctrl || {}).forEach(([f, c]) => {
		const atual = frm.doc[f] || "";
		const focado = c.$input && c.$input.is(":focus");
		if (!focado && (c.get_value() || "") !== atual && !(f === "horas" && String(c.get_value() || "").slice(0, 5) === atual)) {
			c.set_value(atual);
		}
	});

	// header: number + status + date
	const estado = frm.doc.docstatus === 1 ? ["Submetida", "pt-st-ok"]
		: frm.doc.docstatus === 2 ? ["Cancelada", "pt-st-bad"] : ["Rascunho", "pt-st-draft"];
	$("head").html(`
		${frm.is_new() ? "" : `<span class="pt-docname">${esc(frm.doc.name)}</span>`}
		<span class="pt-st ${estado[1]}">${__(estado[0])}</span>`);

	// infractor card
	const ini = (frm.doc.nome_do_vigilante || "?").split(/\s+/).filter(Boolean);
	const sigla = ((ini[0] || "?")[0] + (ini.length > 1 ? ini[ini.length - 1][0] : "")).toUpperCase();
	$("infractor").html(frm.doc.vigilante ? `
		<div class="pt-person">
			<div class="pt-av">${esc(sigla)}</div>
			<div class="pt-person-b">
				<div class="pt-person-n">${esc((frm.doc.nome_do_vigilante || frm.doc.vigilante).toUpperCase())}</div>
				<div class="pt-person-m">
					<span>${__("Nº")} <b>${esc(frm.doc.mecanografico || "—")}</b></span>
					<span>${__("Cat")} <b>${esc(frm.doc.categoria || "—")}</b></span>
					${frm.doc.delegacao ? `<span>${esc(frm.doc.delegacao)}</span>` : ""}
				</div>
			</div>
		</div>` : `<div class="pt-empty">${__("Escolha o vigilante participado.")}</div>`);

	_pt_checklist(frm);
	_pt_testemunhas(frm, true);
	_pt_gravidade(frm);
	_pt_prazo(frm);

	const meta = [];
	if (frm.doc.registado_por) meta.push(__("Registado por {0}", [esc(frm.doc.registado_por)]));
	if (frm.doc.ocorrencia_referente) {
		meta.push(`<a href="/app/ocorrencia/${encodeURIComponent(frm.doc.ocorrencia_referente)}">${__("Ocorrência {0}", [esc(frm.doc.ocorrencia_referente)])}</a>`);
	}
	$("meta").html(meta.join(" · "));
}

// Deadline chip under the Data de Conhecimento: days left to create the participação
// (draft) / to open the Processo (submitted); the manager-only justification input
// shows once a deadline has passed.
function _pt_prazo(frm) {
	const $w = frm.fields_dict.deck_participacao.$wrapper;
	const $c = $w.find('[data-pt="prazo"]');
	const $j = $w.find('[data-pt="c-justificacao_fora_de_prazo"]');
	const p = frm._pt_prazos;
	const dc = frm.doc.data_conhecimento_infracao;
	if (!p || !dc || frm.doc.docstatus === 2) { $c.html(""); $j.toggle(!!frm.doc.justificacao_fora_de_prazo); return; }
	const submetida = frm.doc.docstatus === 1;
	if (submetida && (frm.doc.processo_disciplinar || frm.doc.repreensao)) {
		$c.html(""); $j.toggle(!!frm.doc.justificacao_fora_de_prazo); return;
	}
	const prazo = submetida ? p.processo : p.participacao;
	const ref = frm.doc.creation && !submetida ? frm.doc.creation.slice(0, 10) : frappe.datetime.get_today();
	const dias = frappe.datetime.get_diff(ref, dc);
	const restam = prazo - dias;
	const limite = frappe.datetime.str_to_user(frappe.datetime.add_days(dc, prazo));
	const o_que = submetida ? __("abrir o Processo Disciplinar") : __("criar a participação");
	const txt = restam < 0
		? __("Prazo para {0} expirou a {1} ({2} dias).", [o_que, limite, prazo])
		: __("Prazo para {0}: até {1} — faltam {2} dia(s).", [o_que, limite, restam]);
	$c.html(`<span class="pt-prazo-chip ${restam < 0 ? "exp" : restam <= 3 ? "perto" : ""}">${txt}</span>`);
	$j.toggle(!!frm.doc.justificacao_fora_de_prazo || (restam < 0 && !submetida && p.pode_forcar));
}

function _pt_checklist(frm) {
	const $w = frm.fields_dict.deck_participacao.$wrapper;
	const $c = $w.find('[data-pt="checklist"]');
	const tipos = frm._pt_tipos;
	if (!tipos) { $c.html(`<div class="pt-empty">${__("A carregar…")}</div>`); return; }
	const ro = frm.doc.docstatus !== 0;
	const marcadas = (frm.doc.infracoes || []).map((r) => r.tipo_de_infracao);
	// marked types that are no longer active still show (old records)
	const todos = tipos.concat(marcadas.filter((m) => !tipos.some((t) => t.name === m))
		.map((m) => ({ name: m, gravidade_sugerida: "", inactivo: 1 })));
	const esc = frappe.utils.escape_html;

	$c.html(todos.map((t) => {
		const on = marcadas.includes(t.name);
		const g = (t.gravidade_sugerida || "").normalize("NFD").replace(/[^A-Za-z]/g, "").toLowerCase();
		return `<button type="button" class="pt-chip ${on ? "on" : ""}" data-tipo="${esc(t.name)}" ${ro ? "disabled" : ""}
			title="${t.gravidade_sugerida ? esc(__("Gravidade sugerida: {0}", [t.gravidade_sugerida])) : ""}">
			<span class="pt-box">${on ? "&#10003;" : ""}</span>
			<span class="pt-chip-t">${esc(t.name)}</span>
			${g ? `<span class="pt-dot pt-g-${g}"></span>` : ""}
		</button>`;
	}).join(""));

	// "Outras"-type: show the description input only when such a type is marked
	const pede = todos.some((t) => t.pede_descricao && marcadas.includes(t.name));
	$w.find('[data-pt="c-outras_descricao"]').toggle(pede || !!frm.doc.outras_descricao);

	if (ro) return;
	$c.off("click").on("click", ".pt-chip", function () {
		const tipo = $(this).attr("data-tipo");
		const linhas = frm.doc.infracoes || [];
		if (linhas.some((r) => r.tipo_de_infracao === tipo)) {
			frm.doc.infracoes = linhas.filter((r) => r.tipo_de_infracao !== tipo);
			frm.doc.infracoes.forEach((r, i) => { r.idx = i + 1; });
		} else {
			frm.add_child("infracoes", { tipo_de_infracao: tipo });
		}
		frm.refresh_field("infracoes");
		frm.dirty();
		_pt_gravidade_auto(frm);
		_pt_checklist(frm);
	});
}

// Gravidade follows the most serious marked type until the user picks one by hand.
function _pt_gravidade_auto(frm) {
	if (frm._pt_grav_manual || frm.doc.docstatus !== 0) return;
	const marcadas = (frm.doc.infracoes || []).map((r) => r.tipo_de_infracao);
	let melhor = null;
	(frm._pt_tipos || []).forEach((t) => {
		if (!marcadas.includes(t.name)) return;
		const i = _PT_GRAV.indexOf(t.gravidade_sugerida);
		if (i >= 0 && (melhor === null || i > melhor)) melhor = i;
	});
	if (melhor !== null && frm.doc.gravidade !== _PT_GRAV[melhor]) {
		frm.set_value("gravidade", _PT_GRAV[melhor]).then(() => _pt_gravidade(frm));
	}
}

function _pt_gravidade(frm) {
	const $c = frm.fields_dict.deck_participacao.$wrapper.find('[data-pt="gravidade"]');
	const ro = frm.doc.docstatus !== 0;
	$c.html(`<div class="pt-seg">${_PT_GRAV.map((g, i) => `
		<button type="button" class="pt-seg-b pt-sg-${i} ${frm.doc.gravidade === g ? "on" : ""}" data-g="${g}" ${ro ? "disabled" : ""}>${__(g)}</button>`).join("")}
	</div>`);
	if (ro) return;
	$c.off("click").on("click", ".pt-seg-b", function () {
		frm._pt_grav_manual = true;
		frm.set_value("gravidade", $(this).attr("data-g")).then(() => _pt_gravidade(frm));
	});
}

// Witness rows: optional Vigilante link (fills the row) + número/categoria/nome.
// Rebuilt only when rows are added/removed or a link fills a row — typing in the
// plain inputs writes straight to the child row (no re-render, focus kept).
function _pt_testemunhas(frm, so_se_mudou) {
	const $w = frm.fields_dict.deck_participacao.$wrapper;
	const $c = $w.find('[data-pt="testemunhas"]');
	const linhas = frm.doc.tabela_testemunhas || [];
	const assinatura = linhas.map((r) => `${r.name}:${r.vigilante || ""}`).join("|") + `|${frm.doc.docstatus}`;
	if (so_se_mudou && $c.attr("data-sig") === assinatura) return;
	$c.attr("data-sig", assinatura);
	const ro = frm.doc.docstatus !== 0;
	const esc = frappe.utils.escape_html;

	if (!linhas.length) {
		const legado = frm.doc.testemunhas
			? `<div class="pt-legado">${esc(frm.doc.testemunhas)}</div>` : "";
		$c.html(legado || `<div class="pt-empty">${__("Sem testemunhas.")}</div>`);
		return;
	}
	$c.html(linhas.map((r, i) => `
		<div class="pt-test" data-row="${esc(r.name)}">
			<span class="pt-test-i">${i + 1}</span>
			<div class="pt-test-link"></div>
			<input class="form-control input-xs" data-f="numero" placeholder="${__("Número")}" value="${esc(r.numero || "")}" ${ro ? "disabled" : ""}>
			<input class="form-control input-xs" data-f="categoria" placeholder="${__("Categoria")}" value="${esc(r.categoria || "")}" ${ro ? "disabled" : ""}>
			<input class="form-control input-xs pt-test-nome" data-f="nome" placeholder="${__("Nome")}" value="${esc(r.nome || "")}" ${ro ? "disabled" : ""}>
			${ro ? "" : `<button type="button" class="btn btn-xs btn-default pt-test-x" title="${__("Remover")}">&times;</button>`}
		</div>`).join(""));

	linhas.forEach((r) => {
		const $row = $c.find(`[data-row="${CSS.escape(r.name)}"]`);
		const ctrl = frappe.ui.form.make_control({
			df: {
				fieldtype: "Link", fieldname: "vig_test", options: "Vigilante", placeholder: __("Vigilante (opcional)"),
				read_only: ro ? 1 : 0,
				onchange() {
					const v = ctrl.get_value();
					if ((v || "") === (r.vigilante || "")) return;
					frappe.model.set_value(r.doctype, r.name, "vigilante", v || null);
					if (!v) return;
					frappe.db.get_value("Vigilante", v, ["mecanografico", "categoria", "nome_completo"]).then((res) => {
						const x = res.message || {};
						frappe.model.set_value(r.doctype, r.name, {
							numero: x.mecanografico || "", categoria: x.categoria || "", nome: x.nome_completo || "",
						});
						_pt_testemunhas(frm);
					});
				},
			},
			parent: $row.find(".pt-test-link"),
			render_input: true,
		});
		ctrl.get_query = () => ({ filters: { status: ["!=", "Demitido"] } });
		ctrl.set_value(r.vigilante || "");
	});

	if (ro) return;
	$c.off("change input").on("change input", "input[data-f]", function () {
		const nome = $(this).closest(".pt-test").attr("data-row");
		const row = (frm.doc.tabela_testemunhas || []).find((x) => x.name === nome);
		if (!row) return;
		row[$(this).attr("data-f")] = $(this).val();
		frm.dirty();
	});
	$c.off("click").on("click", ".pt-test-x", function () {
		const nome = $(this).closest(".pt-test").attr("data-row");
		frm.doc.tabela_testemunhas = (frm.doc.tabela_testemunhas || []).filter((x) => x.name !== nome);
		frm.doc.tabela_testemunhas.forEach((x, i) => { x.idx = i + 1; });
		frm.refresh_field("tabela_testemunhas");
		frm.dirty();
		_pt_testemunhas(frm);
	});
}

// ─── Suspensão Preventiva (sigos/suspensao.py) ────────────────────────────────
// On a submitted participação CCO can take the guard off the posto right away
// while the Jurista works the process; pay is chosen per case.
const _PT_PAPEIS_SUSP = ["Aprovador Operações", "Operações SIGOS", "Jurista", "SIGOS Manager", "System Manager"];

function _pt_suspensao(frm) {
	if (frm.doc.docstatus !== 1) return;
	const fmt = (d) => frappe.datetime.str_to_user(d);
	if (frm.doc.suspensao_desde) {
		const ativa = !frm.doc.suspensao_ate;
		frm.dashboard.add_comment(ativa
			? __("<b>Suspenso preventivamente</b> desde {0} · {1}.",
				[fmt(frm.doc.suspensao_desde), frappe.utils.escape_html(frm.doc.suspensao_remuneracao || "")])
			: __("Suspensão preventiva de {0} a {1} ({2}) — {3}.",
				[fmt(frm.doc.suspensao_desde), fmt(frm.doc.suspensao_ate),
				 frappe.utils.escape_html(frm.doc.suspensao_remuneracao || ""),
				 frappe.utils.escape_html(frm.doc.suspensao_destino || "")]),
			ativa ? "red" : "blue", true);
		return;
	}
	if (!_PT_PAPEIS_SUSP.some((r) => frappe.user.has_role(r))) return;
	frappe.db.get_value("Vigilante", frm.doc.vigilante, "status").then((r) => {
		const st = r.message && r.message.status;
		if (!["Activo", "Reserva"].includes(st)) return;
		frm.add_custom_button(__("Suspender Preventivamente"), () => {
			const d = new frappe.ui.Dialog({
				title: __("Suspensão Preventiva"),
				fields: [
					{ fieldtype: "HTML", options: `<p class="text-muted" style="margin-bottom:8px">${__(
						"O vigilante sai já do posto até à decisão do processo.")}</p>` },
					{ fieldname: "remuneracao", fieldtype: "Select", label: __("Remuneração durante a suspensão"), reqd: 1,
						options: ["", "Pago Normalmente", "Salário Congelado", "Não Pago"].join("\n"),
						description: __("Congelado: decide-se no regresso se o período é pago.") },
					{ fieldname: "data_inicio", fieldtype: "Date", label: __("Suspenso desde"), reqd: 1,
						default: frappe.datetime.get_today() },
					{ fieldname: "motivo", fieldtype: "Small Text", label: __("Motivo / Notas") },
				],
				primary_action_label: __("Suspender"),
				primary_action(v) {
					if (v.data_inicio > frappe.datetime.get_today()) { frappe.msgprint(__("A data não pode ser no futuro.")); return; }
					d.hide();
					frm.call("suspender_preventivamente", {
						remuneracao: v.remuneracao, data_inicio: v.data_inicio, motivo: v.motivo || null,
					}).then(() => frm.reload_doc());
				},
			});
			d.show();
		}, __("Acções"));
	});
}

// Before opening a Processo: in time → go; late → managers justify, others are told why.
function _pt_com_prazo(frm, continuar) {
	frappe.xcall("sigos.disciplinar.prazos.prazo_processo_da_participacao", { participacao: frm.doc.name })
		.then((e) => {
			if (!e || !e.expirado) { continuar(null); return; }
			const msg = __("O prazo para abrir o Processo Disciplinar ({0} dias após {1}) expirou a {2}.",
				[e.prazo, frappe.datetime.str_to_user(e.conhecimento), frappe.datetime.str_to_user(e.limite)]);
			if (!e.pode_forcar) {
				frappe.msgprint({ title: __("Prazo Expirado"), indicator: "red",
					message: msg + "<br>" + __("Só um gestor (SIGOS Manager) pode avançar, com justificação.") });
				return;
			}
			frappe.prompt(
				[
					{ fieldtype: "HTML", options: `<p class="text-danger">${msg}</p>` },
					{ fieldname: "just", fieldtype: "Small Text", label: __("Justificação (Fora de Prazo)"), reqd: 1 },
				],
				(v) => continuar(v.just), __("Avançar Fora de Prazo"), __("Avançar"),
			);
		});
}

// ─── Processo Disciplinar (unchanged behaviour) ───────────────────────────────

// On a submitted participação: "Ver Processo Disciplinar" for anyone who can read it,
// "Abrir Processo Disciplinar" only for whoever can create one (the Jurista, RH,
// managers) — CCO files the participação, the Jurista takes it from there.
function _botao_processo(frm) {
	if (frm.doc.docstatus !== 1) return;
	const abrir_pd = (nome) => frappe.set_route("Form", "Processo Disciplinar", nome);

	if (frm.doc.repreensao) {
		frm.add_custom_button(__("Ver Repreensão"), () => frappe.set_route("Form", "Repreensao", frm.doc.repreensao));
	}
	if (frm.doc.processo_disciplinar) {
		frm.add_custom_button(__("Ver Processo Disciplinar"), () => abrir_pd(frm.doc.processo_disciplinar));
		return;
	}
	// The Jurista's two outcomes: a light Repreensão (record only) or a Processo.
	if (!frm.doc.repreensao && frappe.model.can_create("Repreensao")) {
		frm.add_custom_button(__("Registar Repreensão"), () => {
			frappe.prompt(
				[
					{ fieldtype: "HTML", options: `<p class="text-muted">${__("Fica no histórico do vigilante, sem efeito no posto nem no salário.")}</p>` },
					{ fieldname: "observacoes", fieldtype: "Small Text", label: __("Observações do Jurista") },
				],
				(v) => frm.call("registar_repreensao", { observacoes: v.observacoes || null }).then((r) => {
					const x = r.message || {};
					frappe.show_alert({ message: __("Repreensão {0} registada ({1}.ª).", [x.name, x.numero]), indicator: "orange" }, 6);
					if (x.propor_processo) {
						frappe.confirm(
							__("Esta é a <b>{0}.ª repreensão</b> deste vigilante (limite: {1}). Abrir um Processo Disciplinar?", [x.numero, x.limite]),
							() => _pt_com_prazo(frm, (just) => frappe.xcall(
								"sigos.disciplinar.doctype.repreensao.repreensao.abrir_processo_da_repreensao",
								{ repreensao: x.name, justificacao_fora_de_prazo: just })
								.then((pd) => { if (pd) abrir_pd(pd); else frm.reload_doc(); })),
							() => frm.reload_doc(),
						);
					} else {
						frm.reload_doc();
					}
				}),
				__("Registar Repreensão"), __("Registar"),
			);
		}, __("Jurista"));
	}
	if (!frappe.model.can_create("Processo Disciplinar")) {
		if (!frm.doc.repreensao) {
			frm.dashboard.set_headline_alert(__("Submetida — aguarda o <b>Jurista</b> (repreensão ou processo disciplinar)."), "blue");
		}
		return;
	}
	if (!frm.doc.repreensao) frm.dashboard.set_headline_alert(__("Aguarda decisão: repreensão ou processo disciplinar."), "orange");
	frm.add_custom_button(__("Abrir Processo Disciplinar"), () => {
		_pt_com_prazo(frm, (just) => frappe.confirm(
			__("Abrir um Processo Disciplinar para <b>{0}</b> a partir desta participação?",
				[frappe.utils.escape_html(frm.doc.nome_do_vigilante || frm.doc.vigilante)]),
			() => frm.call("criar_processo_disciplinar", { justificacao_fora_de_prazo: just }).then((res) => {
				if (res.message) abrir_pd(res.message);
			}),
		));
	}, __("Jurista"));
}

// ─── Styles (ASCII-only, self-injected) ───────────────────────────────────────

function _pt_css() {
	if (document.getElementById("sigos-pt-css")) return;
	const css = `
.pt-deck { --pt-navy: #1a3a5c; --pt-amber: #e8a020; --pt-red: #d64545; --pt-line: #e3e8ef;
	--pt-ink: #1f2933; --pt-ink2: #5b6b7c; --pt-paper: #fbfcfe; display: flex; flex-direction: column; gap: 14px; }
.pt-head { display: flex; justify-content: space-between; align-items: center; padding: 18px 22px;
	border-radius: 14px; color: #fff; background: linear-gradient(135deg, #234a73, #1a3a5c 55%, #14304c);
	box-shadow: 0 6px 18px rgba(20, 48, 76, .18); }
.pt-kicker { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; opacity: .7; }
.pt-title { font-family: var(--sigos-display, "Barlow Semi Condensed", sans-serif); font-size: 26px; font-weight: 700;
	letter-spacing: .06em; text-transform: uppercase; line-height: 1.1; }
.pt-head-r { display: flex; gap: 8px; align-items: center; }
.pt-docname { font-variant-numeric: tabular-nums; font-weight: 600; opacity: .9; }
.pt-st { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px; text-transform: uppercase; letter-spacing: .05em; }
.pt-st-draft { background: rgba(255, 255, 255, .16); color: #fff; }
.pt-st-ok { background: #2fa56a; color: #fff; }
.pt-st-bad { background: #e05c5c; color: #fff; }
.pt-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.pt-card { background: var(--pt-paper); border: 1px solid var(--pt-line); border-radius: 12px; padding: 14px 16px 10px; }
.pt-card h4 { margin: 0 0 2px; font-size: 13px; font-weight: 700; color: var(--pt-navy); text-transform: uppercase;
	letter-spacing: .06em; display: flex; align-items: center; gap: 8px; }
.pt-n { display: inline-flex; width: 20px; height: 20px; border-radius: 50%; background: var(--pt-navy); color: #fff;
	font-size: 11px; align-items: center; justify-content: center; }
.pt-hint { margin-left: auto; font-size: 11px; font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--pt-ink2); }
.pt-sub { font-size: 11.5px; color: var(--pt-ink2); margin: 0 0 6px 28px; }
.pt-row3 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.pt-row3-rel { grid-template-columns: 2fr 1fr 1fr; }
.pt-card .frappe-control { margin-bottom: 6px; }
.pt-card-infr { border-left: 4px solid var(--pt-red); }
.pt-person { display: flex; gap: 12px; align-items: center; padding: 8px 10px; border-radius: 10px; background: #fff;
	border: 1px dashed var(--pt-line); margin-bottom: 6px; }
.pt-av { width: 42px; height: 42px; border-radius: 50%; background: #fde8e8; color: var(--pt-red); font-weight: 700;
	display: flex; align-items: center; justify-content: center; font-size: 15px; flex: none; }
.pt-person-n { font-weight: 700; color: var(--pt-ink); letter-spacing: .02em; }
.pt-person-m { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--pt-ink2); }
.pt-person-m b { color: var(--pt-ink); font-variant-numeric: tabular-nums; }
.pt-empty { font-size: 12px; color: var(--pt-ink2); font-style: italic; padding: 6px 0; }
.pt-chk { display: grid; grid-template-columns: repeat(auto-fill, minmax(215px, 1fr)); gap: 6px; margin-top: 8px; }
.pt-chip { display: flex; align-items: center; gap: 8px; text-align: left; padding: 7px 10px; border-radius: 9px;
	border: 1px solid var(--pt-line); background: #fff; color: var(--pt-ink); font-size: 12.5px; cursor: pointer;
	transition: border-color .12s, background .12s, box-shadow .12s; }
.pt-chip:hover:not([disabled]) { border-color: #9fb3c8; box-shadow: 0 2px 6px rgba(26, 58, 92, .08); }
.pt-chip[disabled] { cursor: default; }
.pt-chip.on { border-color: var(--pt-red); background: #fff4f4; font-weight: 600; }
.pt-box { width: 17px; height: 17px; border-radius: 4px; border: 1.5px solid #9fb3c8; flex: none; display: inline-flex;
	align-items: center; justify-content: center; font-size: 12px; color: #fff; }
.pt-chip.on .pt-box { background: var(--pt-red); border-color: var(--pt-red); }
.pt-chip-t { flex: 1; text-transform: uppercase; letter-spacing: .02em; font-size: 11.5px; }
.pt-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.pt-g-baixa { background: #2fa56a; } .pt-g-media { background: var(--pt-amber); } .pt-g-alta { background: var(--pt-red); }
.pt-outras { margin-top: 8px; max-width: 520px; }
.pt-conhec { max-width: 320px; margin-top: 4px; padding: 6px 10px; border-left: 3px solid var(--pt-amber); background: #fffaf0; border-radius: 6px; }
.pt-prazo { margin: 4px 0; }
.pt-prazo-chip { display: inline-block; font-size: 12px; padding: 3px 10px; border-radius: 999px; background: #e7f6ee; color: #1f7a4c; }
.pt-prazo-chip.perto { background: #fff3dd; color: #8a5a00; }
.pt-prazo-chip.exp { background: #fde8e8; color: #a32020; font-weight: 600; }
.pt-just { max-width: 520px; }
.pt-test { display: grid; grid-template-columns: 22px 1.6fr 1fr 1fr 2fr 28px; gap: 6px; align-items: center; margin-bottom: 6px; }
.pt-ro .pt-test { grid-template-columns: 22px 1.6fr 1fr 1fr 2fr; }
.pt-test-i { font-size: 11px; color: var(--pt-ink2); text-align: center; font-variant-numeric: tabular-nums; }
.pt-test .frappe-control, .pt-test .form-group, .pt-test .control-input-wrapper,
.pt-test .control-input, .pt-test .link-field { margin: 0 !important; padding: 0; }
.pt-test .control-label, .pt-test .help-box, .pt-test .control-value { display: none; }
.pt-test .form-control { height: 30px; min-height: 30px; padding: 4px 8px; font-size: 13px; line-height: 20px; }
.pt-ro .pt-test .control-value { display: block; height: 30px; line-height: 30px; padding: 0 8px; margin: 0; }
.pt-add { margin-top: 2px; }
.pt-legado { white-space: pre-wrap; font-size: 12.5px; padding: 6px 8px; background: #fff; border: 1px dashed var(--pt-line); border-radius: 8px; }
.pt-foot { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;
	padding: 12px 16px; border-radius: 12px; border: 1px solid var(--pt-line); background: #fff; }
.pt-grav { display: flex; align-items: center; gap: 12px; }
.pt-foot-l { font-size: 12px; font-weight: 700; color: var(--pt-navy); text-transform: uppercase; letter-spacing: .06em; }
.pt-seg { display: inline-flex; border: 1px solid var(--pt-line); border-radius: 9px; overflow: hidden; }
.pt-seg-b { border: none; background: #fff; padding: 6px 16px; font-size: 12.5px; color: var(--pt-ink2); cursor: pointer; }
.pt-seg-b + .pt-seg-b { border-left: 1px solid var(--pt-line); }
.pt-seg-b[disabled] { cursor: default; }
.pt-seg-b.on.pt-sg-0 { background: #2fa56a; color: #fff; }
.pt-seg-b.on.pt-sg-1 { background: var(--pt-amber); color: #fff; }
.pt-seg-b.on.pt-sg-2 { background: var(--pt-red); color: #fff; }
.pt-meta { font-size: 12px; color: var(--pt-ink2); }
@media (max-width: 768px) {
	.pt-grid2, .pt-row3, .pt-row3-rel { grid-template-columns: 1fr; }
	.pt-test, .pt-ro .pt-test { grid-template-columns: 22px 1fr 1fr; }
	.pt-test-link, .pt-test-nome { grid-column: span 2; }
	.pt-head { padding: 14px 16px; }
	.pt-title { font-size: 21px; }
}`;
	$(`<style id="sigos-pt-css">${css}</style>`).appendTo("head");
}
