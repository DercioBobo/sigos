frappe.ui.form.on("Turnos Extras", {

	onload(frm) {
		_setup_queries(frm);
	},

	refresh(frm) {
		_setup_queries(frm);
	},

	delegacao(frm) {
		frm.set_value("posto", "");
		frm.set_query("posto", () => ({
			filters: { delegacao: frm.doc.delegacao },
		}));
	},

	vigilante(frm) {
		// regime auto-fetches via fetch_from, but we also update the turno filter
		frm.set_value("turno", "");
		// Small delay to let fetch_from populate regime first
		setTimeout(() => _atualizar_turno_query(frm), 300);
	},

	regime(frm) {
		frm.set_value("turno", "");
		_atualizar_turno_query(frm);
	},

	data(frm) {
		if (!frm.doc.data) return;
		frappe.call({
			method: "sigos.api.get_vigilantes_on_folga",
			args: { data: frm.doc.data },
			callback(r) {
				const em_folga = (r.message || []).map(v => v.vigilante);
				if (em_folga.length) {
					frm.set_query("vigilante", () => ({
						filters: [["Vigilante", "name", "in", em_folga]],
					}));
					frappe.show_alert({
						message: __(`${em_folga.length} vigilante(s) de folga nesta data.`),
						indicator: "blue",
					}, 4);
				} else {
					frm.set_query("vigilante", () => ({}));
					frappe.show_alert({
						message: __("Nenhum vigilante de folga nesta data."),
						indicator: "orange",
					}, 4);
				}
			},
		});
	},
});

function _setup_queries(frm) {
	frm.set_query("posto", () => ({
		filters: { delegacao: frm.doc.delegacao },
	}));
	_atualizar_turno_query(frm);
}

function _atualizar_turno_query(frm) {
	if (!frm.doc.regime) {
		// No regime selected — show all non-folga turnos
		frm.set_query("turno", () => ({
			filters: [["Turno", "e_folga", "=", 0]],
		}));
		return;
	}

	// Get the turnos that belong to this regime and are not folga
	frappe.call({
		method: "sigos.api.get_regime_turnos",
		args: { regime: frm.doc.regime },
		callback(r) {
			const turnos_do_regime = (r.message || [])
				.filter(t => !t.e_folga)
				.map(t => t.turno);

			if (turnos_do_regime.length) {
				frm.set_query("turno", () => ({
					filters: [["Turno", "name", "in", turnos_do_regime]],
				}));
			} else {
				frm.set_query("turno", () => ({
					filters: [["Turno", "e_folga", "=", 0]],
				}));
			}
		},
	});
}
