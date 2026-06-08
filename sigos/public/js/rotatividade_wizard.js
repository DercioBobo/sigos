// SIGOS — Rotatividade wizard (operational command console)
frappe.provide("sigos");

sigos.rotatividade_wizard = function (prefill = {}) {
	const state = {
		stepIdx: 0,
		op: null,
		flags: {},
		estado: null,        // current state of the selected guard
	};

	const MOTIVO_DEMI = "\nFim de Contrato\nAbandono\nJusta Causa\nAcordo Mútuo\nOutro";

	const d = new frappe.ui.Dialog({
		title: __("Rotatividade"),
		size: "large",
		fields: [
			{ fieldname: "wz_head", fieldtype: "HTML" },

			// ── Step 1: Operação + Vigilante ──
			{
				fieldname: "operacao", fieldtype: "Link", options: "Operacao De Rotatividade",
				label: __("Operação"), reqd: 1, get_query: () => ({ filters: { activo: 1 } }),
			},
			{ fieldname: "cb1", fieldtype: "Column Break" },
			{
				fieldname: "vigilante", fieldtype: "Link", options: "Vigilante",
				label: __("Vigilante"), reqd: 1, get_query: () => ({ filters: { status: "Activo" } }),
			},
			{ fieldname: "estado_card", fieldtype: "HTML" },

			// ── Step 2: Mudanças ──
			{ fieldname: "novo_posto", fieldtype: "Link", options: "Posto De Vigilancia", label: __("Novo Posto") },
			{ fieldname: "cb2", fieldtype: "Column Break" },
			{ fieldname: "novo_regime", fieldtype: "Link", options: "Regime", label: __("Novo Regime") },
			{ fieldname: "nova_categoria", fieldtype: "Link", options: "Categoria Vigilante", label: __("Nova Categoria") },
			{ fieldname: "motivo", fieldtype: "Select", label: __("Motivo"),
			  options: "\nTransferência\nReserva\nDemissão\nDisciplinar\nOutro" },
			{ fieldname: "motiv_demi", fieldtype: "Select", label: __("Motivo de Demissão"), options: MOTIVO_DEMI },
			{ fieldname: "uniforme", fieldtype: "Select", label: __("Uniforme Entregue"), options: "\nSim\nNão" },
			{ fieldname: "motivo_3meses", fieldtype: "Small Text", label: __("Justificação (antes do mínimo de dias)") },

			// ── Step 3: Substituto ──
			{
				fieldname: "novo_vigilante", fieldtype: "Link", options: "Vigilante", label: __("Vigilante Substituto"),
				get_query: () => ({
					query: "sigos.api.get_substitutos_disponiveis",
					filters: { delegacao: state.estado?.delegacao || "", excluir: d.get_value("vigilante") || "" },
				}),
			},
			{ fieldname: "sub_card", fieldtype: "HTML" },

			// ── Step 4: Preview ──
			{ fieldname: "preview", fieldtype: "HTML" },
		],
		primary_action_label: __("Próximo →"),
		primary_action: () => _advance(),
	});

	d.$wrapper.addClass("sigos-rotw");

	// Steps definition (step 3 is conditional on requer_substituto)
	const STEPS = [
		{ key: "ident", label: __("Operação & Vigilante"), fields: ["operacao", "vigilante"] },
		{ key: "mudancas", label: __("Mudanças"), fields: [] },     // computed per op
		{ key: "substituto", label: __("Substituto"), fields: ["novo_vigilante"] },
		{ key: "preview", label: __("Confirmação"), fields: [] },
	];

	const ALL_STEP2 = ["novo_posto", "novo_regime", "nova_categoria", "motivo", "motiv_demi", "uniforme", "motivo_3meses"];
	const ALL_FIELDS = ["operacao", "vigilante", "estado_card", ...ALL_STEP2, "novo_vigilante", "sub_card", "preview"];

	function _activeSteps() {
		// Skip the substituto step when the operation doesn't require one
		return STEPS.filter((s) => s.key !== "substituto" || state.flags.requer_substituto);
	}

	function _step2Fields() {
		const f = [];
		if (state.flags.muda_posto) f.push("novo_posto");
		if (state.flags.muda_regime) f.push("novo_regime");
		if (state.flags.muda_categoria) f.push("nova_categoria");
		f.push("motivo");
		if (state.flags.demite || d.get_value("motivo") === "Demissão") { f.push("motiv_demi", "uniforme"); }
		f.push("motivo_3meses");
		return f;
	}

	// ── Operation flags load ──
	d.fields_dict.operacao.df.onchange = () => {
		const op = d.get_value("operacao");
		if (!op) { state.op = null; state.flags = {}; return; }
		frappe.db.get_doc("Operacao De Rotatividade", op).then((doc) => {
			state.op = doc;
			state.flags = {
				muda_posto: !!doc.muda_posto, muda_regime: !!doc.muda_regime,
				muda_categoria: !!doc.muda_categoria, demite: !!doc.demite,
				requer_substituto: !!doc.requer_substituto,
			};
			_renderHead();
		});
	};

	d.fields_dict.vigilante.df.onchange = () => {
		const v = d.get_value("vigilante");
		if (!v) { state.estado = null; _renderEstadoCard(); return; }
		frappe.db.get_doc("Vigilante", v).then((doc) => {
			state.estado = {
				nome: doc.nome_completo, posto: doc.posto_de_vigilancia, regime: doc.regime_do_vigilante,
				categoria: doc.categoria, delegacao: doc.delegacao, mecanografico: doc.mecanografico,
				status: doc.status,
			};
			_renderEstadoCard();
		});
	};

	d.fields_dict.motivo.df.onchange = () => _render();

	// ── Navigation ──
	function _advance() {
		const steps = _activeSteps();
		const cur = steps[state.stepIdx];

		if (!_validateStep(cur)) return;

		if (state.stepIdx >= steps.length - 1) { _confirm(); return; }
		state.stepIdx += 1;
		_render();
	}

	function _back() {
		if (state.stepIdx === 0) { d.hide(); return; }
		state.stepIdx -= 1;
		_render();
	}

	function _validateStep(step) {
		if (step.key === "ident") {
			if (!d.get_value("operacao") || !d.get_value("vigilante")) {
				frappe.show_alert({ message: __("Escolha a operação e o vigilante."), indicator: "orange" }, 3);
				return false;
			}
		}
		if (step.key === "mudancas") {
			for (const f of _step2Fields()) {
				const req = (f === "novo_posto" && state.flags.muda_posto) ||
					(f === "novo_regime" && state.flags.muda_regime) ||
					(f === "nova_categoria" && state.flags.muda_categoria);
				if (req && !d.get_value(f)) {
					frappe.show_alert({ message: __("Preencha os campos da mudança."), indicator: "orange" }, 3);
					return false;
				}
			}
		}
		return true;
	}

	// ── Rendering ──
	function _render() {
		const steps = _activeSteps();
		const cur = steps[state.stepIdx];

		// hide everything, then reveal the current step's fields
		ALL_FIELDS.forEach((f) => d.set_df_property(f, "hidden", 1));

		if (cur.key === "ident") {
			["operacao", "vigilante", "estado_card"].forEach((f) => d.set_df_property(f, "hidden", 0));
			_renderEstadoCard();
		} else if (cur.key === "mudancas") {
			_step2Fields().forEach((f) => d.set_df_property(f, "hidden", 0));
		} else if (cur.key === "substituto") {
			["novo_vigilante", "sub_card"].forEach((f) => d.set_df_property(f, "hidden", 0));
		} else if (cur.key === "preview") {
			d.set_df_property("preview", "hidden", 0);
			_renderPreview();
		}

		_renderHead();
		_renderFooter(steps);
	}

	function _renderHead() {
		const steps = _activeSteps();
		const nodes = steps.map((s, i) => {
			const st = i < state.stepIdx ? "done" : (i === state.stepIdx ? "active" : "todo");
			return `<div class="rotw-node ${st}">
				<span class="rotw-dot">${i < state.stepIdx ? "✓" : i + 1}</span>
				<span class="rotw-nlabel">${s.label}</span>
			</div>`;
		}).join('<span class="rotw-conn"></span>');

		const opName = state.op ? `${state.op.abreviatura} · ${state.op.operacao}` : __("Selecione a operação");
		d.fields_dict.wz_head.$wrapper.html(`
			<div class="rotw-head">
				<div class="rotw-op">${frappe.utils.escape_html(opName)}</div>
				<div class="rotw-stepper">${nodes}</div>
			</div>`);
	}

	function _renderFooter(steps) {
		const last = state.stepIdx >= steps.length - 1;
		const $btn = d.get_primary_btn();
		$btn.html(last ? `${__("Confirmar Rotatividade")} ✓` : `${__("Próximo")} →`);
		$btn.toggleClass("rotw-confirm", last);

		// back button (injected once)
		let $back = d.$wrapper.find(".rotw-back");
		if (!$back.length) {
			$back = $(`<button class="btn rotw-back"></button>`);
			$btn.before($back);
			$back.on("click", () => _back());
		}
		$back.html(state.stepIdx === 0 ? __("Cancelar") : `← ${__("Anterior")}`);
	}

	function _renderEstadoCard() {
		const e = state.estado;
		const $w = d.fields_dict.estado_card.$wrapper;
		if (!e) { $w.html(""); return; }
		$w.html(`
			<div class="rotw-state">
				<div class="rotw-state-title">${__("Situação Actual")}</div>
				<div class="rotw-state-grid">
					${_stateCell(__("Posto"), e.posto)}
					${_stateCell(__("Regime"), e.regime)}
					${_stateCell(__("Categoria"), e.categoria)}
					${_stateCell(__("Delegação"), e.delegacao)}
				</div>
			</div>`);
	}
	function _stateCell(label, val) {
		return `<div class="rotw-scell"><span class="rotw-slabel">${label}</span>
			<span class="rotw-sval">${val ? frappe.utils.escape_html(val) : "—"}</span></div>`;
	}

	function _renderPreview() {
		const $w = d.fields_dict.preview.$wrapper;
		$w.html(`<div class="rotw-prev-loading">${__("A calcular efeitos...")}</div>`);

		frappe.call({
			method: "sigos.api.preview_rotatividade",
			args: {
				vigilante: d.get_value("vigilante"),
				abreviatura_op: d.get_value("operacao"),
				novo_posto: d.get_value("novo_posto"),
				novo_regime: d.get_value("novo_regime"),
				nova_categoria: d.get_value("nova_categoria"),
				novo_vigilante: d.get_value("novo_vigilante"),
				motivo: d.get_value("motivo"),
				motivo_3meses: d.get_value("motivo_3meses"),
			},
			callback: (r) => $w.html(_previewHtml(r.message || {})),
		});
	}

	function _previewHtml(p) {
		const chips = (p.mudancas || []).map((m) => `
			<div class="rotw-change">
				<span class="rotw-cfield">${frappe.utils.escape_html(m.campo)}</span>
				<span class="rotw-cflow"><span class="rotw-cfrom">${frappe.utils.escape_html(m.de || "—")}</span>
				<span class="rotw-carrow">→</span>
				<span class="rotw-cto">${frappe.utils.escape_html(m.para || "—")}</span></span>
			</div>`).join("") || `<div class="rotw-none">${__("Sem alterações directas ao vigilante.")}</div>`;

		let escala = "";
		if (p.escala) {
			const sai = p.escala.sai ? `<span class="rotw-esc-out">${p.escala.sai}</span>` : `<span class="rotw-none-inline">${__("nenhuma")}</span>`;
			const entra = p.escala.entra
				? `<span class="rotw-esc-in">${p.escala.entra}${p.escala.entra_criada ? ` <em>(${__("será criada")})</em>` : ""}</span>`
				: (p.demite ? `<span class="rotw-none-inline">${__("removido de serviço")}</span>` : `<span class="rotw-none-inline">—</span>`);
			escala = `<div class="rotw-block">
				<div class="rotw-block-h">${__("Escala")}</div>
				<div class="rotw-esc-flow">${__("Sai de")} ${sai} <span class="rotw-carrow">→</span> ${__("Entra em")} ${entra}</div>
			</div>`;
		}

		const occ = (p.ocupacao || []).map((o) => {
			const up = o.para > o.de, dn = o.para < o.de;
			return `<div class="rotw-occ">
				<span class="rotw-occ-posto">${frappe.utils.escape_html(o.posto)}</span>
				<span class="rotw-occ-num">${o.de} <span class="rotw-carrow">→</span>
				<b class="${up ? "occ-up" : dn ? "occ-dn" : ""}">${o.para}</b></span>
			</div>`;
		}).join("");
		const occBlock = occ ? `<div class="rotw-block"><div class="rotw-block-h">${__("Ocupação")}</div>${occ}</div>` : "";

		const sub = p.substituto ? `<div class="rotw-block">
			<div class="rotw-block-h">${__("Substituto")}</div>
			<div class="rotw-sub">${frappe.utils.escape_html(p.substituto.nome)} ${__("assume")}
				<b>${frappe.utils.escape_html(p.substituto.assume_posto || "—")}</b></div>
		</div>` : "";

		const dem = p.demite ? `<div class="rotw-warn rotw-warn-dem">⚑ ${__("Demissão automática será criada.")}</div>` : "";
		const warns = (p.avisos || []).map((w) => `<div class="rotw-warn">⚠️ ${frappe.utils.escape_html(w)}</div>`).join("");

		return `
			<div class="rotw-preview">
				<div class="rotw-prev-head">
					<div class="rotw-prev-vig">${frappe.utils.escape_html(p.nome || "")}</div>
					<div class="rotw-prev-op">${frappe.utils.escape_html(p.operacao || "")}</div>
				</div>
				<div class="rotw-block"><div class="rotw-block-h">${__("Alterações")}</div>${chips}</div>
				${escala}${occBlock}${sub}
				${dem}${warns}
			</div>`;
	}

	// ── Confirm: assemble + submit the Rotatividade doc ──
	function _confirm() {
		const doc = {
			doctype: "Rotatividade",
			data: frappe.datetime.get_today(),
			vigilante: d.get_value("vigilante"),
			abreviatura_op: d.get_value("operacao"),
			delegacao: state.estado?.delegacao,
			mecanografico: state.estado?.mecanografico,
			regime: state.estado?.regime,
			categoria_vigilante: state.estado?.categoria,
			novo_posto: d.get_value("novo_posto"),
			novo_regime: d.get_value("novo_regime"),
			nova_categoria: d.get_value("nova_categoria"),
			novo_vigilante: d.get_value("novo_vigilante"),
			alocado_ao_posto: state.estado?.posto,
			alocar_vigilante_substituto: d.get_value("novo_vigilante") ? "Sim" : "Não",
			motivo: d.get_value("motivo"),
			motiv_demi: d.get_value("motiv_demi"),
			uniforme: d.get_value("uniforme"),
			motivo_3meses: d.get_value("motivo_3meses"),
		};

		d.get_primary_btn().prop("disabled", true);
		frappe.call({
			method: "frappe.client.insert",
			args: { doc },
			freeze: true,
			freeze_message: __("A criar rotatividade..."),
			callback: (r) => {
				const name = r.message.name;
				// submit it (engine runs in on_submit)
				frappe.call({
					method: "frappe.client.submit",
					args: { doc: r.message },
					freeze: true, freeze_message: __("A aplicar..."),
					callback: () => {
						d.hide();
						frappe.show_alert({ message: __("Rotatividade {0} aplicada.", [name]), indicator: "green" }, 5);
						frappe.set_route("Form", "Rotatividade", name);
					},
					error: () => { d.get_primary_btn().prop("disabled", false); frappe.set_route("Form", "Rotatividade", name); },
				});
			},
			error: () => d.get_primary_btn().prop("disabled", false),
		});
	}

	// ── Boot ──
	d.show();
	state.stepIdx = 0;
	_render();

	if (prefill.vigilante) d.set_value("vigilante", prefill.vigilante);
};
