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
	const trabalho = [];        // base weights of WORKING shifts, in order (for the de-dup example)
	const dedup = !!frm.doc.faltas_consecutivas_contam_um;

	if (frm.doc.tipo_ciclo === "Rotativo") {
		let idx = 0;
		for (let i = 0; i < 7; i++) {
			const data = frappe.datetime.add_days(hoje, i);
			const t = turnos[idx % turnos.length];
			rows.push(`<tr>
				<td>${data}</td>
				<td>${t.turno || "—"}</td>
				<td>${t.periodo || "—"}</td>
				<td>${t.e_folga ? "✓ Folga" : ""}</td>
				<td>${t.n_de_faltas || 0}</td>
			</tr>`);
			if (!t.e_folga) trabalho.push(Number(t.n_de_faltas) || 0);
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
				<td>${t.turno || "—"}</td>
				<td>${t.periodo || "—"}</td>
				<td></td>
				<td>${t.n_de_faltas || 0}</td>
			</tr>`);
			trabalho.push(Number(t.n_de_faltas) || 0);
			dia_util++;
			if (frm.doc.tipo_ciclo === "Dias Úteis Alternado" && dia_util >= dias_grupo) {
				dia_util = 0;
				grupo_idx++;
			}
		}
	}

	let nota = "";
	if (dedup && trabalho.length) {
		const base_total = trabalho.reduce((s, n) => s + n, 0);
		const dedup_total = trabalho[0] + (trabalho.length - 1);   // 1º conta o peso; restantes contam 1
		nota = `<div class="alert alert-info" style="margin:10px 0 0;font-size:.9em">
			<b>${__("Faltas em turnos consecutivos contam 1")}</b> — ${__("activo neste regime.")}<br>
			${__("Exemplo: faltando os {0} turnos de trabalho acima de forma seguida, contaria <b>{1}</b> (o 1º turno conta {2}, cada seguinte conta 1), em vez de <b>{3}</b>.",
				[trabalho.length, dedup_total, trabalho[0], base_total])}
		</div>`;
	} else {
		nota = `<div class="text-muted" style="margin:10px 0 0;font-size:.85em">
			${__("‘Faltas em turnos consecutivos contam 1’ está desligado — cada turno conta o seu peso (Nº Faltas).")}
		</div>`;
	}

	frappe.msgprint({
		title: __("Pré-visualização — primeiros 7 dias"),
		message: `
			<table class="table table-sm table-bordered">
				<thead><tr>
					<th>Data</th><th>Turno</th><th>Período</th><th>Folga</th><th>Nº Faltas</th>
				</tr></thead>
				<tbody>${rows.join("")}</tbody>
			</table>${nota}`,
		wide: true,
	});
}
