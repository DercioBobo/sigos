// SIGOS - Rotatividade wizard (operational command console, v2)
frappe.provide("sigos");

// Self-inject the wizard styles so they're guaranteed present even if the bundled
// sigos.css drops/mangles them on the server. Runs once.
(function injectRotwStyles() {
	if (document.getElementById("sigos-rotw-css")) return;
	const css = `
@keyframes sigos-fade-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.sigos-rotw .modal-dialog { max-width: 760px; }
.sigos-rotw .modal-header { border-bottom: none; padding-bottom: 0; }
.sigos-rotw .modal-body { padding-top: 8px; }
.rotw-head { background: linear-gradient(135deg,#1a3a5c 0%,#11283f 100%); margin: -4px -16px 18px; padding: 16px 20px 18px; border-radius: 10px; color: #fff; position: relative; overflow: hidden; }
.rotw-head::after { content: ""; position: absolute; inset: 0; background: radial-gradient(circle at 90% -20%, rgba(232,160,32,.18), transparent 55%); pointer-events: none; }
.rotw-op { font-family: var(--sigos-display, system-ui); font-size: 1.15em; font-weight: 700; letter-spacing: .02em; margin-bottom: 14px; position: relative; }
.rotw-stepper { display: flex; align-items: center; gap: 6px; }
.rotw-node { display: flex; align-items: center; gap: 8px; opacity: .5; transition: opacity .25s; }
.rotw-node.active, .rotw-node.done { opacity: 1; }
.rotw-dot { width: 26px; height: 26px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-family: var(--sigos-display, system-ui); font-weight: 700; font-size: .9em; background: rgba(255,255,255,.15); color: #fff; border: 1.5px solid rgba(255,255,255,.3); transition: all .25s; }
.rotw-node.active .rotw-dot { background: #e8a020; border-color: #e8a020; color: #1a3a5c; box-shadow: 0 0 0 4px rgba(232,160,32,.25); }
.rotw-node.done .rotw-dot { background: #2fa56a; border-color: #2fa56a; }
.rotw-nlabel { font-size: .78em; font-weight: 600; letter-spacing: .02em; white-space: nowrap; }
.rotw-node.todo .rotw-nlabel { display: none; }
.rotw-conn { flex: 1; height: 2px; background: rgba(255,255,255,.18); border-radius: 2px; min-width: 12px; }
.rotw-state { margin-top: 14px; border: 1px solid #e4e8ec; border-radius: 12px; overflow: hidden; background: linear-gradient(180deg,#fbfcfd,#f4f6f8); animation: sigos-fade-up .3s ease both; }
.rotw-state-title { background: #f2f5f8; padding: 7px 14px; font-size: .72em; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--sigos-primary,#1a3a5c); border-bottom: 1px solid #e8ebed; font-family: var(--sigos-display, system-ui); }
.rotw-state-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #eef1f4; }
.rotw-scell { background: #fff; padding: 10px 14px; display: flex; flex-direction: column; gap: 2px; }
.rotw-slabel { font-size: .68em; text-transform: uppercase; letter-spacing: .04em; color: #9aa2aa; font-weight: 600; }
.rotw-sval { font-size: .95em; font-weight: 600; color: #2c3e50; }
.rotw-prev-loading { text-align: center; color: #888; padding: 40px; font-size: .9em; }
.rotw-preview { animation: sigos-fade-up .3s ease both; }
.rotw-prev-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 0 2px 12px; border-bottom: 2px solid #eef1f4; margin-bottom: 14px; }
.rotw-prev-vig { font-family: var(--sigos-display, system-ui); font-size: 1.4em; font-weight: 700; color: var(--sigos-primary,#1a3a5c); }
.rotw-prev-op { font-size: .82em; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #8a949e; }
.rotw-block { margin-bottom: 14px; }
.rotw-block-h { font-size: .7em; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #9aa2aa; margin-bottom: 7px; font-family: var(--sigos-display, system-ui); }
.rotw-change { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border: 1px solid #e8ebed; border-radius: 8px; margin-bottom: 6px; background: #fff; }
.rotw-cfield { font-size: .8em; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: #6c757d; }
.rotw-cflow { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.rotw-cfrom { color: #9aa2aa; }
.rotw-cto { color: var(--sigos-primary,#1a3a5c); font-weight: 700; }
.rotw-carrow { color: #e8a020; font-weight: 700; }
.rotw-esc-flow { padding: 9px 12px; background: #f8f9fb; border-radius: 8px; font-size: .9em; font-weight: 500; }
.rotw-esc-out { color: #c0392b; font-weight: 700; }
.rotw-esc-in { color: #198754; font-weight: 700; }
.rotw-esc-in em { color: #b8860b; font-weight: 600; font-style: italic; }
.rotw-none-inline { color: #9aa2aa; font-style: italic; }
.rotw-occ { display: flex; align-items: center; justify-content: space-between; padding: 7px 12px; border-bottom: 1px solid #f0f1f3; }
.rotw-occ-posto { font-weight: 600; color: #2c3e50; font-size: .9em; }
.rotw-occ-num { font-family: var(--sigos-display, system-ui); font-weight: 600; font-variant-numeric: tabular-nums; color: #6c757d; }
.rotw-occ-num b.occ-up { color: #198754; }
.rotw-occ-num b.occ-dn { color: #c0392b; }
.rotw-sub { padding: 9px 12px; background: #eaf2fb; border-radius: 8px; font-size: .9em; }
.rotw-sub b { color: var(--sigos-primary,#1a3a5c); }
.rotw-warn { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding: 9px 13px; border-radius: 8px; font-size: .85em; font-weight: 500; background: #fff8e6; border: 1px solid #ffe08a; color: #8a6d1a; }
.rotw-warn-dem { background: #fdecef; border-color: #f5b5bb; color: #b02a37; }
.rotw-none { color: #9aa2aa; font-size: .88em; font-style: italic; }
.sigos-rotw .modal-footer { border-top: 1px solid #eef1f4; }
.sigos-rotw .rotw-back { border: 1px solid #d0d7de; background: #fff; color: #6c757d; font-weight: 600; border-radius: 8px; margin-right: auto; }
.sigos-rotw .rotw-back:hover { background: #f0f3f6; }
.sigos-rotw .btn-primary { border-radius: 8px; font-weight: 600; }
.sigos-rotw .btn-primary.rotw-confirm { background: linear-gradient(180deg,#2fa56a,#1f8a55); border-color: #1f8a55; box-shadow: 0 2px 8px rgba(31,138,85,.3); }
.rotw-step { animation: rotw-slide-in .28s cubic-bezier(.2,.7,.3,1) both; }
.rotw-slide-next { --rotw-x: 22px; }
.rotw-slide-prev { --rotw-x: -22px; }
@keyframes rotw-slide-in { from { opacity: 0; transform: translateX(var(--rotw-x, 18px)); } to { opacity: 1; transform: none; } }
.rotw-sec-num { font-family: var(--sigos-display, system-ui); font-size: .8em; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #9aa2aa; margin: 4px 0 10px; }
.rotw-sec-num b { color: var(--sigos-primary,#1a3a5c); }
.rotw2-cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.rotw2-card { border: 1.5px solid #e4e8ec; border-radius: 12px; padding: 12px 14px; cursor: pointer; background: linear-gradient(180deg,#fff,#fbfcfd); transition: all .15s cubic-bezier(.2,.7,.3,1); box-shadow: 0 1px 2px rgba(0,0,0,.04); }
.rotw2-card:hover { border-color: #4a90d9; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(74,144,217,.16); }
.rotw2-card.sel { border-color: #1a3a5c; background: linear-gradient(180deg,#eef4fb,#e3eefa); box-shadow: inset 0 0 0 1.5px #1a3a5c, 0 4px 12px rgba(26,58,92,.15); }
.rotw2-card-top { display: flex; align-items: center; justify-content: space-between; }
.rotw2-abrev { font-family: var(--sigos-display, system-ui); font-weight: 700; font-size: 1.3em; letter-spacing: .04em; color: var(--sigos-primary,#1a3a5c); }
.rotw2-check { width: 20px; height: 20px; border-radius: 50%; background: #1a3a5c; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: .75em; font-weight: 700; }
.rotw2-card-name { font-weight: 600; font-size: .92em; color: #2c3e50; margin: 3px 0 8px; }
.rotw2-card-picto { display: flex; flex-wrap: wrap; gap: 5px; }
.rotw2-pic { font-size: .68em; font-weight: 600; padding: 2px 8px; border-radius: 10px; background: #eef1f4; color: #5a636c; }
.rotw2-pic-dem { background: #fdecef; color: #b02a37; }
.rotw2-noop { font-size: .72em; font-style: italic; color: #b6bcc2; }
.rotw2-search { display: flex; align-items: center; gap: 8px; border: 1.5px solid #e4e8ec; border-radius: 10px; padding: 0 12px; background: #fff; transition: border-color .15s; }
.rotw2-search:focus-within { border-color: #4a90d9; box-shadow: 0 0 0 3px rgba(74,144,217,.12); }
.rotw2-search-ic { opacity: .5; }
.rotw2-search-in { border: none; outline: none; flex: 1; padding: 11px 0; font-size: .95em; background: transparent; }
.rotw2-results { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; max-height: 230px; overflow-y: auto; }
.rotw2-grow { display: flex; align-items: center; gap: 11px; padding: 8px 11px; border-radius: 9px; cursor: pointer; border: 1px solid transparent; transition: all .12s; }
.rotw2-grow:hover { background: #f0f6fd; border-color: #cfe0f5; }
.rotw2-av { width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; font-family: var(--sigos-display, system-ui); font-weight: 700; font-size: .85em; background: linear-gradient(135deg,#234a73,#1a3a5c); color: #fff; }
.rotw2-av.big { width: 44px; height: 44px; font-size: 1em; }
.rotw2-ginfo { display: flex; flex-direction: column; min-width: 0; }
.rotw2-gname { font-weight: 600; font-size: .92em; color: #2c3e50; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rotw2-gmeta { font-size: .76em; color: #8a949e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rotw2-nores, .rotw2-skip, .rotw2-hint { font-size: .82em; color: #9aa2aa; padding: 8px 2px; }
.rotw2-hint b { color: var(--sigos-primary,#1a3a5c); }
.rotw2-skip { font-style: italic; text-align: center; margin-top: 6px; }
.rotw2-chosen { display: flex; align-items: center; gap: 12px; margin-top: 10px; padding: 12px 14px; border-radius: 12px; background: linear-gradient(180deg,#eef4fb,#e3eefa); border: 1.5px solid #1a3a5c; animation: sigos-fade-up .26s ease both; }
.rotw2-chosen.sub { background: linear-gradient(180deg,#eafaf1,#d9f2e3); border-color: #1f8a55; }
.rotw2-chosen .rotw2-av { background: linear-gradient(135deg,#234a73,#1a3a5c); }
.rotw2-chosen.sub .rotw2-av { background: linear-gradient(135deg,#2fa56a,#1f8a55); }
.rotw2-chosen-tag { margin-left: auto; font-size: .68em; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 3px 10px; border-radius: 10px; background: rgba(26,58,92,.12); color: #1a3a5c; }
.rotw2-chosen.sub .rotw2-chosen-tag { background: rgba(31,138,85,.15); color: #1f8a55; }
.rotw2-changes { margin-bottom: 10px; }
.rotw2-change-row { display: grid; grid-template-columns: 90px 1fr auto 1.4fr; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid #f0f1f3; }
.rotw2-cr-label { font-size: .72em; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: #6c757d; }
.rotw2-cr-from { font-weight: 600; color: #9aa2aa; }
.rotw2-cr-arrow { color: #e8a020; font-weight: 700; }
.rotw2-field { margin: 10px 0; }
.rotw2-field > label { display: block; font-size: .78em; font-weight: 600; color: #6c757d; margin-bottom: 4px; }
.sigos-rotw2 .rotw2-cr-to .control-input, .sigos-rotw2 .rotw2-field .control-input { margin: 0; }
.sigos-rotw2 .frappe-control { margin: 0 !important; }
.sigos-rotw2 .control-label { display: none; }
.rotw-footer { display: flex; align-items: center; gap: 10px; margin-top: 18px; padding-top: 14px; border-top: 1px solid #eef1f4; }
.rotw-foot-btn { padding: 9px 22px; border-radius: 8px; font-weight: 600; font-size: .95em; cursor: pointer; transition: all .14s cubic-bezier(.2,.7,.3,1); border: 1px solid #d0d7de; font-family: var(--sigos-display, system-ui); }
.rotw-back { background: #fff; color: #6c757d; margin-right: auto; }
.rotw-back:hover { background: #f0f3f6; }
.rotw-next { background: linear-gradient(180deg,#234a73,#1a3a5c); border-color: #1a3a5c; color: #fff; box-shadow: 0 2px 8px rgba(26,58,92,.22); }
.rotw-next:hover { box-shadow: 0 4px 12px rgba(26,58,92,.3); transform: translateY(-1px); }
.rotw-next.rotw-confirm { background: linear-gradient(180deg,#2fa56a,#1f8a55); border-color: #1f8a55; box-shadow: 0 2px 8px rgba(31,138,85,.28); }
.rotw-next:disabled { opacity: .6; cursor: not-allowed; transform: none; }
/* inline (form) mode: hide the native field area, show only the wizard canvas */
.rotw-form-mode .form-tabs-list, .rotw-form-mode .std-row-buttons { display: none !important; }
.rotw-inline { max-width: 820px; margin: 0 auto; }
.rotw-summary { max-width: 720px; margin: 8px auto 0; }
.rotw2-confirm { margin-top: 16px; padding-top: 14px; border-top: 1px dashed #e0e5ea; }
.rotw2-confirm-row { display: flex; gap: 16px; flex-wrap: wrap; }
.rotw2-confirm-row .rotw2-field { flex: 1; min-width: 160px; }
.rotw2-req::after { content: " *"; color: #e05c5c; font-weight: 700; }
`;
	const s = document.createElement("style");
	s.id = "sigos-rotw-css";
	s.textContent = css;
	document.head.appendChild(s);
})();

// ════════ Engine: renders the wizard into any container ($mount) ════════
// opts: { $mount, prefill, onConfirm(docData)->Promise, onCancel, cancelLabel }
sigos.build_rotatividade_wizard = function (opts) {
	const $mount = opts.$mount;
	const S = {
		step: 0, dir: 1,
		operacoes: [], op: null, flags: {},
		vig: null,
		novo_posto: null, novo_regime: null, nova_categoria: null,
		motivo: "", motiv_demi: "", uniforme: "", motivo_3meses: "",
		data: frappe.datetime.get_today(),
		data_de_demissao: frappe.datetime.get_today(),
		motivo_rotatividade: "",
		sub: null,
	};
	const controls = {};
	const $body = () => $mount;

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

	// ── navigation ──
	function _advance() {
		const steps = _steps();
		const key = steps[S.step];
		if (!_validate(key)) return;
		if (S.step >= steps.length - 1) { _confirm(); return; }
		S.dir = 1; S.step += 1; _render();
	}
	function _back() {
		if (S.step === 0) { if (opts.onCancel) opts.onCancel(); return; }
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
		if (key === "substituto") {
			if (S.sub && S.vig.categoria && S.sub.categoria && S.sub.categoria !== S.vig.categoria) {
				_toast(__("O substituto tem categoria diferente. Faça primeiro uma Troca De Categoria."));
				return false;
			}
		}
		if (key === "preview") {
			if (!S.motivo_rotatividade || !S.motivo_rotatividade.trim()) {
				_toast(__("Indique o motivo para continuar com a rotatividade."));
				return false;
			}
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
		else if (key === "preview") content = `
			<div id="rotw-prev"></div>
			<div class="rotw2-confirm">
				<div class="rotw2-confirm-row">
					<div class="rotw2-field"><label>${__("Data da Rotatividade")}</label><div id="ctrl-data"></div></div>
					${(S.flags.demite || S.motivo === "Demissão")
						? `<div class="rotw2-field"><label>${__("Data de Demissão")}</label><div id="ctrl-data_de_demissao"></div></div>` : ""}
				</div>
				<div class="rotw2-field"><label class="rotw2-req">${__("Motivo de Continuar com a Rotatividade")}</label><div id="ctrl-motivo_rotatividade"></div></div>
			</div>`;

		const last = S.step >= steps.length - 1;
		const backLabel = S.step === 0 ? (opts.cancelLabel || __("Cancelar")) : `← ${__("Anterior")}`;
		const nextLabel = last ? `${__("Confirmar Rotatividade")} ✓` : `${__("Próximo")} →`;

		$body().html(`
			<div class="rotw-head">
				<div class="rotw-op">${frappe.utils.escape_html(opName)}</div>
				<div class="rotw-stepper">${stepper}</div>
			</div>
			<div class="rotw-step rotw-slide-${S.dir > 0 ? "next" : "prev"}">${content}</div>
			<div class="rotw-footer">
				<button class="rotw-foot-btn rotw-back">${backLabel}</button>
				<button class="rotw-foot-btn rotw-next ${last ? "rotw-confirm" : ""}">${nextLabel}</button>
			</div>`);

		$body().find(".rotw-back").on("click", _back);
		$body().find(".rotw-next").on("click", _advance);

		// post-mount wiring per step
		if (key === "ident") _wireIdent();
		else if (key === "mudancas") _wireMudancas();
		else if (key === "substituto") _wireSubstituto();
		else if (key === "preview") _renderPreview();
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
		const mismatch = isSub && S.vig && S.vig.categoria && v.categoria && v.categoria !== S.vig.categoria;
		const warn = mismatch ? `<div class="rotw-warn" style="margin-top:8px">⚠️ ${__(
			"Categoria <b>{0}</b> não corresponde à vaga (<b>{1}</b>). Faça primeiro uma <b>Troca De Categoria</b> antes de usar este substituto.",
			[frappe.utils.escape_html(v.categoria), frappe.utils.escape_html(S.vig.categoria)])}</div>` : "";
		return `<div class="rotw2-chosen ${isSub ? "sub" : ""}">
			<span class="rotw2-av big">${_initials(v.nome_completo)}</span>
			<span class="rotw2-ginfo">
				<span class="rotw2-gname">${frappe.utils.escape_html(v.nome_completo || v.name)}</span>
				<span class="rotw2-gmeta">${v.mecanografico ? frappe.utils.escape_html(v.mecanografico) + " · " : ""}${frappe.utils.escape_html(meta || "")}</span>
			</span>
			<span class="rotw2-chosen-tag">${isSub ? __("Substituto") : __("Seleccionado")}</span>
		</div>${warn}`;
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

	// ════════ STEP 4 — Preview + confirm fields ════════
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

		// confirm fields: date(s) + mandatory justification
		_mountDate("data");
		if (S.flags.demite || S.motivo === "Demissão") _mountDate("data_de_demissao");
		_mountSmallText("motivo_rotatividade");
	}
	function _mountDate(fieldname) {
		const ctrl = frappe.ui.form.make_control({
			df: { fieldtype: "Date", fieldname, onchange: () => { S[fieldname] = ctrl.get_value(); } },
			parent: $body().find(`#ctrl-${fieldname}`), render_input: true,
		});
		ctrl.set_value(S[fieldname] || frappe.datetime.get_today());
		controls[fieldname] = ctrl;
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

	// ── confirm: hand the assembled doc to the caller's persistence ──
	function _confirm() {
		const docData = {
			doctype: "Rotatividade", data: S.data || frappe.datetime.get_today(),
			vigilante: S.vig.name, abreviatura_op: S.op.name,
			delegacao: S.vig.delegacao, mecanografico: S.vig.mecanografico,
			regime: S.vig.regime, categoria_vigilante: S.vig.categoria,
			novo_posto: S.novo_posto, novo_regime: S.novo_regime, nova_categoria: S.nova_categoria,
			novo_vigilante: S.sub ? S.sub.name : null, alocado_ao_posto: S.vig.posto,
			alocar_vigilante_substituto: S.sub ? "Sim" : "Não",
			motivo: S.motivo, motiv_demi: S.motiv_demi, uniforme: S.uniforme, motivo_3meses: S.motivo_3meses,
			data_de_demissao: S.data_de_demissao, motivo_rotatividade: S.motivo_rotatividade,
		};
		const $next = $body().find(".rotw-next");
		$next.prop("disabled", true);
		Promise.resolve(opts.onConfirm && opts.onConfirm(docData)).catch(() => $next.prop("disabled", false));
	}

	// ── prefill guard ──
	const prefill = opts.prefill || {};
	if (prefill.vigilante) {
		frappe.db.get_doc("Vigilante", prefill.vigilante).then((v) => {
			S.vig = { name: v.name, nome_completo: v.nome_completo, posto: v.posto_de_vigilancia,
				regime: v.regime_do_vigilante, categoria: v.categoria, delegacao: v.delegacao,
				mecanografico: v.mecanografico };
			if (_steps()[S.step] === "ident") _render();
		});
	}
};

// ════════ Thin modal wrapper (list button / Rotacionar) ════════
sigos.rotatividade_wizard = function (prefill = {}) {
	const d = new frappe.ui.Dialog({
		title: __("Rotatividade"),
		size: "large",
		fields: [{ fieldname: "body", fieldtype: "HTML" }],
	});
	d.$wrapper.addClass("sigos-rotw sigos-rotw2");
	d.$wrapper.find(".modal-footer").hide();   // engine renders its own footer
	d.show();

	sigos.build_rotatividade_wizard({
		$mount: d.fields_dict.body.$wrapper,
		prefill,
		cancelLabel: __("Cancelar"),
		onCancel: () => d.hide(),
		onConfirm: (doc) => new Promise((resolve, reject) => {
			frappe.call({
				method: "frappe.client.insert", args: { doc }, freeze: true, freeze_message: __("A criar…"),
				callback: (r) => frappe.call({
					method: "frappe.client.submit", args: { doc: r.message }, freeze: true, freeze_message: __("A aplicar…"),
					callback: () => {
						d.hide();
						frappe.show_alert({ message: __("Rotatividade {0} aplicada.", [r.message.name]), indicator: "green" }, 5);
						frappe.set_route("Form", "Rotatividade", r.message.name);
						resolve();
					},
					error: () => { frappe.set_route("Form", "Rotatividade", r.message.name); reject(); },
				}),
				error: reject,
			});
		}),
	});
};
