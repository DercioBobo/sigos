// Calendário de Equipas — company-wide team rotation of one regime (sigos.calendario_equipas).
// The form shows the next 14 days per team; "Aplicar às Escalas" previews then re-saves
// every escala of the regime.
frappe.ui.form.on("Calendario De Equipas", {
	refresh(frm) {
		_cal_css();
		_cal_previsao(frm);
		if (frm.is_new() || !frm.doc.activo) return;
		if (frappe.user.has_role(["System Manager", "SIGOS Manager", "Aprovador Operações"])) {
			frm.add_custom_button(__("Aplicar às Escalas"), () => _cal_aplicar(frm)).addClass("btn-primary");
			// Escalas already applied with wrong teams: re-derive every team from a past
			// day whose rows still show each guard's real rhythm (default: yesterday).
			frm.add_custom_button(__("Rectificar pela Escala de um Dia"), () => frappe.prompt(
				[{ fieldname: "data", fieldtype: "Date", label: __("Dia em que a escala estava correcta"), reqd: 1,
					default: frappe.datetime.add_days(frappe.datetime.get_today(), -1) }],
				(v) => _cal_aplicar(frm, v.data), __("Rectificar Equipas"), __("Pré-visualizar")));
		}
		frm.add_custom_button(__("Escalas do Regime"),
			() => frappe.set_route("List", "Escala Do Vigilante", { regime_do_vigilante: frm.doc.regime }));
	},
	regime(frm) {
		if (!frm.doc.regime || (frm.doc.equipas || []).length) return;
		// Seed one row per active team, spread over the regime's working turnos.
		Promise.all([
			frappe.xcall("sigos.api.get_regime_turnos", { regime: frm.doc.regime }),
			frappe.db.get_list("Turno Da Equipa", { filters: { activo: 1 }, fields: ["name"], order_by: "name asc", limit: 0 }),
		]).then(([seq, eqs]) => {
			seq = seq || [];
			if (!seq.length || !eqs.length) return;
			const passo = Math.max(1, Math.floor(seq.length / eqs.length));
			eqs.slice(0, seq.length).forEach((e, i) => {
				const r = frm.add_child("equipas");
				r.turno_equipa = e.name;
				r.turno = seq[(i * passo) % seq.length].turno;
			});
			frm.refresh_field("equipas");
		});
	},
});

function _cal_previsao(frm) {
	const $w = frm.fields_dict.previsao.$wrapper;
	if (frm.is_new() || !frm.doc.activo) {
		$w.html(`<div class="text-muted small">${__("Grave o calendário para ver os próximos dias.")}</div>`);
		return;
	}
	frm.call("previsao", { dias: 14 }).then((r) => {
		const p = r.message;
		if (!p) { $w.html(""); return; }
		const esc = frappe.utils.escape_html;
		const hoje = frappe.datetime.get_today();
		const DS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
		const cab = p.datas.map((d) => {
			const o = frappe.datetime.str_to_obj(d);
			return `<th class="${d === hoje ? "hoje" : ""}"><b>${o.getDate()}</b><span>${DS[o.getDay()]}</span></th>`;
		}).join("");
		const linhas = p.equipas.map((e) => `<tr><th class="eq">${esc(e.equipa)}</th>${e.dias.map((t, i) =>
			`<td class="${t.e_folga ? "folga" : (t.periodo === "Noite" ? "noite" : "dia")} ${p.datas[i] === hoje ? "hoje" : ""}">${esc(t.turno)}</td>`).join("")}</tr>`).join("");
		$w.html(`<div class="cal-prev"><table><thead><tr><th></th>${cab}</tr></thead><tbody>${linhas}</tbody></table></div>`);
	});
}

function _cal_aplicar(frm, rectificar_desde) {
	if (frm.is_dirty()) { frappe.msgprint(__("Grave o calendário primeiro.")); return; }
	const args = rectificar_desde ? { rectificar_desde } : {};
	frm.call("pre_visualizar", args).then((r) => {
		const p = r.message || { escalas: [] };
		const esc = frappe.utils.escape_html;
		const total = p.escalas.reduce((t, e) => t + e.mudancas.length, 0);
		const corpo = p.escalas.length ? p.escalas.map((e) => `
			<div class="cal-ap-esc">
				<div class="cal-ap-h"><b>${esc(e.posto || e.escala)}</b> <span class="text-muted">${esc(e.escala)} · ${e.vigilantes} ${__("vigilante(s)")}</span>
					${e.ajuste ? `<span class="cal-ap-aj">${__("ajuste {0} dia(s)", [e.ajuste])}</span>` : ""}
					${e.mudancas.length ? `<span class="cal-ap-n">${e.mudancas.length} ${__("muda(m) hoje")}</span>` : `<span class="cal-ap-ok">${__("sem mudanças hoje")}</span>`}</div>
				${e.mudancas.length ? `<table class="cal-ap-t">${e.mudancas.map((m) => `<tr>
					<td>${esc(m.nome || m.vigilante)}</td><td>${esc(m.equipa)}</td>
					<td class="text-muted">${esc(m.turno_antes || "—")}</td><td>&rarr;</td><td><b>${esc(m.turno_depois)}</b></td></tr>`).join("")}</table>` : ""}
			</div>`).join("") : `<div class="text-muted">${__("Nenhuma escala activa neste regime.")}</div>`;
		const d = new frappe.ui.Dialog({
			title: __("Aplicar às Escalas — {0}", [frm.doc.regime]),
			size: "large",
			fields: [{ fieldtype: "HTML", fieldname: "b" }],
			primary_action_label: __("Aplicar"),
			primary_action() {
				d.hide();
				frappe.dom.freeze(__("A actualizar escalas…"));
				frm.call("aplicar", args).then((x) => {
					const res = x.message || {};
					frappe.msgprint({
						title: __("Calendário aplicado"),
						indicator: (res.erros || []).length ? "orange" : "green",
						message: __("{0} escala(s) actualizada(s).", [(res.aplicadas || []).length]) +
							((res.erros || []).length ? "<br><br>" + res.erros.map((e) => `<b>${esc(e.escala)}</b>: ${esc(e.erro)}`).join("<br>") : ""),
					});
				}).always(() => frappe.dom.unfreeze());
			},
		});
		d.fields_dict.b.$wrapper.html(`<div class="cal-ap">
			<p>${__("Rectificação: <b>{0}</b> vigilante(s) passam hoje para o turno da sua equipa. Dias já editados à mão mantêm-se.", [total])}</p>${corpo}</div>`);
		d.show();
	});
}

function _cal_css() {
	if (document.getElementById("sigos-cal-css")) return;
	const css = `
.cal-prev { overflow-x:auto; border:1px solid var(--border-color); border-radius:10px; }
.cal-prev table { border-collapse:collapse; width:100%; font-size:12px; }
.cal-prev th, .cal-prev td { padding:6px 8px; text-align:center; border-bottom:1px solid var(--border-color); white-space:nowrap; }
.cal-prev thead th b { display:block; font-size:14px; } .cal-prev thead th span { color:var(--text-muted); font-size:10.5px; text-transform:uppercase; }
.cal-prev th.eq { text-align:left; font-weight:600; }
.cal-prev td.dia { background:rgba(245,158,11,.10); } .cal-prev td.noite { background:rgba(79,70,229,.10); }
.cal-prev td.folga { color:var(--text-muted); font-style:italic; }
.cal-prev .hoje { box-shadow:inset 0 0 0 2px rgba(79,70,229,.55); }
.cal-ap-esc { border:1px solid var(--border-color); border-radius:10px; padding:10px 12px; margin-top:8px; }
.cal-ap-h { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.cal-ap-n { margin-left:auto; color:#B45309; font-weight:600; font-size:12px; } .cal-ap-ok { margin-left:auto; color:#15803D; font-size:12px; }
.cal-ap-aj { font-size:11px; background:rgba(245,158,11,.15); color:#B45309; border-radius:99px; padding:1px 8px; }
.cal-ap-t { width:100%; margin-top:6px; font-size:12px; } .cal-ap-t td { padding:3px 6px; border-top:1px solid var(--border-color); }
`;
	$(`<style id="sigos-cal-css">${css}</style>`).appendTo("head");
}
