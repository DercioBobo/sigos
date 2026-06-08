// SIGOS — Rotatividade wizard (operational command console, v2)
frappe.provide("sigos");

sigos.rotatividade_wizard = function (prefill = {}) {
	const S = {
		step: 0, dir: 1,
		operacoes: [], op: null, flags: {},
		vig: null,
		novo_posto: null, novo_regime: null, nova_categoria: null,
		motivo: "", motiv_demi: "", uniforme: "", motivo_3meses: "",
		sub: null,
	};
	const controls = {};

	const d = new frappe.ui.Dialog({
		title: __("Rotatividade"),
		size: "large",
		fields: [{ fieldname: "body", fieldtype: "HTML" }],
		primary_action_label: __("Próximo →"),
		primary_action: () => _advance(),
	});
	d.$wrapper.addClass("sigos-rotw sigos-rotw2");
	const $body = () => d.fields_dict.body.$wrapper;

	const STEP_LABELS = {
		ident: __("Operação & Vigilante"), mudancas: __("Mudanças"),
		substituto: __("Substituto"), preview: __("Confirmação"),
	};
	function _steps() {
		return ["ident", "mudancas", "substituto", "preview"]
			.filter((s) => s !== "substituto" || S.flags.requer_substituto);
	}

	// ── boot: load operations ──
	frappe.call({
		method: "frappe.client.get_list",
		args: {
			doctype: "Operacao De Rotatividade",
			filters: { activo: 1 },
			fields: ["name", "abreviatura", "operacao", "muda_posto", "muda_regime",
				"muda_categoria", "requer_substituto", "demite", "descricao"],
			order_by: "abreviatura", limit_page_length: 0,
		},
		callback: (r) => { S.operacoes = r.message || []; _render(); },
	});
	d.show();

	// ── navigation ──
	function _advance() {
		const steps = _steps();
		const key = steps[S.step];
		if (!_validate(key)) return;
		if (S.step >= steps.length - 1) { _confirm(); return; }
		S.dir = 1; S.step += 1; _render();
	}
	function _back() {
		if (S.step === 0) { d.hide(); return; }
		S.dir = -1; S.step -= 1; _render();
	}
	function _validate(key) {
		if (key === "ident") {
			if (!S.op) { _toast(__("Escolha uma operação.")); return false; }
			if (!S.vig) { _toast(__("Escolha um vigilante.")); return false; }
		}
		if (key === "mudancas") {
			if (S.flags.muda_posto && !S.novo_posto) { _toast(__("Indique o novo posto.")); return false; }
			if (S.flags.muda_regime && !S.novo_regime) { _toast(__("Indique o novo regime.")); return false; }
			if (S.flags.muda_categoria && !S.nova_categoria) { _toast(__("Indique a nova categoria.")); return false; }
		}
		return true;
	}
	function _toast(m) { frappe.show_alert({ message: m, indicator: "orange" }, 3); }

	// ── render ──
	function _render() {
		const steps = _steps();
		const key = steps[S.step];
		const stepper = steps.map((s, i) => {
			const st = i < S.step ? "done" : (i === S.step ? "active" : "todo");
			return `<div class="rotw-node ${st}"><span class="rotw-dot">${i < S.step ? "✓" : i + 1}</span>
				<span class="rotw-nlabel">${STEP_LABELS[s]}</span></div>`;
		}).join('<span class="rotw-conn"></span>');

		const opName = S.op ? `${S.op.abreviatura} · ${S.op.operacao}` : __("Nova Rotatividade");

		let content = "";
		if (key === "ident") content = _stepIdent();
		else if (key === "mudancas") content = _stepMudancas();
		else if (key === "substituto") content = _stepSubstituto();
		else if (key === "preview") content = `<div id="rotw-prev"></div>`;

		$body().html(`
			<div class="rotw-head">
				<div class="rotw-op">${frappe.utils.escape_html(opName)}</div>
				<div class="rotw-stepper">${stepper}</div>
			</div>
			<div class="rotw-step rotw-slide-${S.dir > 0 ? "next" : "prev"}">${content}</div>`);

		// post-mount wiring per step
		if (key === "ident") _wireIdent();
		else if (key === "mudancas") _wireMudancas();
		else if (key === "substituto") _wireSubstituto();
		else if (key === "preview") _renderPreview();

		_footer(steps);
	}

	function _footer(steps) {
		const last = S.step >= steps.length - 1;
		const $btn = d.get_primary_btn();
		$btn.html(last ? `${__("Confirmar Rotatividade")} ✓` : `${__("Próximo")} →`);
		$btn.toggleClass("rotw-confirm", last);
		$btn.prop("disabled", false);
		let $back = d.$wrapper.find(".rotw-back");
		if (!$back.length) { $back = $(`<button class="btn rotw-back"></button>`); $btn.before($back); $back.on("click", _back); }
		$back.html(S.step === 0 ? __("Cancelar") : `← ${__("Anterior")}`);
	}

	// ════════ STEP 1 — Operação + Vigilante ════════
	function _stepIdent() {
		return `
			<div class="rotw-sec-num">1 · ${__("Que operação?")}</div>
			<div class="rotw2-cards">${_opCards()}</div>
			<div class="rotw-sec-num" style="margin-top:18px">2 · ${__("Qual vigilante?")}</div>
			<div class="rotw2-search">
				<span class="rotw2-search-ic">🔍</span>
				<input type="text" class="rotw2-search-in" id="rotw-vsearch"
					placeholder="${__("Procurar por nome ou mecanográfico…")}" autocomplete="off">
			</div>
			<div class="rotw2-results" id="rotw-vresults"></div>
			<div id="rotw-vchosen">${S.vig ? _guardChosen(S.vig) : ""}</div>`;
	}
	function _opCards() {
		if (!S.operacoes.length) return `<div class="rotw-none">${__("Sem operações configuradas.")}</div>`;
		return S.operacoes.map((o) => {
			const p = [];
			if (o.muda_posto) p.push(`<span class="rotw2-pic" title="${__("Muda posto")}">📍 ${__("Posto")}</span>`);
			if (o.muda_regime) p.push(`<span class="rotw2-pic" title="${__("Muda regime")}">🕘 ${__("Regime")}</span>`);
			if (o.muda_categoria) p.push(`<span class="rotw2-pic" title="${__("Muda categoria")}">🏷️ ${__("Categoria")}</span>`);
			if (o.requer_substituto) p.push(`<span class="rotw2-pic" title="${__("Substituto")}">⇄ ${__("Substituto")}</span>`);
			if (o.demite) p.push(`<span class="rotw2-pic rotw2-pic-dem" title="${__("Demissão")}">⚑ ${__("Demite")}</span>`);
			const sel = S.op && S.op.name === o.name ? "sel" : "";
			return `<div class="rotw2-card ${sel}" data-op="${o.name}">
				<div class="rotw2-card-top">
					<span class="rotw2-abrev">${frappe.utils.escape_html(o.abreviatura)}</span>
					${sel ? '<span class="rotw2-check">✓</span>' : ""}
				</div>
				<div class="rotw2-card-name">${frappe.utils.escape_html(o.operacao)}</div>
				<div class="rotw2-card-picto">${p.join("") || `<span class="rotw2-noop">${__("sem alterações directas")}</span>`}</div>
			</div>`;
		}).join("");
	}
	function _wireIdent() {
		$body().find(".rotw2-card").on("click", function () {
			const name = $(this).attr("data-op");
			S.op = S.operacoes.find((o) => o.name === name);
			S.flags = {
				muda_posto: !!S.op.muda_posto, muda_regime: !!S.op.muda_regime,
				muda_categoria: !!S.op.muda_categoria, requer_substituto: !!S.op.requer_substituto,
				demite: !!S.op.demite,
			};
			$body().find(".rotw2-card").removeClass("sel").find(".rotw2-check").remove();
			$(this).addClass("sel").find(".rotw2-card-top").append('<span class="rotw2-check">✓</span>');
			$body().find(".rotw-op").text(`${S.op.abreviatura} · ${S.op.operacao}`);
		});

		const $in = $body().find("#rotw-vsearch");
		const $res = $body().find("#rotw-vresults");
		let t = null;
		$in.on("input", function () {
			const txt = this.value;
			clearTimeout(t);
			t = setTimeout(() => _searchGuards(txt, $res, 0, (v) => _chooseGuard(v)), 220);
		});
		if (S.vig) $in.val(S.vig.nome_completo || S.vig.name);
	}
	function _chooseGuard(v) {
		S.vig = v;
		$body().find("#rotw-vresults").html("");
		$body().find("#rotw-vchosen").html(_guardChosen(v));
		$body().find("#rotw-vsearch").val(v.nome_completo || v.name);
	}

	// ════════ STEP 2 — Mudanças ════════
	function _stepMudancas() {
		const rows = [];
		if (S.flags.muda_posto) rows.push(_changeRow("Posto", S.vig.posto, "novo_posto"));
		if (S.flags.muda_regime) rows.push(_changeRow("Regime", S.vig.regime, "novo_regime"));
		if (S.flags.muda_categoria) rows.push(_changeRow("Categoria", S.vig.categoria, "nova_categoria"));
		const demite = S.flags.demite || S.motivo === "Demissão";

		return `
			<div class="rotw-sec-num">${__("O que muda para")} <b>${frappe.utils.escape_html(S.vig.nome_completo || S.vig.name)}</b></div>
			<div class="rotw2-changes">${rows.join("") || `<div class="rotw-none">${__("Esta operação não altera posto, regime ou categoria directamente.")}</div>`}</div>
			<div class="rotw2-field"><label>${__("Motivo")}</label><div id="ctrl-motivo"></div></div>
			<div id="rotw-demfields" style="${demite ? "" : "display:none"}">
				<div class="rotw2-field"><label>${__("Motivo de Demissão")}</label><div id="ctrl-motiv_demi"></div></div>
				<div class="rotw2-field"><label>${__("Uniforme")}</label><div id="ctrl-uniforme"></div></div>
			</div>
			<div class="rotw2-field"><label>${__("Justificação (se antes do mínimo de dias)")}</label><div id="ctrl-motivo_3meses"></div></div>`;
	}
	function _changeRow(label, from, fieldname) {
		return `<div class="rotw2-change-row">
			<div class="rotw2-cr-label">${label}</div>
			<div class="rotw2-cr-from">${from ? frappe.utils.escape_html(from) : "—"}</div>
			<div class="rotw2-cr-arrow">→</div>
			<div class="rotw2-cr-to" id="ctrl-${fieldname}"></div>
		</div>`;
	}
	function _wireMudancas() {
		if (S.flags.muda_posto) _mountLink("novo_posto", "Posto De Vigilancia",
			() => ({ filters: { delegacao: S.vig.delegacao, estado: "Activo" } }));
		if (S.flags.muda_regime) _mountLink("novo_regime", "Regime", null);
		if (S.flags.muda_categoria) _mountLink("nova_categoria", "Categoria Vigilante", null);

		_mountSelect("motivo", "\nTransferência\nReserva\nDemissão\nDisciplinar\nOutro", () => {
			const demite = S.flags.demite || S.motivo === "Demissão";
			$body().find("#rotw-demfields").toggle(!!demite);
		});
		_mountSelect("motiv_demi", "\nFim de Contrato\nAbandono\nJusta Causa\nAcordo Mútuo\nOutro");
		_mountSelect("uniforme", "\nEntregue\nNão Entregue");
		_mountSmallText("motivo_3meses");
	}

	// ════════ STEP 3 — Substituto ════════
	function _stepSubstituto() {
		return `
			<div class="rotw-sec-num">${__("Quem assume o posto deixado vago?")}</div>
			<div class="rotw2-hint">${__("Posto a cobrir")}: <b>${frappe.utils.escape_html(S.vig.posto || "—")}</b> · ${__("apenas reservas elegíveis")}</div>
			<div class="rotw2-search">
				<span class="rotw2-search-ic">🔍</span>
				<input type="text" class="rotw2-search-in" id="rotw-ssearch" placeholder="${__("Procurar substituto…")}" autocomplete="off">
			</div>
			<div class="rotw2-results" id="rotw-sresults"></div>
			<div id="rotw-schosen">${S.sub ? _guardChosen(S.sub, true) : ""}</div>
			<div class="rotw2-skip">${__("Opcional — pode avançar sem substituto.")}</div>`;
	}
	function _wireSubstituto() {
		const $in = $body().find("#rotw-ssearch");
		const $res = $body().find("#rotw-sresults");
		let t = null;
		$in.on("input", function () {
			const txt = this.value; clearTimeout(t);
			t = setTimeout(() => _searchGuards(txt, $res, 1, (v) => {
				S.sub = v;
				$res.html(""); $body().find("#rotw-schosen").html(_guardChosen(v, true));
				$in.val(v.nome_completo || v.name);
			}), 220);
		});
		if (S.sub) $in.val(S.sub.nome_completo || S.sub.name);
	}

	// ── shared: guard search + result rows + chosen card ──
	function _searchGuards(txt, $res, soSub, onPick) {
		frappe.call({
			method: "sigos.api.search_vigilantes_rich",
			args: { txt, delegacao: S.vig ? S.vig.delegacao : null,
				excluir: S.vig ? S.vig.name : null, so_substitutos: soSub },
			callback: (r) => {
				const list = r.message || [];
				if (!list.length) { $res.html(`<div class="rotw2-nores">${__("Nenhum vigilante encontrado.")}</div>`); return; }
				$res.html(list.map((v) => _guardRow(v)).join(""));
				$res.find(".rotw2-grow").on("click", function () {
					onPick(list.find((x) => x.name === $(this).attr("data-v")));
				});
			},
		});
	}
	function _initials(name) {
		const p = (name || "?").trim().split(/\s+/);
		return ((p[0]?.[0] || "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
	}
	function _guardRow(v) {
		const meta = [v.posto, v.regime, v.categoria].filter(Boolean).join(" · ");
		return `<div class="rotw2-grow" data-v="${v.name}">
			<span class="rotw2-av">${_initials(v.nome_completo)}</span>
			<span class="rotw2-ginfo"><span class="rotw2-gname">${frappe.utils.escape_html(v.nome_completo || v.name)}</span>
			<span class="rotw2-gmeta">${frappe.utils.escape_html(meta || v.name)}</span></span>
		</div>`;
	}
	function _guardChosen(v, isSub) {
		const meta = [v.posto, v.regime, v.categoria].filter(Boolean).join(" · ");
		return `<div class="rotw2-chosen ${isSub ? "sub" : ""}">
			<span class="rotw2-av big">${_initials(v.nome_completo)}</span>
			<span class="rotw2-ginfo">
				<span class="rotw2-gname">${frappe.utils.escape_html(v.nome_completo || v.name)}</span>
				<span class="rotw2-gmeta">${v.mecanografico ? frappe.utils.escape_html(v.mecanografico) + " · " : ""}${frappe.utils.escape_html(meta || "")}</span>
			</span>
			<span class="rotw2-chosen-tag">${isSub ? __("Substituto") : __("Seleccionado")}</span>
		</div>`;
	}

	// ── control mounting ──
	function _mountLink(fieldname, options, get_query) {
		const ctrl = frappe.ui.form.make_control({
			df: { fieldtype: "Link", options, fieldname, placeholder: __("Seleccionar…"), get_query,
				onchange: () => { S[fieldname] = ctrl.get_value(); } },
			parent: $body().find(`#ctrl-${fieldname}`), render_input: true,
		});
		if (S[fieldname]) ctrl.set_value(S[fieldname]);
		controls[fieldname] = ctrl;
	}
	function _mountSelect(fieldname, options, onchange) {
		const ctrl = frappe.ui.form.make_control({
			df: { fieldtype: "Select", options, fieldname,
				onchange: () => { S[fieldname] = ctrl.get_value(); onchange && onchange(); } },
			parent: $body().find(`#ctrl-${fieldname}`), render_input: true,
		});
		if (S[fieldname]) ctrl.set_value(S[fieldname]);
		controls[fieldname] = ctrl;
	}
	function _mountSmallText(fieldname) {
		const ctrl = frappe.ui.form.make_control({
			df: { fieldtype: "Small Text", fieldname, onchange: () => { S[fieldname] = ctrl.get_value(); } },
			parent: $body().find(`#ctrl-${fieldname}`), render_input: true,
		});
		if (S[fieldname]) ctrl.set_value(S[fieldname]);
		controls[fieldname] = ctrl;
	}

	// ════════ STEP 4 — Preview ════════
	function _renderPreview() {
		const $w = $body().find("#rotw-prev");
		$w.html(`<div class="rotw-prev-loading">${__("A calcular efeitos…")}</div>`);
		frappe.call({
			method: "sigos.api.preview_rotatividade",
			args: {
				vigilante: S.vig.name, abreviatura_op: S.op.name,
				novo_posto: S.novo_posto, novo_regime: S.novo_regime, nova_categoria: S.nova_categoria,
				novo_vigilante: S.sub ? S.sub.name : null, motivo: S.motivo, motivo_3meses: S.motivo_3meses,
			},
			callback: (r) => $w.html(_previewHtml(r.message || {})),
		});
	}
	function _previewHtml(p) {
		const chips = (p.mudancas || []).map((m) => `
			<div class="rotw-change"><span class="rotw-cfield">${frappe.utils.escape_html(m.campo)}</span>
				<span class="rotw-cflow"><span class="rotw-cfrom">${frappe.utils.escape_html(m.de || "—")}</span>
				<span class="rotw-carrow">→</span><span class="rotw-cto">${frappe.utils.escape_html(m.para || "—")}</span></span></div>`
		).join("") || `<div class="rotw-none">${__("Sem alterações directas ao vigilante.")}</div>`;

		let escala = "";
		if (p.escala) {
			const sai = p.escala.sai ? `<span class="rotw-esc-out">${p.escala.sai}</span>` : `<span class="rotw-none-inline">${__("nenhuma")}</span>`;
			const entra = p.escala.entra
				? `<span class="rotw-esc-in">${p.escala.entra}${p.escala.entra_criada ? ` <em>(${__("será criada")})</em>` : ""}</span>`
				: (p.demite ? `<span class="rotw-none-inline">${__("removido de serviço")}</span>` : `<span class="rotw-none-inline">—</span>`);
			escala = `<div class="rotw-block"><div class="rotw-block-h">${__("Escala")}</div>
				<div class="rotw-esc-flow">${__("Sai de")} ${sai} <span class="rotw-carrow">→</span> ${__("Entra em")} ${entra}</div></div>`;
		}
		const occ = (p.ocupacao || []).map((o) => {
			const up = o.para > o.de, dn = o.para < o.de;
			return `<div class="rotw-occ"><span class="rotw-occ-posto">${frappe.utils.escape_html(o.posto)}</span>
				<span class="rotw-occ-num">${o.de} <span class="rotw-carrow">→</span>
				<b class="${up ? "occ-up" : dn ? "occ-dn" : ""}">${o.para}</b></span></div>`;
		}).join("");
		const occB = occ ? `<div class="rotw-block"><div class="rotw-block-h">${__("Ocupação")}</div>${occ}</div>` : "";
		const sub = p.substituto ? `<div class="rotw-block"><div class="rotw-block-h">${__("Substituto")}</div>
			<div class="rotw-sub">${frappe.utils.escape_html(p.substituto.nome)} ${__("assume")} <b>${frappe.utils.escape_html(p.substituto.assume_posto || "—")}</b></div></div>` : "";
		const dem = p.demite ? `<div class="rotw-warn rotw-warn-dem">⚑ ${__("Demissão automática será criada.")}</div>` : "";
		const warns = (p.avisos || []).map((w) => `<div class="rotw-warn">⚠️ ${frappe.utils.escape_html(w)}</div>`).join("");

		return `<div class="rotw-preview">
			<div class="rotw-prev-head"><div class="rotw-prev-vig">${frappe.utils.escape_html(p.nome || "")}</div>
				<div class="rotw-prev-op">${frappe.utils.escape_html(p.operacao || "")}</div></div>
			<div class="rotw-block"><div class="rotw-block-h">${__("Alterações")}</div>${chips}</div>
			${escala}${occB}${sub}${dem}${warns}</div>`;
	}

	// ── confirm ──
	function _confirm() {
		const doc = {
			doctype: "Rotatividade", data: frappe.datetime.get_today(),
			vigilante: S.vig.name, abreviatura_op: S.op.name,
			delegacao: S.vig.delegacao, mecanografico: S.vig.mecanografico,
			regime: S.vig.regime, categoria_vigilante: S.vig.categoria,
			novo_posto: S.novo_posto, novo_regime: S.novo_regime, nova_categoria: S.nova_categoria,
			novo_vigilante: S.sub ? S.sub.name : null, alocado_ao_posto: S.vig.posto,
			alocar_vigilante_substituto: S.sub ? "Sim" : "Não",
			motivo: S.motivo, motiv_demi: S.motiv_demi, uniforme: S.uniforme, motivo_3meses: S.motivo_3meses,
		};
		d.get_primary_btn().prop("disabled", true);
		frappe.call({
			method: "frappe.client.insert", args: { doc }, freeze: true, freeze_message: __("A criar…"),
			callback: (r) => frappe.call({
				method: "frappe.client.submit", args: { doc: r.message }, freeze: true, freeze_message: __("A aplicar…"),
				callback: () => { d.hide(); frappe.show_alert({ message: __("Rotatividade {0} aplicada.", [r.message.name]), indicator: "green" }, 5); frappe.set_route("Form", "Rotatividade", r.message.name); },
				error: () => frappe.set_route("Form", "Rotatividade", r.message.name),
			}),
			error: () => d.get_primary_btn().prop("disabled", false),
		});
	}

	// prefill guard
	if (prefill.vigilante) {
		frappe.db.get_doc("Vigilante", prefill.vigilante).then((v) => {
			S.vig = { name: v.name, nome_completo: v.nome_completo, posto: v.posto_de_vigilancia,
				regime: v.regime_do_vigilante, categoria: v.categoria, delegacao: v.delegacao,
				mecanografico: v.mecanografico };
			if (_steps()[S.step] === "ident") _render();
		});
	}
};
