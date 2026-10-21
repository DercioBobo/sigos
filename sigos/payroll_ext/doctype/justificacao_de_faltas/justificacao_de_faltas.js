frappe.ui.form.on("Justificacao De Faltas", {

	onload(frm) {
		frm.set_query("vigilante", () => ({
			filters: { status: "Activo" }
		}));

		frappe.db.get_single_value("SIGOS Settings", "justificativo_faltas_obrigatorio").then(val => {
			frm.toggle_reqd("justificativo", val === undefined || val === null ? true : !!val);
		});

		// The prazo itself is enforced server-side (_validar_prazo reads SIGOS Settings);
		// here we only surface the configured value so the user knows the rule.
		frappe.db.get_single_value("SIGOS Settings", "prazo_justificacao_faltas").then(val => {
			const prazo = cint(val) || 3;
			frm.set_df_property("data_do_justificativo", "description",
				__("Prazo: até {0} dia(s) após o Dia de Fim da falta.", [prazo]));
		});
	},

	refresh(frm) {
		_jf_buscar_faltas(frm, true);
	},

	dia_de_inicio(frm) {
		_jf_calcular_fim(frm);
		_jf_buscar_faltas(frm);
	},

	dias_a_justificar(frm) {
		_jf_calcular_fim(frm);
		_jf_buscar_faltas(frm);
	},

	dia_de_fim(frm) {
		_jf_buscar_faltas(frm);
	},

	vigilante(frm) {
		_jf_buscar_faltas(frm);
	},

	data_do_justificativo(frm) {
		_jf_buscar_faltas(frm);
	}
});


function _jf_calcular_fim(frm) {
	if (!frm.doc.dia_de_inicio || !frm.doc.dias_a_justificar) return;

	const inicio = frappe.datetime.str_to_obj(frm.doc.dia_de_inicio);
	const dias = frm.doc.dias_a_justificar;

	let fim = new Date(inicio);
	fim.setDate(fim.getDate() + (dias - 1));

	frm.set_value("dia_de_fim", frappe.datetime.obj_to_str(fim));
}


function _jf_buscar_faltas(frm, so_mostrar) {
	if (!frm.doc.dia_de_inicio || !frm.doc.dia_de_fim || !frm.doc.vigilante) return;

	// Set month boundaries based on data_do_justificativo
	if (frm.doc.data_do_justificativo && !so_mostrar) {
		const data = frappe.datetime.str_to_obj(frm.doc.data_do_justificativo);
		const primeiro_dia = new Date(data.getFullYear(), data.getMonth(), 1);
		const ultimo_dia = new Date(data.getFullYear(), data.getMonth() + 1, 0);

		frm.set_value("data_de_inicio", frappe.datetime.obj_to_str(primeiro_dia));
		frm.set_value("data_de_fim", frappe.datetime.obj_to_str(ultimo_dia));
	}

	// numero is the SAME count the server stamps on save (preview_numero →
	// detalhe_faltas), so what is shown matches what is stored.
	frappe.call({
		method: "sigos.payroll_ext.doctype.justificacao_de_faltas.justificacao_de_faltas.preview_numero",
		args: {
			vigilante: frm.doc.vigilante,
			dia_de_inicio: frm.doc.dia_de_inicio,
			dia_de_fim: frm.doc.dia_de_fim,
			name: frm.doc.name,
			data_do_justificativo: frm.doc.data_do_justificativo,
		},
		callback(res) {
			const det = res.message || {};
			_jf_render(frm, det);
			if (so_mostrar) return;
			frm.set_value("numero", det.a_retirar || 0);
			frm.refresh_field("numero");
			// Warn early - the server refuses to save a justification with 0 faltas.
			if (!det.a_retirar) {
				frappe.show_alert({
					message: __("Este vigilante não tem faltas neste período - não é possível guardar."),
					indicator: "orange",
				}, 6);
			}
		},
	});
}


const JF_CSS = `
.jf-box{border:1px solid var(--border-color);border-radius:10px;overflow:hidden}
.jf-head{display:flex;align-items:center;gap:16px;padding:14px 16px;background:var(--subtle-fg)}
.jf-num{font-size:30px;font-weight:700;line-height:1;color:var(--green-600)}
.jf-num.zero{color:var(--text-muted)}
.jf-lbl{font-weight:600}
.jf-sub{color:var(--text-muted);font-size:12px;margin-top:2px}
.jf-tab{width:100%;font-size:12.5px;border-collapse:collapse}
.jf-tab th{color:var(--text-muted);font-weight:500;text-align:left;padding:6px 16px;border-top:1px solid var(--border-color)}
.jf-tab td{padding:6px 16px;border-top:1px solid var(--border-color)}
.jf-tab td.n{text-align:right;font-weight:600}
.jf-tab tr.off td{color:var(--text-muted)}
.jf-tab tr.off td.n{text-decoration:line-through}
.jf-chip{display:inline-block;font-size:11px;padding:1px 7px;border-radius:9px;margin-left:6px;background:var(--bg-gray);color:var(--text-muted)}
.jf-chip.red{background:var(--bg-red);color:var(--red-600)}
`;

function _jf_render(frm, det) {
	const f = frm.get_field("faltas_html");
	if (!f) return;
	if (!document.getElementById("jf-css")) {
		$("<style id='jf-css'>").text(JF_CSS).appendTo("head");
	}
	const esc = frappe.utils.escape_html;
	const linhas = det.linhas || [];
	const n = det.a_retirar || 0;
	let sub = __("Nenhuma falta neste período.");
	if (linhas.length) {
		sub = __("{0} falta(s) no período", [det.total]);
		if (det.ja_justificadas) sub += " · " + __("{0} já justificada(s)", [det.ja_justificadas]);
		if (det.folha) sub += " · " + __("retiradas na folha de {0}", [esc(det.folha.nome)]);
	}
	const rows = linhas.map((l) => {
		const chips = [];
		if (l.subtipo === "Vermelha") chips.push(`<span class="jf-chip red">${__("Vermelha")}</span>`);
		if (l.coberta_por) chips.push(`<span class="jf-chip">${__("Já em {0}", [esc(l.coberta_por)])}</span>`);
		else if (l.ja_descontada) chips.push(`<span class="jf-chip">${__("Já descontada em folha")}</span>`);
		return `<tr class="${l.coberta_por ? "off" : ""}">
			<td>${frappe.datetime.str_to_user(l.data)}</td>
			<td>${esc(l.turno || "")}</td>
			<td>${esc(l.posto || "")}</td>
			<td>${esc(l.tipo || "")}${chips.join("")}</td>
			<td class="n">${l.n}</td>
		</tr>`;
	}).join("");
	f.$wrapper.html(`<div class="jf-box">
		<div class="jf-head">
			<div class="jf-num ${n ? "" : "zero"}">${n}</div>
			<div><div class="jf-lbl">${__("Faltas a retirar")}</div><div class="jf-sub">${sub}</div></div>
		</div>
		${rows ? `<table class="jf-tab"><thead><tr>
			<th>${__("Data")}</th><th>${__("Turno")}</th><th>${__("Posto")}</th><th>${__("Tipo")}</th><th style="text-align:right">${__("Faltas")}</th>
		</tr></thead><tbody>${rows}</tbody></table>` : ""}
	</div>`);
}
