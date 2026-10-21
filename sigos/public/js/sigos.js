// SIGOS - global client utilities

frappe.provide("sigos");

// Load the Barlow Semi Condensed display font once (robust alternative to a CSS @import).
(function () {
	if (document.getElementById("sigos-font")) return;
	const l = document.createElement("link");
	l.id = "sigos-font";
	l.rel = "stylesheet";
	l.href = "https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@500;600;700&display=swap";
	document.head.appendChild(l);
})();

sigos.get_settings = function () {
	return frappe.xcall("frappe.client.get", {
		doctype: "SIGOS Settings",
		name: "SIGOS Settings",
	});
};

/** Returns a promise resolving to a single setting value. */
sigos.setting = function (fieldname) {
	return sigos.get_settings().then((s) => s[fieldname]);
};

/** Style a button inside a form with the danger colour. */
sigos.danger_btn = function (frm, fieldname) {
	const btn = frm.fields_dict[fieldname]?.$input;
	if (btn) btn.addClass("btn-sigos-danger");
};

// Name a contract (Project) after its customer — "Access Bank 01" — instead of PROJ-####.
frappe.ui.form.on("Project", {
	customer(frm) {
		if (!frm.is_new() || !frm.doc.customer || (frm.doc.project_name || "").trim()) return;
		frappe.call({
			method: "sigos.contract_naming.next_contract_name",
			args: { customer: frm.doc.customer },
			callback: (r) => { if (r.message) frm.set_value("project_name", r.message); },
		});
	},
});

// ─── Shared 7-day Escala preview modal (used by Posto and Vigilante) ──────────
// opts: { posto, titulo, dias=7, destacar (vigilante name to highlight), allow_create }
sigos.show_escala_preview = function (opts) {
	const { posto, titulo, dias = 7, destacar = null, allow_create = false } = opts;
	if (!posto) {
		frappe.show_alert({ message: __("Sem posto associado."), indicator: "orange" }, 3);
		return;
	}

	frappe.call({
		method: "sigos.api.get_escala_preview_posto",
		args: { posto, dias },
		freeze: true,
		freeze_message: __("A carregar escala..."),
		callback(r) {
			const escalas = r.message || [];
			let body;

			if (!escalas.length) {
				const criar = allow_create
					? `<a href="/app/escala-do-vigilante/new-escala-do-vigilante-1?posto_de_vigilancia=${encodeURIComponent(posto)}"
						 class="btn btn-primary btn-sm">${__("+ Criar Escala para este Posto")}</a>`
					: `<a href="/app/posto-de-vigilancia/${encodeURIComponent(posto)}" class="btn btn-default btn-sm">${__("Abrir Posto")}</a>`;
				body = `
					<div style="text-align:center;padding:48px 24px">
						<div style="font-size:2.5em;margin-bottom:12px">📅</div>
						<h4 style="margin:0 0 8px;color:#333">${__("Nenhuma escala activa")}</h4>
						<p style="color:#777;margin:0 0 20px">${__("Este posto ainda não tem escala gerada.")}</p>
						${criar}
					</div>`;
			} else {
				body = escalas.map((e) => sigos.render_escala_bloco(e, destacar)).join("");
			}

			new frappe.ui.Dialog({
				title: `📋 ${__("Escala — {0}", [titulo || posto])}`,
				fields: [{ fieldname: "preview", fieldtype: "HTML", options: `<div style="padding:4px 0">${body}</div>` }],
				size: "extra-large",
			}).show();
		},
	});
};

sigos.render_escala_bloco = function (esc, destacar) {
	const ESTADO_STYLE = {
		"Activo":    { bg: "#d1e7dd", fg: "#0f5132", dot: "#198754" },
		"Rascunho":  { bg: "#fff3cd", fg: "#856404", dot: "#ffc107" },
		"Arquivado": { bg: "#e2e3e5", fg: "#41464b", dot: "#adb5bd" },
	};
	const es = ESTADO_STYLE[esc.estado] || ESTADO_STYLE["Rascunho"];
	const DIAS_PT  = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
	const hoje_str = frappe.datetime.get_today();
	const PERIODO_COLOR = {
		"Manhã": { bg: "#4a90d9" },
		"Noite": { bg: "#2c3e57" },
		"Tarde": { bg: "#e8a020" },
		"":      { bg: "#adb5bd" },
	};

	const gerado_info = esc.gerado_ate
		? `<span style="color:#888;font-size:.8em">${__("Gerado até")} ${esc.gerado_ate}</span>` : "";

	let html = `
		<div style="margin-bottom:20px;border:1px solid #dee2e6;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.06)">
			<div style="background:#f8f9fa;padding:10px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #dee2e6;flex-wrap:wrap">
				<span style="display:inline-flex;align-items:center;gap:5px;background:${es.bg};color:${es.fg};padding:3px 12px;border-radius:20px;font-size:.8em;font-weight:600">
					<span style="width:7px;height:7px;border-radius:50%;background:${es.dot};display:inline-block"></span>${esc.estado}
				</span>
				<span style="font-weight:600;color:#333;font-size:.95em">Regime: ${esc.regime}</span>
				${gerado_info}
				<a href="/app/escala-do-vigilante/${esc.name}" target="_blank"
				   style="margin-left:auto;font-size:.85em;color:#1565C0;text-decoration:none;white-space:nowrap;font-weight:500">
					${__("Ver Escala Completa")} →
				</a>
			</div>`;

	if (!esc.guards.length) {
		html += `<div style="padding:20px;text-align:center;color:#888;font-size:.9em">${__("Nenhum vigilante na escala")}</div>`;
	} else {
		const day_headers = esc.days.map((d) => {
			const dt = new Date(d + "T00:00:00");
			const isHj = d === hoje_str;
			return `<th style="min-width:72px;padding:5px 2px;text-align:center;background:${isHj ? "#fff3cd" : "#f4f5f6"};border:1px solid #e8ebed;${isHj ? "box-shadow:inset 0 -2px 0 #e8a020" : ""}">
				<div style="font-size:9px;color:#999;line-height:1;font-weight:500">${DIAS_PT[dt.getDay()]}</div>
				<div style="font-weight:700;font-size:.95em;line-height:1.5;color:${isHj ? "#856404" : "#333"}">${dt.getDate()}</div>
			</th>`;
		}).join("");

		html += `<div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%;font-size:.82em">
			<thead><tr>
				<th style="min-width:150px;max-width:180px;padding:6px 12px;text-align:left;background:#f4f5f6;border:1px solid #e8ebed;position:sticky;left:0;z-index:2;color:#555;font-weight:600">${__("Vigilante")}</th>
				${day_headers}
			</tr></thead><tbody>`;

		for (const g of esc.guards) {
			const hl = destacar && g.name === destacar;
			const nameBg = hl ? "#eaf2fb" : "#fff";
			const nameStyle = hl ? "font-weight:700;color:#1a3a5c;box-shadow:inset 3px 0 0 #1a3a5c" : "font-weight:500";
			const cells = g.dias.map((dia) => {
				if (!dia) return `<td style="border:1px solid #e8ebed;background:${hl ? "#f4f8fd" : "#fafbfc"};height:30px"></td>`;
				const pc = PERIODO_COLOR[dia.periodo] || PERIODO_COLOR[""];
				const ring = dia.override ? "box-shadow:inset 0 0 0 2px #e05c5c;" : "";
				return `<td style="border:1px solid #e8ebed;height:30px;padding:2px;${hl ? "background:#f4f8fd;" : ""}${ring}">
					<div style="background:${pc.bg};color:#fff;border-radius:3px;height:100%;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:10px;padding:0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${frappe.utils.escape_html(dia.turno)}">${frappe.utils.escape_html(dia.turno)}</div>
				</td>`;
			}).join("");
			html += `<tr>
				<td style="padding:4px 12px;border:1px solid #e8ebed;background:${nameBg};position:sticky;left:0;z-index:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;${nameStyle}" title="${g.nome}">
					${hl ? "▶ " : ""}${g.nome}
				</td>${cells}
			</tr>`;
		}
		html += `</tbody></table></div>`;
	}

	html += `
		<div style="padding:8px 14px;background:#fafbfc;border-top:1px solid #f0f1f3;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
			<span style="font-size:.75em;color:#888;margin-right:4px">${__("Legenda")}:</span>
			${[["#4a90d9","Manhã"],["#2c3e57","Noite"],["#e8a020","Tarde"],["#adb5bd","Folga"]].map(([c, l]) =>
				`<span style="background:${c};color:#fff;padding:2px 10px;border-radius:10px;font-size:.75em;font-weight:600">${l}</span>`
			).join("")}
			<span style="border:2px solid #e05c5c;border-radius:3px;padding:1px 8px;font-size:.75em;color:#e05c5c;font-weight:600">${__("Override")}</span>
		</div>
	</div>`;
	return html;
};

// "Faturar Mês" (Customer / Project forms): pick the month — proposed from the
// customer's billing profile (previous / current / next month) — then open the
// customer's Faturação Mensal run already previewed. Runs are per customer.
sigos.faturar_mes = function (cliente) {
	if (!cliente) {
		frappe.msgprint(__("Defina primeiro o Cliente."));
		return;
	}
	frappe.xcall("sigos.perfil_faturacao.mes_proposto", { cliente })
		.then((p) => _sigos_faturar_mes_dialog(cliente, p || {}),
			() => _sigos_faturar_mes_dialog(cliente, {}));
};

function _sigos_faturar_mes_dialog(cliente, p) {
	const mes = p.mes || frappe.datetime.get_today();
	const nome_mes = (data) => {
		const d = frappe.datetime.str_to_obj(data);
		const t = d.toLocaleDateString(frappe.boot.lang || "pt", { month: "long", year: "numeric" });
		return t.charAt(0).toUpperCase() + t.slice(1);
	};
	const regra = { "Mês Anterior": __("o mês anterior"), "Mês Seguinte": __("o mês seguinte") }[p.mes_faturado]
		|| __("o próprio mês");
	const d = new frappe.ui.Dialog({
		title: __("Faturar Mês — {0}", [cliente]),
		fields: [
			{
				fieldname: "mes_referencia",
				fieldtype: "Date",
				label: __("Mês de Referência"),
				reqd: 1,
				default: mes,
				description: p.perfil
					? __("Proposto: {0} — o perfil {1} factura {2}. Inclui todos os contratos deste cliente.",
						[nome_mes(mes), p.perfil, regra])
					: __("Qualquer dia do mês a facturar. Inclui todos os contratos deste cliente."),
			},
		],
		primary_action_label: __("Pré-visualizar"),
		primary_action(vals) {
			d.hide();
			frappe.call({
				method: "sigos.sigos_setup.doctype.faturacao_mensal.faturacao_mensal.faturar_cliente",
				args: { cliente, mes_referencia: vals.mes_referencia },
				freeze: true,
				freeze_message: __("A calcular a facturação…"),
			}).then(r => {
				if (r.message) frappe.set_route("Form", "Faturacao Mensal", r.message);
			});
		},
	});
	d.show();
}

// Invoice print preview (Faturação Mensal, Previsão de Faturação): the Sales
// Invoice default print format, watermarked and NOT printable — only a real Sales
// Invoice is printed. `m` = {html, style, formato} from the server.
sigos.mostrar_previa_fatura = function ($wrapper, m) {
	const marca = __("PRÉ-VISUALIZAÇÃO — NÃO É UMA FACTURA");
	const $f = $(`<iframe style="width:100%;height:70vh;border:1px solid var(--border-color);border-radius:8px;background:#fff"></iframe>`);
	$wrapper.empty().append(
		`<div class="text-muted small" style="margin-bottom:8px">${__("Pré-visualização com o formato {0}. A factura não é criada; para imprimir, gere a factura.",
			[frappe.utils.escape_html(m.formato || "Standard")])}</div>`, $f);
	const doc = $f[0].contentDocument;
	doc.open();
	doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>${m.style || ""}
		.sigos-marca { position:fixed; top:40%; left:0; right:0; text-align:center; transform:rotate(-24deg);
			font:700 40px sans-serif; color:rgba(200,30,30,.16); pointer-events:none; z-index:9999; }
		@media print { body * { display:none !important; } body:after { content:"${marca}"; } }
		</style></head>
		<body oncontextmenu="return false"><div class="sigos-marca">${frappe.utils.escape_html(marca)}</div>
		<div class="print-format-gutter"><div class="print-format">${m.html || ""}</div></div></body></html>`);
	doc.close();
};
