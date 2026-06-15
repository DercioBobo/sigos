frappe.ui.form.on("SIGOS Settings", {
	refresh(frm) {
		_botoes_ferias(frm);
	},
});

// Botões de migração de saldos iniciais de férias (operação pontual, opcional).
function _botoes_ferias(frm) {
	const grupo = __("Férias");

	frm.add_custom_button(__("Pré-visualizar Migração de Saldos"), () => {
		_correr_migracao(frm, true);
	}, grupo);

	frm.add_custom_button(__("Semear Saldos Iniciais"), () => {
		frappe.confirm(
			__("Isto cria a alocação inicial de férias para os colaboradores que ainda não a têm, " +
				"com o saldo acumulado pela antiguidade (limitado ao tecto). Colaboradores já alocados " +
				"são ignorados. Pré-visualize primeiro. Continuar?"),
			() => _correr_migracao(frm, false)
		);
	}, grupo);
}

function _correr_migracao(frm, dry_run) {
	frappe.call({
		method: "sigos.ferias.enfileirar_migracao_saldos",
		args: { dry_run: dry_run ? 1 : 0 },
		freeze: true,
		freeze_message: __("A lançar..."),
		callback: () => {
			frappe.show_alert({
				message: dry_run
					? __("Pré-visualização em curso — o resultado aparece ao terminar.")
					: __("Migração em curso — o resultado aparece ao terminar."),
				indicator: "blue",
			});
		},
	});
}

// Resultado do job de fundo (evento realtime emitido por _migracao_em_fila).
frappe.realtime.on("sigos_ferias_migracao", (res) => {
	if (!res) return;
	const dry = (res.modo || "").indexOf("dry_run") !== -1 || (res.modo || "").indexOf("PRE") !== -1
		|| (res.modo || "").indexOf("PRÉ") !== -1;
	const titulo = dry ? __("Pré-visualização da Migração de Férias") : __("Migração de Férias Concluída");
	frappe.msgprint({
		title: titulo,
		indicator: res.errors ? "orange" : "green",
		message: `
			<table class="table table-bordered" style="margin:0">
				<tr><td>${__("Modo")}</td><td><b>${frappe.utils.escape_html(res.modo || "")}</b></td></tr>
				<tr><td>${__("Semeados")}</td><td><b>${res.seeded || 0}</b></td></tr>
				<tr><td>${__("Total de dias")}</td><td>${res.total_dias || 0}</td></tr>
				<tr><td>${__("Já alocados (ignorados)")}</td><td>${res.skipped_existing || 0}</td></tr>
				<tr><td>${__("Saldo zero (ignorados)")}</td><td>${res.skipped_zero || 0}</td></tr>
				<tr><td>${__("Sem antiguidade (ignorados)")}</td><td>${res.skipped_no_anchor || 0}</td></tr>
				<tr><td>${__("Erros")}</td><td>${res.errors || 0}</td></tr>
			</table>`,
	});
});
