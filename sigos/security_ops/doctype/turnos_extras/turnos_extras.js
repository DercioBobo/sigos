frappe.ui.form.on("Turnos Extras", {

	onload(frm) {
		_setup_queries(frm);
	},

	refresh(frm) {
		_setup_queries(frm);
	},

	delegacao(frm) {
		frm.set_value("posto", "");
		frm.set_value("vigilante", "");
		frm.set_query("posto", () => ({
			filters: { delegacao: frm.doc.delegacao },
		}));
		_atualizar_vigilante_query(frm);
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
		if (!frm.doc.data) { frm._turex_folga = null; _atualizar_vigilante_query(frm); return; }
		frappe.call({
			method: "sigos.api.get_vigilantes_on_folga",
			args: { data: frm.doc.data },
			callback(r) {
				const em_folga = (r.message || []).map(v => v.vigilante);
				frm._turex_folga = em_folga;
				_atualizar_vigilante_query(frm);
				if (em_folga.length) {
					frappe.show_alert({
						message: __(`${em_folga.length} vigilante(s) de folga nesta data.`),
						indicator: "blue",
					}, 4);
				} else {
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
	_atualizar_vigilante_query(frm);
	_atualizar_turno_query(frm);
}

// Vigilante picker: always scoped to the chosen delegação (when set), further
// narrowed to the day's folga list once Data is picked. Kept as one function so
// neither condition silently drops the other (frm.set_query fully replaces
// whatever query was there before, so composing them has to happen here).
function _atualizar_vigilante_query(frm) {
	const deleg = frm.doc.delegacao;
	const folga = frm._turex_folga;
	frm.set_query("vigilante", () => {
		const filters = [];
		if (deleg) filters.push(["Vigilante", "delegacao", "=", deleg]);
		if (folga) filters.push(["Vigilante", "name", "in", folga]);
		return { filters };
	});
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
