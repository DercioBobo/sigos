frappe.ui.form.on("Ocorrencia", {

	onload(frm) {
		_filtros(frm);
	},

	refresh(frm) {
		_filtros(frm);
		_destaque_gravidade(frm);
		_botoes(frm);
		_botao_participacao(frm);
	},

	delegacao(frm) {
		if (frm.doc.posto) frm.set_value("posto", "");
		if (frm.doc.vigilante) frm.set_value("vigilante", "");
		_filtros(frm);
	},
});

// Scope posto and vigilante pickers to the chosen delegação.
function _filtros(frm) {
	const deleg = frm.doc.delegacao;
	frm.set_query("posto", () => ({ filters: deleg ? { delegacao: deleg } : {} }));
	frm.set_query("vigilante", () => ({ filters: deleg ? { delegacao: deleg } : {} }));
}

// A red/orange headline for the worst incidents so they stand out on the form.
function _destaque_gravidade(frm) {
	if (frm.is_new() || !frm.doc.gravidade) return;
	if (frm.doc.gravidade === "Crítica") {
		frm.dashboard.set_headline(
			`<span class="indicator-pill red">${__("Gravidade Crítica")}</span>`
		);
	} else if (frm.doc.gravidade === "Alta") {
		frm.dashboard.set_headline(
			`<span class="indicator-pill orange">${__("Gravidade Alta")}</span>`
		);
	}
}

// State lifecycle buttons. The server enforces the transitions; these just drive them.
function _botoes(frm) {
	if (frm.is_new() || !frm.perm[0] || !frm.perm[0].write) return;
	const estado = frm.doc.estado;
	const grupo = __("Acções");

	if (estado === "Aberta") {
		frm.add_custom_button(__("Iniciar Investigação"), () => {
			frm.call("investigar").then(() => frm.reload_doc());
		}, grupo);
	}

	if (["Aberta", "Em Investigação"].includes(estado)) {
		frm.add_custom_button(__("Resolver"), () => _dialog_resolver(frm), grupo);
	}

	if (estado === "Resolvida") {
		frm.add_custom_button(__("Fechar Ocorrência"), () => {
			frm.call("fechar").then(() => frm.reload_doc());
		}, grupo);
	}

	if (["Resolvida", "Fechada"].includes(estado)) {
		frm.add_custom_button(__("Reabrir"), () => _dialog_reabrir(frm), grupo);
	}
}

// Once the incident is wrapped up, offer to open (or jump to) the Participação —
// same optional-link pattern as Participação → Processo Disciplinar.
function _botao_participacao(frm) {
	if (frm.is_new() || !["Resolvida", "Fechada"].includes(frm.doc.estado)) return;

	frappe.db.get_value(
		"Participacao", { ocorrencia_referente: frm.doc.name }, "name"
	).then((r) => {
		const existente = r.message && r.message.name;
		if (existente) {
			frm.add_custom_button(__("Ver Participação"), () => {
				frappe.set_route("Form", "Participacao", existente);
			}, __("Acções"));
		} else {
			frm.add_custom_button(__("Abrir Participação"), () => {
				frm.call("criar_participacao").then((res) => {
					if (res.message) frappe.set_route("Form", "Participacao", res.message);
				});
			}, __("Acções"));
		}
	});
}

function _dialog_resolver(frm) {
	const d = new frappe.ui.Dialog({
		title: __("Resolver Ocorrência"),
		fields: [
			{
				fieldname: "accao",
				fieldtype: "Small Text",
				label: __("Acção Tomada"),
				default: frm.doc.accao_tomada || "",
				description: __("Descreva o que foi feito para resolver a ocorrência."),
			},
		],
		primary_action_label: __("Marcar como Resolvida"),
		primary_action(vals) {
			d.hide();
			frm.call("resolver", { accao: vals.accao }).then(() => frm.reload_doc());
		},
	});
	d.show();
}

function _dialog_reabrir(frm) {
	const d = new frappe.ui.Dialog({
		title: __("Reabrir Ocorrência"),
		fields: [
			{
				fieldname: "motivo",
				fieldtype: "Small Text",
				label: __("Motivo da Reabertura"),
			},
		],
		primary_action_label: __("Reabrir"),
		primary_action(vals) {
			d.hide();
			frm.call("reabrir", { motivo: vals.motivo }).then(() => frm.reload_doc());
		},
	});
	d.show();
}
