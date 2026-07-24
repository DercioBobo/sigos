// Project Subsídio row — controls WHO on the project actually receives that
// specific salary component (previously every subsídio was applied to every
// vigilante on the project, unconditionally). "Todos do Projecto" keeps the old
// behaviour; "Vigilantes Específicos" opens a searchable checklist so HR can pick
// the handful of guards (out of potentially hundreds) who are entitled to it.

frappe.ui.form.on("Project Subsidio Item", {
	aplicar_a(frm, cdt, cdn) {
		const row = locals[cdt][cdn];
		if (row.aplicar_a !== "Vigilantes Específicos") {
			frappe.model.set_value(cdt, cdn, "vigilantes_json", "[]");
			frappe.model.set_value(cdt, cdn, "resumo_beneficiarios", __("Todos"));
		} else if (!row.vigilantes_json || row.vigilantes_json === "[]") {
			frappe.model.set_value(cdt, cdn, "resumo_beneficiarios", __("Nenhum seleccionado"));
		}
	},

	gerir_beneficiarios(frm, cdt, cdn) {
		_psi_abrir_gestor_beneficiarios(frm, cdt, cdn);
	},
});

function _psi_abrir_gestor_beneficiarios(frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	if (!frm.doc.name || frm.is_new()) {
		frappe.msgprint(__("Grave o Projecto antes de escolher os beneficiários."));
		return;
	}

	let seleccionados = [];
	try {
		seleccionados = JSON.parse(row.vigilantes_json || "[]");
	} catch (e) {
		seleccionados = [];
	}
	const seleccionadosSet = new Set(seleccionados);

	frappe.call({
		method: "sigos.api.get_vigilantes_do_projecto",
		args: { project: frm.doc.name },
		freeze: true,
		freeze_message: __("A carregar vigilantes…"),
	}).then((r) => {
		const vigilantes = r.message || [];
		_psi_mostrar_dialogo(frm, cdt, cdn, vigilantes, seleccionadosSet, row.salary_component);
	});
}

function _psi_mostrar_dialogo(frm, cdt, cdn, vigilantes, seleccionadosSet, salary_component) {
	const linha = (v) => `
		<label class="psi-linha" data-vigilante="${frappe.utils.escape_html(v.name)}">
			<input type="checkbox" class="psi-check" ${seleccionadosSet.has(v.name) ? "checked" : ""}>
			<div class="psi-info">
				<span class="psi-nome">${frappe.utils.escape_html(v.nome_completo || v.name)}</span>
				<span class="psi-meta">${frappe.utils.escape_html(
					[v.posto_de_vigilancia, v.categoria, v.regime_do_vigilante].filter(Boolean).join(" · ")
				)}</span>
			</div>
		</label>`;

	const corpo = `
		<div class="psi-gestor">
			<style>
				.psi-gestor { display: flex; flex-direction: column; gap: 10px; }
				.psi-toolbar { display: flex; align-items: center; gap: 8px; }
				.psi-toolbar input[type="text"] {
					flex: 1; padding: 6px 10px; border: 1px solid var(--border-color, #d1d8dd);
					border-radius: 6px; font-size: 13px;
				}
				.psi-contador { font-size: 12px; color: var(--text-muted, #8d99a6); white-space: nowrap; }
				.psi-lista {
					max-height: 340px; overflow-y: auto; border: 1px solid var(--border-color, #d1d8dd);
					border-radius: 8px;
				}
				.psi-linha {
					display: flex; align-items: center; gap: 10px; padding: 7px 12px;
					border-bottom: 1px solid var(--border-color, #ecf0f2); cursor: pointer; margin: 0;
				}
				.psi-linha:last-child { border-bottom: none; }
				.psi-linha:hover { background: var(--fg-hover-color, #f5f7f9); }
				.psi-linha input { flex-shrink: 0; }
				.psi-info { display: flex; flex-direction: column; min-width: 0; }
				.psi-nome { font-size: 13px; font-weight: 500; }
				.psi-meta { font-size: 11px; color: var(--text-muted, #8d99a6); }
				.psi-vazio { padding: 24px; text-align: center; color: var(--text-muted, #8d99a6); font-size: 13px; }
			</style>
			<div class="psi-toolbar">
				<input type="text" class="psi-busca" placeholder="${__("Procurar por nome, posto, categoria…")}">
				<a href="#" class="psi-todos">${__("Seleccionar Todos")}</a>
				<a href="#" class="psi-nenhum">${__("Limpar")}</a>
			</div>
			<div class="psi-contador"></div>
			<div class="psi-lista">
				${vigilantes.length ? vigilantes.map(linha).join("") : `<div class="psi-vazio">${__("Nenhum vigilante activo neste projecto.")}</div>`}
			</div>
		</div>`;

	const d = new frappe.ui.Dialog({
		title: __("Gerir Beneficiários — {0}", [salary_component]),
		size: "large",
		fields: [{ fieldtype: "HTML", options: corpo }],
		primary_action_label: __("Guardar"),
		primary_action() {
			const seleccionados = [];
			d.$wrapper.find(".psi-linha").each(function () {
				if ($(this).find(".psi-check").is(":checked")) {
					seleccionados.push($(this).attr("data-vigilante"));
				}
			});
			frappe.model.set_value(cdt, cdn, "vigilantes_json", JSON.stringify(seleccionados));
			frappe.model.set_value(
				cdt, cdn, "resumo_beneficiarios",
				seleccionados.length
					? __("{0} vigilante(s) seleccionado(s)", [seleccionados.length])
					: __("Nenhum seleccionado")
			);
			frm.refresh_field("custom_subsidios");
			d.hide();
		},
	});

	const $wrapper = d.$wrapper;
	const atualizarContador = () => {
		const total = $wrapper.find(".psi-linha:visible").length;
		const marcados = $wrapper.find(".psi-linha:visible .psi-check:checked").length;
		$wrapper.find(".psi-contador").text(__("{0} de {1} seleccionado(s)", [marcados, total]));
	};

	$wrapper.on("input", ".psi-busca", function () {
		const termo = $(this).val().toLowerCase();
		$wrapper.find(".psi-linha").each(function () {
			const texto = $(this).text().toLowerCase();
			$(this).toggle(texto.includes(termo));
		});
		atualizarContador();
	});
	$wrapper.on("click", ".psi-todos", (e) => {
		e.preventDefault();
		$wrapper.find(".psi-linha:visible .psi-check").prop("checked", true);
		atualizarContador();
	});
	$wrapper.on("click", ".psi-nenhum", (e) => {
		e.preventDefault();
		$wrapper.find(".psi-linha:visible .psi-check").prop("checked", false);
		atualizarContador();
	});
	$wrapper.on("change", ".psi-check", atualizarContador);

	d.show();
	atualizarContador();
}
