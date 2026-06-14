frappe.ui.form.on("Alocacao De Material", {
	refresh(frm) {
		frm.trigger("_filtros");

		// Returns apply only to submitted allocations with returnable stock still out.
		if (frm.doc.docstatus === 1 && ["Alocado", "Devolvido Parcial"].includes(frm.doc.estado)) {
			frm.add_custom_button(__("Registar Devolução"), () => _dialog_devolucao(frm));
		}
	},

	alocar_a(frm) {
		// Target type drives which materials are valid — clear an incompatible table.
		if ((frm.doc.material_a_alocar || []).length) {
			frm.clear_table("material_a_alocar");
			frm.refresh_field("material_a_alocar");
		}
		// Drop the now-irrelevant destination.
		if (frm.doc.alocar_a === "Posto") {
			frm.set_value("vigilante", "");
		} else {
			frm.set_value("posto", "");
		}
		frm.trigger("_filtros");
	},

	delegacao(frm) {
		if (frm.doc.posto) frm.set_value("posto", "");
		if (frm.doc.vigilante) frm.set_value("vigilante", "");
		frm.trigger("_filtros");
	},

	_filtros(frm) {
		const deleg = frm.doc.delegacao;

		frm.set_query("posto", () => ({ filters: deleg ? { delegacao: deleg } : {} }));
		frm.set_query("vigilante", () => ({ filters: deleg ? { delegacao: deleg } : {} }));

		// Show only materials matching the destination: "Do Vigilante" for a guard,
		// "Do Posto" for a posto (active only).
		frm.set_query("material", "material_a_alocar", () => ({
			filters: {
				ativo: 1,
				tipo_de_material: frm.doc.alocar_a === "Vigilante" ? "Do Vigilante" : "Do Posto",
			},
		}));
	},
});

// ─── Return dialog ────────────────────────────────────────────────────────────
// One numeric input per line that still has material out; calls the controller's
// registar_devolucao with the quantities entered.
function _dialog_devolucao(frm) {
	const pendentes = (frm.doc.material_a_alocar || []).filter(
		(r) => r.retornavel && (r.quantidade || 0) - (r.qtd_devolvida || 0) > 0
	);
	if (!pendentes.length) {
		frappe.msgprint(__("Não há material retornável por devolver."));
		return;
	}

	const fields = pendentes.map((r) => {
		const resta = (r.quantidade || 0) - (r.qtd_devolvida || 0);
		return {
			fieldname: `dev_${r.name}`,
			fieldtype: "Int",
			label: `${r.material} (em posse: ${resta})`,
			default: 0,
			description: __("Máx {0}", [resta]),
		};
	});

	const d = new frappe.ui.Dialog({
		title: __("Registar Devolução"),
		fields,
		primary_action_label: __("Confirmar Devolução"),
		primary_action(vals) {
			const devolucoes = pendentes
				.map((r) => ({ linha: r.name, qtd: vals[`dev_${r.name}`] || 0 }))
				.filter((x) => x.qtd > 0);
			if (!devolucoes.length) {
				frappe.msgprint(__("Indique as quantidades a devolver."));
				return;
			}
			d.hide();
			frm.call("registar_devolucao", { devolucoes }).then(() => frm.reload_doc());
		},
	});
	d.show();
}
