frappe.ui.form.on("Regime", {
	refresh(frm) {
		if (!frm.is_new()) {
			frm.add_custom_button(__("Pré-visualizar Escala (7 dias)"), () => {
				_preview_escala(frm);
			});
		}
	},

	tipo_ciclo(frm) {
		frm.set_df_property("dias_por_grupo", "hidden", frm.doc.tipo_ciclo !== "Dias Úteis Alternado");
	},
});

function _preview_escala(frm) {
	const turnos = frm.doc.turnos || [];
	if (!turnos.length) {
		frappe.msgprint(__("Adicione turnos primeiro."));
		return;
	}

	const hoje = frappe.datetime.get_today();
	const rows = [];

	if (frm.doc.tipo_ciclo === "Rotativo") {
		let idx = 0;
		for (let i = 0; i < 7; i++) {
			const data = frappe.datetime.add_days(hoje, i);
			const t = turnos[idx % turnos.length];
			rows.push(`<tr>
				<td>${data}</td>
				<td>${t.turno_nome}</td>
				<td>${t.periodo || "—"}</td>
				<td>${t.e_folga ? "✓ Folga" : ""}</td>
				<td>${t.n_de_faltas || 0}</td>
			</tr>`);
			idx++;
		}
	} else {
		// Dias Úteis / Alternado
		let dia_util = 0;
		let grupo_idx = 0;
		const dias_grupo = frm.doc.dias_por_grupo || 5;
		const working = turnos.filter(t => !t.e_folga);

		for (let i = 0; i < 7; i++) {
			const data = frappe.datetime.add_days(hoje, i);
			const dow = new Date(data).getDay();
			if (dow === 0 || dow === 6) {
				rows.push(`<tr><td>${data}</td><td colspan="4" class="text-muted">Fim de semana</td></tr>`);
				continue;
			}
			const t = working[grupo_idx % working.length];
			rows.push(`<tr>
				<td>${data}</td>
				<td>${t.turno_nome}</td>
				<td>${t.periodo || "—"}</td>
				<td></td>
				<td>${t.n_de_faltas || 0}</td>
			</tr>`);
			dia_util++;
			if (frm.doc.tipo_ciclo === "Dias Úteis Alternado" && dia_util >= dias_grupo) {
				dia_util = 0;
				grupo_idx++;
			}
		}
	}

	frappe.msgprint({
		title: __("Pré-visualização — primeiros 7 dias"),
		message: `
			<table class="table table-sm table-bordered">
				<thead><tr>
					<th>Data</th><th>Turno</th><th>Período</th><th>Folga</th><th>Nº Faltas</th>
				</tr></thead>
				<tbody>${rows.join("")}</tbody>
			</table>`,
		wide: true,
	});
}
