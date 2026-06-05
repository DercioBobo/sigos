frappe.ui.form.on("Vigilante", {
	// ─── Setup ─────────────────────────────────────────────────────────────────
	onload(frm) {
		if (frm.is_new()) {
			frm.set_value("status", "Pre-Adimissão RH");
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

		// Ver Escala — only for active guards already assigned to a posto
		if (!frm.is_new() && frm.doc.status === "Ativo" && frm.doc.posto_de_vigilancia) {
			frm.add_custom_button(__("Ver Escala"), () => {
				sigos.show_escala_preview({
					posto: frm.doc.posto_de_vigilancia,
					titulo: frm.doc.nome_completo || frm.doc.name,
					destacar: frm.doc.name,   // highlight this guard's row
				});
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

		// Regime drives the Escala — once the guard exists, changes must go through
		// "Troca De Regime" (which migrates the escala). Editable only on a new doc.
		if (!frm.is_new()) {
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
			}, __("Ações"));
		}

		// Ops: Pre-Adimissão → Ativo
		if (frappe.user.has_role("Aprovador Operações") && frm.doc.status === "Pre-Adimissão") {
			frm.add_custom_button(__("Ativar"), () => {
				frappe.confirm(
					__("Confirmar ativação do vigilante?"),
					() => {
						frappe.call({
							method: "frappe.client.set_value",
							args: { doctype: "Vigilante", name: frm.doc.name, fieldname: "status", value: "Ativo" },
							callback: () => frm.reload_doc(),
						});
					}
				);
			}, __("Ações"));
		}
	},
});

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
