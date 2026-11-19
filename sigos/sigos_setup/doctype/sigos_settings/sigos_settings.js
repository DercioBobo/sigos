frappe.ui.form.on("SIGOS Settings", {
	setup(frm) {
		frm.set_query("modelo_iva", () => ({
			filters: Object.assign({ disabled: 0 }, frm.doc.empresa_padrao ? { company: frm.doc.empresa_padrao } : {}),
		}));
	},
	refresh(frm) {
		_botoes_ferias(frm);
		frm.add_custom_button(__("Criar Modelo de IVA"), () => _criar_modelo_iva(frm), __("Faturação"));
	},
});

// IVA: a one-line template (taxa % sobre o total líquido) set as the SIGOS Modelo de IVA.
function _criar_modelo_iva(frm) {
	const d = new frappe.ui.Dialog({
		title: __("Criar Modelo de IVA"),
		fields: [
			{ fieldname: "company", fieldtype: "Link", options: "Company", label: __("Empresa"), reqd: 1,
				default: frm.doc.empresa_padrao || frappe.defaults.get_default("company") },
			{ fieldname: "taxa", fieldtype: "Percent", label: __("Taxa de IVA"), reqd: 1, default: 16 },
			{ fieldname: "conta", fieldtype: "Link", options: "Account", label: __("Conta de IVA"), reqd: 1,
				get_query: () => ({ filters: { company: d.get_value("company"), is_group: 0,
					root_type: ["in", ["Liability", "Asset"]] } }) },
		],
		primary_action_label: __("Criar"),
		primary_action(v) {
			frappe.xcall("sigos.iva.criar_modelo_iva", v).then((nome) => {
				d.hide();
				frm.reload_doc();
				frappe.show_alert({ message: __("Modelo de IVA: {0}", [nome]), indicator: "green" }, 5);
			});
		},
	});
	d.show();
}

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
