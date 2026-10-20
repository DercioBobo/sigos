// Presunção de Abandono — evidence record for the Jurista (sigos.abandono).
// Estado is read-only; these buttons are the only way to move it.
const _PAB_CORES = {
	"Aberta": "red", "Em Análise": "orange", "Encaminhada para Processo": "purple",
	"Regressou": "green", "Concluída": "gray", "Arquivada": "gray",
};

frappe.ui.form.on("Presuncao De Abandono", {
	refresh(frm) {
		if (frm.is_new()) return;
		frm.page.set_indicator(__(frm.doc.estado), _PAB_CORES[frm.doc.estado] || "gray");
		frm.dashboard.set_headline_alert(
			frm.doc.estado === "Aberta"
				? __("Aberta — {0} está fora do posto, com o salário congelado.", [frappe.utils.escape_html(frm.doc.nome_do_vigilante || frm.doc.vigilante)])
				: __("Prova fechada: {0} dia(s) com falta, {1} falta(s), de {2} a {3}.", [
					frm.doc.total_dias || 0, frm.doc.total_faltas || 0,
					frappe.datetime.str_to_user(frm.doc.primeira_falta) || "—",
					frappe.datetime.str_to_user(frm.doc.ultima_falta) || "—"]),
			_PAB_CORES[frm.doc.estado] || "gray",
		);

		const jurista = ["Jurista", "SIGOS Manager", "System Manager"].some((r) => frappe.user.has_role(r));
		const chamar = (metodo, args) => frm.call(metodo, args || {}).then(() => frm.reload_doc());

		frm.add_custom_button(__("Ver Vigilante"), () => frappe.set_route("Form", "Vigilante", frm.doc.vigilante));
		if (frm.doc.processo_disciplinar) {
			frm.add_custom_button(__("Ver Processo Disciplinar"),
				() => frappe.set_route("Form", "Processo Disciplinar", frm.doc.processo_disciplinar));
		}
		frm.add_custom_button(__("Imprimir Presunção"), () => frm.print_doc());
		if (frm.doc.estado === "Aberta") {
			frm.add_custom_button(__("Actualizar Faltas"), () => chamar("actualizar_faltas"));
		}
		if (!jurista) return;

		if (frm.doc.estado === "Aberta") {
			frm.add_custom_button(__("Iniciar Análise"), () => frappe.confirm(
				__("Ao iniciar a análise a lista de faltas deixa de ser actualizada (fica como prova). Continuar?"),
				() => chamar("iniciar_analise"),
			), __("Jurista"));
		}
		if (frm.doc.estado === "Em Análise") {
			frm.add_custom_button(__("Reabrir"), () => chamar("reabrir"), __("Jurista"));
		}
		if (["Aberta", "Em Análise"].includes(frm.doc.estado)) {
			frm.add_custom_button(__("Encaminhar para Processo"), () => frappe.prompt(
				[
					{ fieldtype: "HTML", options: `<p class="text-muted">${__("Abre um <b>Processo Disciplinar</b> novo, salvo se escolher um existente.")}</p>` },
					{ fieldname: "processo_disciplinar", fieldtype: "Link", options: "Processo Disciplinar",
						label: __("Processo Disciplinar existente (opcional)") },
				],
				(v) => frm.call("encaminhar_para_processo", { processo_disciplinar: v.processo_disciplinar || null })
					.then((r) => {
						const pd = r.message && r.message.processo_disciplinar;
						if (pd) frappe.set_route("Form", "Processo Disciplinar", pd);
						else frm.reload_doc();
					}),
				__("Encaminhar para Processo"), __("Encaminhar"),
			), __("Jurista"));
		}
		if (["Aberta", "Em Análise", "Encaminhada para Processo"].includes(frm.doc.estado)) {
			frm.add_custom_button(__("Arquivar"), () => frappe.prompt(
				[{ fieldname: "nota", fieldtype: "Small Text", label: __("Motivo do arquivamento"), reqd: 1 }],
				(v) => chamar("arquivar", { nota: v.nota }),
				__("Arquivar Presunção"), __("Arquivar"),
			), __("Jurista"));
		}
	},
});
