// sigos.project_subsidios — "Gerir Subsídios" matrix modal for Project.
//
// The custom_subsidios child table only ever defines WHAT subsídios exist on a
// contract and at what rate (salary_component + amount) — it no longer decides
// WHO gets them, or how much each of them gets. That's this modal's job: a full
// vigilante × subsídio matrix, click a cell to grant/revoke, with row/column
// bulk toggles and a live search, so HR can go from "nobody" to "just these 12
// of 200" to "everyone" in a few clicks. Each checked cell also carries an
// optional valor override — blank uses the component's project-wide rate
// (shown under the column header), a typed value replaces it for just that
// vigilante — for the projects where not everyone is paid the same amount of
// a given subsídio. Saved as a full-replace via sigos.api.salvar_project_subsidio_matrix.

frappe.provide("sigos.project_subsidios");

sigos.project_subsidios.abrir_matriz = function (frm) {
	if (frm.is_new() || !frm.doc.name) {
		frappe.msgprint(__("Grave o Projecto antes de gerir os subsídios."));
		return;
	}
	if (!(frm.doc.custom_subsidios || []).length) {
		frappe.msgprint(__(
			"Adicione pelo menos um Subsídio (componente + valor) na tabela antes de gerir os beneficiários."
		));
		return;
	}

	frappe.call({
		method: "sigos.api.get_project_subsidio_matrix",
		args: { project: frm.doc.name },
		freeze: true,
		freeze_message: __("A carregar matriz de subsídios…"),
	}).then((r) => {
		_psm_mostrar(frm, r.message || {});
	});
};

function _psm_mostrar(frm, dados) {
	const componentes = dados.componentes || [];
	const vigilantes = dados.vigilantes || [];
	const activos = new Set(dados.aplicacoes || []);
	const overrides = dados.overrides || {};
	const chave = (vig, comp) => `${vig}::${comp}`;

	if (!vigilantes.length) {
		frappe.msgprint(__("Nenhum vigilante Activo neste projecto ainda."));
		return;
	}

	const fmt = (v) => format_currency(v);

	const cabecalhoColunas = componentes.map((c) => `
		<th class="psm-col" data-comp="${frappe.utils.escape_html(c.salary_component)}">
			<div class="psm-col-inner">
				<span class="psm-col-nome">${frappe.utils.escape_html(c.salary_component)}</span>
				<span class="psm-col-valor">${fmt(c.amount)}</span>
				<span class="psm-col-toggle" title="${__("Marcar/desmarcar toda a coluna")}">✓</span>
			</div>
		</th>`).join("");

	const linhas = vigilantes.map((v) => {
		const celulas = componentes.map((c) => {
			const k = chave(v.name, c.salary_component);
			const on = activos.has(k);
			const override = overrides[k];
			return `<td class="psm-cell ${on ? "on" : ""}"
				data-vig="${frappe.utils.escape_html(v.name)}"
				data-comp="${frappe.utils.escape_html(c.salary_component)}">
				<span class="psm-mark">${on ? "✓" : ""}</span>
				<input type="number" step="0.01" class="psm-override" placeholder="${fmt(c.amount)}"
					value="${override != null ? override : ""}" ${on ? "" : "disabled"}
					title="${__("Valor de excepção para este vigilante — vazio usa o valor padrão do componente.")}">
			</td>`;
		}).join("");

		return `
			<tr class="psm-row" data-vig="${frappe.utils.escape_html(v.name)}">
				<th class="psm-row-head">
					<span class="psm-row-toggle" title="${__("Marcar/desmarcar toda a linha")}">✓</span>
					<div class="psm-row-info">
						<span class="psm-row-nome">${frappe.utils.escape_html(v.nome_completo || v.name)}</span>
						<span class="psm-row-meta">${frappe.utils.escape_html(
							[v.posto_de_vigilancia, v.categoria, v.regime_do_vigilante].filter(Boolean).join(" · ")
						)}</span>
					</div>
				</th>
				${celulas}
			</tr>`;
	}).join("");

	const corpo = `
		<div class="psm-wrap">
			<style>
				.psm-wrap { display: flex; flex-direction: column; gap: 10px; }
				.psm-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
				.psm-toolbar input[type="text"] {
					flex: 1; min-width: 180px; padding: 6px 10px;
					border: 1px solid var(--border-color, #d1d8dd); border-radius: 6px; font-size: 13px;
				}
				.psm-toolbar a { font-size: 12px; white-space: nowrap; }
				.psm-contador { font-size: 12px; color: var(--text-muted, #8d99a6); white-space: nowrap; margin-left: auto; }
				.psm-scroll {
					max-height: 60vh; overflow: auto; border: 1px solid var(--border-color, #d1d8dd);
					border-radius: 8px;
				}
				.psm-table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 11.5px; }
				.psm-table thead th {
					position: sticky; top: 0; z-index: 2; background: var(--fg-color, #fff);
					border-bottom: 1px solid var(--border-color, #d1d8dd); padding: 8px 10px; text-align: center;
					font-weight: 500;
				}
				.psm-table thead th.psm-col:first-child { }
				.psm-col-inner { display: flex; flex-direction: column; align-items: center; gap: 2px; cursor: pointer; }
				.psm-col-nome { font-weight: 600; white-space: nowrap; }
				.psm-col-valor { color: var(--text-muted, #8d99a6); font-size: 11px; }
				.psm-col-toggle, .psm-row-toggle {
					color: var(--text-muted, #8d99a6); font-size: 18px; line-height: 1; cursor: pointer; opacity: .55;
				}
				.psm-col-toggle:hover, .psm-row-toggle:hover { opacity: 1; color: var(--primary, #5e64ff); }
				.psm-row-head {
					position: sticky; left: 0; z-index: 1; background: var(--fg-color, #fff);
					border-right: 1px solid var(--border-color, #d1d8dd);
					border-bottom: 1px solid var(--border-color, #ecf0f2);
					padding: 6px 10px; text-align: left; white-space: nowrap;
					display: flex; align-items: center; gap: 8px;
				}
				.psm-row-info { display: flex; flex-direction: column; min-width: 0; }
				.psm-row-nome { font-weight: 500; }
				.psm-row-meta { font-size: 10.5px; color: var(--text-muted, #8d99a6); }
				.psm-table tbody td.psm-cell {
					border-bottom: 1px solid var(--border-color, #ecf0f2);
					border-right: 1px solid var(--border-color, #f3f5f6);
					text-align: center; cursor: pointer; width: 90px; min-height: 34px; padding: 4px 0;
					transition: background-color .12s ease;
				}
				.psm-cell:hover { background: var(--fg-hover-color, #f5f7f9); }
				.psm-cell.on { background: rgba(94, 100, 255, .12); }
				.psm-cell.on .psm-mark { color: var(--primary, #5e64ff); font-weight: 700; }
				.psm-cell .psm-override {
					display: none; width: 76px; margin: 2px auto 0; padding: 1px 4px;
					font-size: 11px; text-align: center; border: 1px solid var(--border-color, #d1d8dd);
					border-radius: 4px; cursor: text; background: var(--fg-color, #fff);
				}
				.psm-cell.on .psm-override { display: inline-block; }
				.psm-cell .psm-override:focus { outline: none; border-color: var(--primary, #5e64ff); }
				.psm-row.psm-hidden { display: none; }
			</style>
			<div class="psm-toolbar">
				<input type="text" class="psm-busca" placeholder="${__("Procurar por nome, posto, categoria…")}">
				<a href="#" class="psm-todos">${__("Marcar Tudo")}</a>
				<a href="#" class="psm-nenhum">${__("Limpar Tudo")}</a>
				<span class="psm-contador"></span>
			</div>
			<div class="psm-scroll">
				<table class="psm-table">
					<thead>
						<tr>
							<th class="psm-row-head" style="text-align:left;">${__("Vigilante")}</th>
							${cabecalhoColunas}
						</tr>
					</thead>
					<tbody>
						${linhas}
					</tbody>
				</table>
			</div>
		</div>`;

	const d = new frappe.ui.Dialog({
		title: __("Gerir Subsídios — {0}", [frm.doc.project_name || frm.doc.name]),
		size: "extra-large",
		fields: [{ fieldtype: "HTML", options: corpo }],
		primary_action_label: __("Guardar"),
		primary_action() {
			const pares = [];
			const overrides = {};
			d.$wrapper.find("td.psm-cell.on").each(function () {
				const par = `${$(this).attr("data-vig")}::${$(this).attr("data-comp")}`;
				pares.push(par);
				const valor = $(this).find(".psm-override").val();
				if (valor !== "" && valor != null) overrides[par] = flt(valor);
			});
			frappe.call({
				method: "sigos.api.salvar_project_subsidio_matrix",
				args: { project: frm.doc.name, pares: JSON.stringify(pares), overrides: JSON.stringify(overrides) },
				freeze: true,
				freeze_message: __("A guardar…"),
			}).then(() => d.hide());
		},
	});

	const $w = d.$wrapper;

	const atualizarContador = () => {
		const total = $w.find("td.psm-cell").length;
		const marcadas = $w.find("td.psm-cell.on").length;
		$w.find(".psm-contador").text(__("{0} de {1} atribuições marcadas", [marcadas, total]));
	};

	// Keep class, mark, and the override input's disabled state in lockstep —
	// the input must never be editable (or tab-focusable) while its cell is off,
	// even though the CSS already hides it, so a stray value can't sneak into
	// the save from a cell nobody meant to check.
	const _setCells = (cells, on) => {
		cells.toggleClass("on", on)
			.find(".psm-mark").text(on ? "✓" : "").end()
			.find(".psm-override").prop("disabled", !on);
	};

	$w.on("click", "td.psm-cell", function (e) {
		if ($(e.target).is(".psm-override")) return;   // typing/clicking the value field must not toggle
		_setCells($(this), !$(this).hasClass("on"));
		atualizarContador();
	});

	$w.on("click", ".psm-col-toggle", function (e) {
		e.stopPropagation();
		const comp = $(this).closest("th").attr("data-comp");
		const col = $w.find(`td.psm-cell[data-comp="${CSS.escape(comp)}"]:not(.psm-hidden-col)`)
			.filter((_, td) => $(td).closest("tr").is(":visible"));
		const todasLigadas = col.length && col.filter(".on").length === col.length;
		_setCells(col, !todasLigadas);
		atualizarContador();
	});

	$w.on("click", ".psm-row-toggle", function (e) {
		e.stopPropagation();
		const row = $(this).closest("tr");
		const celulas = row.find("td.psm-cell");
		const todasLigadas = celulas.length && celulas.filter(".on").length === celulas.length;
		_setCells(celulas, !todasLigadas);
		atualizarContador();
	});

	$w.on("input", ".psm-busca", function () {
		const termo = $(this).val().toLowerCase();
		$w.find(".psm-row").each(function () {
			const texto = $(this).find(".psm-row-info").text().toLowerCase();
			$(this).toggleClass("psm-hidden", !texto.includes(termo)).toggle(texto.includes(termo));
		});
	});

	$w.on("click", ".psm-todos", (e) => {
		e.preventDefault();
		_setCells($w.find(".psm-row:visible td.psm-cell"), true);
		atualizarContador();
	});
	$w.on("click", ".psm-nenhum", (e) => {
		e.preventDefault();
		_setCells($w.find(".psm-row:visible td.psm-cell"), false);
		atualizarContador();
	});

	d.show();
	atualizarContador();
}
