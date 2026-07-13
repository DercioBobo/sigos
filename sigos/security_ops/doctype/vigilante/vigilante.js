frappe.ui.form.on("Vigilante", {
	// ─── Setup ─────────────────────────────────────────────────────────────────
	onload(frm) {
		if (frm.is_new() && !frm.doc.status) {
			// status is read-only (system-managed) — set_value is a no-op on read-only
			// fields, so write it directly to guarantee the onboarding state.
			frm.doc.status = "Pre-Adimissão RH";
			frm.refresh_field("status");
		}

		frm.set_query("posto_de_vigilancia", () => ({
			filters: { delegacao: frm.doc.delegacao },
		}));
	},

	refresh(frm) {
		frm.trigger("_aplicar_permissoes");
		frm.trigger("_botoes_aprovacao");
		sigos.danger_btn(frm, "limpar_escala");
		_calcular_idade(frm);
		_colorir_tabs(frm);
		_setup_proximo_btn(frm);
		_render_mini_dash(frm);
		_toggle_posicao(frm);
		_toggle_subsidios_comb(frm);

		// Ver Escala — only for active guards already assigned to a posto
		if (!frm.is_new() && frm.doc.status === "Activo" && frm.doc.posto_de_vigilancia) {
			frm.add_custom_button(__("Ver Escala"), () => {
				sigos.show_escala_preview({
					posto: frm.doc.posto_de_vigilancia,
					titulo: frm.doc.nome_completo || frm.doc.name,
					destacar: frm.doc.name,   // highlight this guard's row
				});
			}, __("Acções"));
		}

		// Rotacionar — open a new Rotatividade (the form IS the wizard), pre-filled with this guard
		if (!frm.is_new() && frm.doc.status === "Activo") {
			frm.add_custom_button(__("Rotacionar"), () => {
				frappe.route_options = { vigilante: frm.doc.name };
				frappe.new_doc("Rotatividade");
			}, __("Acções"));
		}
	},

	// ─── Field events ──────────────────────────────────────────────────────────
	data_de_nascimento(frm) {
		_calcular_idade(frm);
	},

	delegacao(frm) {
		frm.set_value("posto_de_vigilancia", "");
		frm.set_query("posto_de_vigilancia", () => ({
			filters: { delegacao: frm.doc.delegacao },
		}));
	},

	// ─── Internal triggers ─────────────────────────────────────────────────────
	_aplicar_permissoes(frm) {
		// HR-only section: mecanografico, funcionario, data_admissao, empresa
		const campos_rh = ["mecanografico", "funcionario", "data_admissao", "empresa", "motivo_de_admissao"];
		const campos_ops = ["posto_de_vigilancia", "categoria", "tipo_de_vigilante", "regime_do_vigilante", "delegacao"];

		const is_rh  = frappe.user.has_role("Aprovador RH")  || frappe.user.has_role("System Manager") || frappe.user.has_role("SIGOS Manager");
		const is_ops = frappe.user.has_role("Aprovador Operações") || frappe.user.has_role("System Manager") || frappe.user.has_role("SIGOS Manager");

		campos_rh.forEach(f  => frm.set_df_property(f, "read_only", is_rh  ? 0 : 1));
		campos_ops.forEach(f => frm.set_df_property(f, "read_only", is_ops ? 0 : 1));

		// funcionario always read-only (system-managed)
		frm.set_df_property("funcionario", "read_only", 1);

		// Regime drives the Escala — once it's SET, changes must go through
		// "Troca De Regime" (which migrates the escala). We only lock it when it
		// already has a value: an empty regime stays editable (and visible) so a
		// guard saved without one — e.g. Pre-Adimissão/Reserva — can still get it
		// assigned. (A read-only Frappe field with no value renders as nothing,
		// which is why an empty regime appeared to "disappear" after the first save.)
		if (!frm.is_new() && frm.doc.regime_do_vigilante) {
			frm.set_df_property("regime_do_vigilante", "read_only", 1);
			frm.set_df_property("regime_do_vigilante", "description",
				__("Para alterar o regime use o documento <b>Troca De Regime</b> — mantém a escala consistente."));
		}
	},

	_botoes_aprovacao(frm) {
		if (frm.is_new()) return;

		// RH: Pre-Adimissão RH → Pre-Adimissão
		if (frappe.user.has_role("Aprovador RH") && frm.doc.status === "Pre-Adimissão RH") {
			frm.add_custom_button(__("Admitir (RH)"), () => {
				frappe.confirm(
					__("Confirmar admissão pelo RH? Será criado o registo de Funcionário."),
					() => {
						frappe.call({
							method: "frappe.client.set_value",
							args: { doctype: "Vigilante", name: frm.doc.name, fieldname: "status", value: "Pre-Adimissão" },
							callback: () => frm.reload_doc(),
						});
					}
				);
			}, __("Acções"));
		}

		// Ops: Pre-Adimissão → Activo
		if (frappe.user.has_role("Aprovador Operações") && frm.doc.status === "Pre-Adimissão") {
			frm.add_custom_button(__("Ativar"), () => {
				frappe.confirm(
					__("Confirmar ativação do vigilante?"),
					() => {
						frappe.call({
							method: "frappe.client.set_value",
							args: { doctype: "Vigilante", name: frm.doc.name, fieldname: "status", value: "Activo" },
							callback: () => frm.reload_doc(),
						});
					}
				);
			}, __("Acções"));
		}

		// Definir Salário — RH/managers only; works for any employed guard (has Funcionário).
		const pode_rh = frappe.user.has_role("Aprovador RH")
			|| frappe.user.has_role("SIGOS Manager")
			|| frappe.user.has_role("System Manager");
		if (pode_rh && frm.doc.funcionario && frm.doc.status !== "Demitido") {
			frm.add_custom_button(__("Definir Salário"), () => _definir_salario(frm), __("Acções"));
		}

		// Operational benching — release posto + escala, keep the guard employed.
		const pode_ops = frappe.user.has_role("Aprovador Operações")
			|| frappe.user.has_role("SIGOS Manager")
			|| frappe.user.has_role("System Manager");

		// Colocar em Reserva: bench an active or suspended guard (Employee stays Active)
		if (pode_ops && ["Activo", "Inactivo"].includes(frm.doc.status)) {
			frm.add_custom_button(__("Colocar em Reserva"), () => {
				_mudar_estado_op(frm, "colocar_em_reserva", __("Colocar em Reserva"),
					__("O vigilante sai do posto e da escala, mas continua empregado e disponível para redistribuição."));
			}, __("Acções"));
		}

		// Inactivar: suspend an active or reserve guard (Employee → Suspended)
		if (pode_ops && ["Activo", "Reserva"].includes(frm.doc.status)) {
			frm.add_custom_button(__("Inactivar"), () => {
				_mudar_estado_op(frm, "inactivar", __("Inactivar Vigilante"),
					__("O vigilante sai do posto e da escala e o Funcionário passa a <b>Suspenso</b>. Use para suspensões temporárias."));
			}, __("Acções"));
		}
	},
});

// ─── Posição (customer-specific, SIGOS Settings.posicao_no_posto_activo) ──────
// Hidden by default — most customers don't track a per-posto position, so the
// field only shows once the flag is on. Fetched once per session, then cached.
let _posicao_activo = null;
function _toggle_posicao(frm) {
	if (_posicao_activo === null) {
		frappe.db.get_single_value("SIGOS Settings", "posicao_no_posto_activo").then((v) => {
			_posicao_activo = !!v;
			frm.set_df_property("posicao", "hidden", _posicao_activo ? 0 : 1);
		});
	} else {
		frm.set_df_property("posicao", "hidden", _posicao_activo ? 0 : 1);
	}
}

// ─── Subsídios Combináveis (customer-specific, SIGOS Settings.subsidios_categoria_funcao_activo) ──
// Chefe de Turno / Chefe de Posto / Canino — three independent flags, NOT mutually
// exclusive (a guard can have all three on at once); each drives its own stackable
// earning on the Salary Slip (sigos/payroll_ext/salary_slip_hooks.py). Hidden by
// default like Posição — most customers don't use this.
let _subsidios_comb_activo = null;
const _CAMPOS_SUBSIDIOS_COMB = ["sec_subsidios_comb", "chefe_de_turno", "chefe_de_posto", "col_break_subsidios_comb", "com_cao"];
function _toggle_subsidios_comb(frm) {
	if (_subsidios_comb_activo === null) {
		frappe.db.get_single_value("SIGOS Settings", "subsidios_categoria_funcao_activo").then((v) => {
			_subsidios_comb_activo = !!v;
			_CAMPOS_SUBSIDIOS_COMB.forEach((f) => frm.set_df_property(f, "hidden", _subsidios_comb_activo ? 0 : 1));
		});
	} else {
		_CAMPOS_SUBSIDIOS_COMB.forEach((f) => frm.set_df_property(f, "hidden", _subsidios_comb_activo ? 0 : 1));
	}
}

// ─── Operational state change (Reserva / Inactivo) ────────────────────────────
// Single dialog: shows the consequence + an optional reason, then calls the
// whitelisted controller method which releases the posto and saves.
function _mudar_estado_op(frm, metodo, titulo, aviso) {
	const d = new frappe.ui.Dialog({
		title: titulo,
		fields: [
			{ fieldtype: "HTML", options: `<p class="text-muted" style="margin-bottom:8px">${aviso}</p>` },
			{ fieldname: "motivo", fieldtype: "Small Text", label: __("Motivo (opcional)") },
		],
		primary_action_label: __("Confirmar"),
		primary_action(vals) {
			d.hide();
			frm.call(metodo, { motivo: (vals.motivo || "").trim() || null })
				.then(() => frm.reload_doc());
		},
	});
	d.show();
}

// ─── Definir Salário ──────────────────────────────────────────────────────────
// Shared dialog/flow (sigos.quick_docs, sigos/public/js/sigos_quick_docs.js) — also
// used by the Employee "Painel RH 360" deck and the Diretório de Colaboradores page.
function _definir_salario(frm) {
	sigos.quick_docs.definir_salario(frm.doc.name, () => frm.reload_doc(), frm.doc.salario_base_manual);
}

// ─── Mini-dash: operational readiness at a glance, above the tabs ──────────────
// Shows the data the rest of the system depends on (Escala, Ausências, payroll).
// Missing-but-required values render LIGHT RED so gaps jump out. Required set
// depends on status — a Reserva guard has no posto/escala by design (neutral),
// Demitido/Inactivo require nothing.

const _DASH_REQ = {
	"Activo":           ["posto_de_vigilancia", "regime_do_vigilante", "categoria", "delegacao", "mecanografico", "data_admissao"],
	"Pre-Adimissão":    ["posto_de_vigilancia", "regime_do_vigilante", "categoria", "delegacao", "mecanografico", "data_admissao"],
	"Pre-Adimissão RH": ["delegacao", "categoria", "data_admissao"],
	"Reserva":          ["categoria", "delegacao", "mecanografico", "data_admissao"],
};
const _DASH_STATUS_CLS = {
	"Activo": "vigd-st-on", "Reserva": "vigd-st-res",
	"Pre-Adimissão": "vigd-st-pre", "Pre-Adimissão RH": "vigd-st-pre",
	"Inactivo": "vigd-st-off", "Demitido": "vigd-st-dem",
};
const _DASH_PER_CLS = { "Manhã": "cell-manha", "Noite": "cell-noite", "Tarde": "cell-tarde" };

function _render_mini_dash(frm) {
	_inject_dash_css();
	frm.$wrapper.find(".sigos-vig-dash").remove();
	if (frm.is_new()) return;

	const req = new Set(_DASH_REQ[frm.doc.status] || []);
	const esc = frappe.utils.escape_html;

	const cell = (lbl, valor, opts = {}) => {
		const falta = opts.req && !valor;
		const html = opts.html || (valor ? esc(valor) : (falta ? __("Não definido") : "—"));
		return `<div class="vigd-cell ${falta ? "is-missing" : ""}" ${opts.attr || ""}>
			<span class="vigd-lbl">${lbl}</span>
			<span class="vigd-val">${html}</span>
		</div>`;
	};

	const stCls = _DASH_STATUS_CLS[frm.doc.status] || "vigd-st-off";
	let postoOpts = { req: req.has("posto_de_vigilancia") };
	if (frm.doc.status === "Reserva" && !frm.doc.posto_de_vigilancia) {
		postoOpts = { html: `<span class="vigd-dim">${__("Reserva — sem posto")}</span>` };
	}

	const $dash = $(`
		<div class="sigos-vig-dash">
			${cell(__("Estado"), null, { html: `<span class="vigd-st ${stCls}">${esc(frm.doc.status || "-")}</span>` })}
			${cell(__("Posto"), frm.doc.posto_de_vigilancia, postoOpts)}
			${cell(__("Regime"), frm.doc.regime_do_vigilante, { req: req.has("regime_do_vigilante") })}
			${cell(__("Categoria"), frm.doc.categoria, { req: req.has("categoria") })}
			${cell(__("Delegação"), frm.doc.delegacao, { req: req.has("delegacao") })}
			${cell(__("Mecanográfico"), frm.doc.mecanografico, { req: req.has("mecanografico") })}
			${cell(__("Admissão"), frm.doc.data_admissao ? frappe.datetime.str_to_user(frm.doc.data_admissao) : null, { req: req.has("data_admissao") })}
			${cell(__("Escala Hoje"), null, { html: `<span class="vigd-dim">…</span>`, attr: 'data-vigd="hoje"' })}
			${cell(__("Faltas (mês)"), null, { html: `<span class="vigd-dim">…</span>`, attr: 'data-vigd="faltas"' })}
		</div>`);

	(frm.layout?.wrapper ? $(frm.layout.wrapper) : frm.$wrapper.find(".form-layout")).prepend($dash);

	// Async stats — monthly faltas (payroll single source) + today's shift
	frappe.call({ method: "sigos.api.get_vigilante_dash", args: { vigilante: frm.doc.name } }).then(r => {
		const d = r.message || {};
		const $hoje = $dash.find('[data-vigd="hoje"] .vigd-val');
		const $faltas = $dash.find('[data-vigd="faltas"] .vigd-val');

		const ativo = frm.doc.status === "Activo";
		if (d.hoje) {
			if (d.hoje.e_folga) $hoje.html(`<span class="vigd-chip cell-folga">${__("Folga")}</span>`);
			else $hoje.html(`<span class="vigd-chip ${_DASH_PER_CLS[d.hoje.periodo] || "cell-folga"}">${esc(d.hoje.turno || "")}</span>`);
		} else if (ativo && frm.doc.posto_de_vigilancia) {
			// active + posto but no row today = not in any active escala — that's a gap
			$hoje.html(`<span class="vigd-warn">${__("Sem escala")}</span>`);
			$hoje.closest(".vigd-cell").addClass("is-warn");
		} else {
			$hoje.html(`<span class="vigd-dim">—</span>`);
		}

		const n = d.faltas_mes || 0;
		$faltas.html(`<span class="vigd-n ${n ? "vigd-n-warn" : ""}">${n}</span>`);
	});
}

function _inject_dash_css() {
	if (document.getElementById("sigos-vig-dash-css")) return;
	const css = `
.sigos-vig-dash {
	display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 1px;
	margin: 2px 0 14px; border: 1px solid #e4e8ec; border-radius: 12px; overflow: hidden;
	background: #e4e8ec; box-shadow: 0 1px 3px rgba(0,0,0,.05);
}
.vigd-cell { background: #fff; padding: 9px 12px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.vigd-lbl { font-size: .64em; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #9aa2aa; white-space: nowrap; }
.vigd-val { font-size: .9em; font-weight: 700; color: #1a3a5c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--sigos-display, system-ui); }
.vigd-cell.is-missing { background: #fdecef; box-shadow: inset 0 0 0 1px #f5c2c9; }
.vigd-cell.is-missing .vigd-lbl { color: #b02a37; }
.vigd-cell.is-missing .vigd-val { color: #b02a37; font-weight: 600; font-style: italic; }
.vigd-cell.is-warn { background: #fff8e6; box-shadow: inset 0 0 0 1px #ffe08a; }
.vigd-warn { color: #8a6d1a; font-weight: 700; }
.vigd-dim { color: #aeb7c0; font-weight: 500; }
.vigd-st { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: .82em; }
.vigd-st-on  { background: #d1e7dd; color: #0f5132; }
.vigd-st-res { background: #dbeafe; color: #1e429f; }
.vigd-st-pre { background: #fff3cd; color: #856404; }
.vigd-st-off { background: #e2e3e5; color: #41464b; }
.vigd-st-dem { background: #f8d7da; color: #842029; }
.vigd-chip { display: inline-block; padding: 2px 10px; border-radius: 999px; color: #fff; font-size: .82em; font-weight: 700; }
.vigd-n { font-size: 1.25em; }
.vigd-n-warn { color: #b8860b; }
`;
	const s = document.createElement("style");
	s.id = "sigos-vig-dash-css";
	s.textContent = css;
	document.head.appendChild(s);
}

// ─── Wizard footer: Anterior / Próximo / Guardar at the bottom of the form ────
function _setup_proximo_btn(frm) {
	// Remove any prior footer to avoid duplicates on re-render
	frm.$wrapper.find(".sigos-wizard-nav").remove();
	if (!frm.is_new()) return;

	const $footer = $(`
		<div class="sigos-wizard-nav">
			<button class="sigos-wz-btn sigos-wz-prev">‹ ${__("Anterior")}</button>
			<div class="sigos-wz-steps"></div>
			<button class="sigos-wz-btn sigos-wz-next"></button>
		</div>`);

	// Sits at the bottom of the form body, below the tab content
	(frm.layout?.wrapper ? $(frm.layout.wrapper) : frm.$wrapper.find(".form-layout")).append($footer);

	const tabs = () => _form_tab_links(frm);
	const activeIdx = () => { const $t = tabs(); return Math.max(0, $t.index($t.filter(".active"))); };

	const update = () => {
		const $t = tabs();
		if ($t.length < 2) { $footer.hide(); return; }
		$footer.show();
		const idx = activeIdx();
		const last = idx >= $t.length - 1;

		$footer.find(".sigos-wz-prev").prop("disabled", idx === 0);
		$footer.find(".sigos-wz-next")
			.text(last ? __("Guardar") + " ✓" : __("Próximo") + " ›")
			.toggleClass("is-save", last);

		const dots = $t.map((i) =>
			`<span class="sigos-wz-dot ${i === idx ? "active" : ""} ${i < idx ? "done" : ""}"></span>`
		).get().join("");
		$footer.find(".sigos-wz-steps").html(
			`${dots}<span class="sigos-wz-label">${$t.eq(idx).text().trim()}</span>`
		);
	};

	$footer.find(".sigos-wz-prev").on("click", () => {
		const $t = tabs(), idx = activeIdx();
		if (idx > 0) { $t.eq(idx - 1).trigger("click"); frappe.utils.scroll_to(0); }
	});
	$footer.find(".sigos-wz-next").on("click", () => {
		const $t = tabs(), idx = activeIdx();
		if (idx >= $t.length - 1) { frm.save(); }
		else { $t.eq(idx + 1).trigger("click"); frappe.utils.scroll_to(0); }
	});

	// Keep footer in sync when the user clicks tabs directly
	tabs().off("click.sigoswz").on("click.sigoswz", () => setTimeout(update, 60));

	update();
}

function _form_tab_links(frm) {
	// Cover Frappe v15 selector variants
	return $(frm.wrapper).find(
		".form-tabs-list .nav-link, .form-tabs .nav-link, .nav-tabs .nav-link"
	);
}

// ─── Tab colours (Operacional = blue, RH = orange) ───────────────────────────
function _colorir_tabs(frm) {
	// Tabs render asynchronously; wait one tick then apply classes
	setTimeout(() => {
		$(frm.wrapper).find(".tab-link, .nav-link").each(function () {
			const label = $(this).text().trim();
			$(this).removeClass("sigos-tab-ops sigos-tab-rh");
			if (label === __("Dados Operacionais")) {
				$(this).addClass("sigos-tab-ops");
			} else if (label === __("Dados RH")) {
				$(this).addClass("sigos-tab-rh");
			}
		});
	}, 150);
}

// ─── Age calculator ──────────────────────────────────────────────────────────
function _calcular_idade(frm) {
	const val = frm.doc.data_de_nascimento
		? _idade_de_dob(frm.doc.data_de_nascimento)
		: null;
	// set_value ignores read_only fields — write directly then refresh
	frm.doc.idade = val;
	frm.refresh_field("idade");
}

function _idade_de_dob(dob_str) {
	const dob  = new Date(dob_str);
	const hoje = new Date();
	let idade  = hoje.getFullYear() - dob.getFullYear();
	const m    = hoje.getMonth() - dob.getMonth();
	if (m < 0 || (m === 0 && hoje.getDate() < dob.getDate())) idade--;
	return idade;
}
