// Live guard rails on the behaviour flags — grey out incompatible checkboxes so the
// user sees the constraints before saving (mirrors the server-side _validar_comportamento).
frappe.ui.form.on("Operacao De Rotatividade", {
	refresh: _apply,
	muda_posto: _apply,
	muda_regime: _apply,
	demite: _apply,
	enviar_reserva: _apply,
	requer_substituto: _apply,
	de_reserva: _apply,
});

function _apply(frm) {
	const d = frm.doc;

	// ── Auto-correct invalid combos (only fires when something actually changes) ──
	if (d.de_reserva) {
		if (!d.muda_posto) frm.set_value("muda_posto", 1);   // reserve guard must get a posto
		if (d.demite) frm.set_value("demite", 0);
		if (d.enviar_reserva) frm.set_value("enviar_reserva", 0);
		if (d.requer_substituto) frm.set_value("requer_substituto", 0);
	}
	if (d.muda_regime && !d.muda_posto) frm.set_value("muda_regime", 0);
	if (d.requer_substituto && !(d.muda_posto || d.enviar_reserva || d.demite)) {
		frm.set_value("requer_substituto", 0);
	}

	// ── Disable (grey out) the now-incompatible flags ──
	const ro = (field, locked) => frm.set_df_property(field, "read_only", locked ? 1 : 0);
	ro("muda_posto",        d.enviar_reserva || d.demite || d.de_reserva);
	ro("enviar_reserva",    d.muda_posto || d.demite || d.de_reserva);
	ro("demite",            d.muda_posto || d.enviar_reserva || d.de_reserva);
	ro("de_reserva",        d.enviar_reserva || d.demite);
	ro("muda_regime",       !d.muda_posto);
	ro("requer_substituto", !!d.de_reserva || !(d.muda_posto || d.enviar_reserva || d.demite));
}
