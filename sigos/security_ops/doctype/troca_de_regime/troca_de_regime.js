frappe.ui.form.on("Troca De Regime", {

	// Escala migration is handled server-side (on_submit) according to "Acção na Escala":
	// the guard always leaves the old posto+regime escala; whether it joins one in the new
	// regime (create new / allocate existing / none) is the user's choice, suggested below.
	after_submit(frm) {
		frm.reload_doc();
	},

	onload(frm) {
		frm.set_query("vigilante", () => ({
			filters: { status: "Activo" },
		}));
	},

	vigilante(frm) {
		_sugerir_accao_escala(frm);
	},

	novo_regime(frm) {
		_sugerir_accao_escala(frm);
	},
});

// Look at the guard's posto + chosen new regime and steer "Acção na Escala":
//  - posto exists & escala already exists for (posto, novo_regime) → allocate existing / leave
//  - posto exists & no such escala                                 → create new / leave
//  - no posto                                                      → leave (nothing to allocate)
async function _sugerir_accao_escala(frm) {
	const { vigilante, novo_regime } = frm.doc;
	if (!vigilante || !novo_regime) return;

	const vr = await frappe.db.get_value("Vigilante", vigilante, "posto_de_vigilancia");
	const posto = vr && vr.message ? vr.message.posto_de_vigilancia : null;

	let existe = null;
	if (posto) {
		const er = await frappe.db.get_value(
			"Escala Do Vigilante",
			{ posto_de_vigilancia: posto, regime_do_vigilante: novo_regime, estado: ["!=", "Arquivado"] },
			"name"
		);
		existe = er && er.message ? er.message.name : null;
	}

	let opcoes, sugestao, desc;
	if (!posto) {
		opcoes = ["Deixar sem escala"];
		sugestao = "Deixar sem escala";
		desc = __("O vigilante não tem posto — não há escala para alocar.");
	} else if (existe) {
		opcoes = ["Alocar em escala existente", "Deixar sem escala"];
		sugestao = "Alocar em escala existente";
		desc = __("Já existe uma escala para este posto no regime <b>{0}</b> ({1}). Pode alocar o vigilante nela ou deixá-lo sem escala.", [novo_regime, existe]);
	} else {
		opcoes = ["Criar nova escala", "Deixar sem escala"];
		sugestao = "Criar nova escala";
		desc = __("Não existe escala para este posto no regime <b>{0}</b>. Pode criar uma nova ou deixar o vigilante sem escala.", [novo_regime]);
	}

	frm.set_df_property("accao_escala", "options", opcoes.join("\n"));
	frm.set_df_property("accao_escala", "description", desc);
	if (!frm.doc.accao_escala || !opcoes.includes(frm.doc.accao_escala)) {
		frm.set_value("accao_escala", sugestao);
	}
}
