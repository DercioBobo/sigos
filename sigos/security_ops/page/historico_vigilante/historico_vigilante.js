// Histórico do Vigilante — /app/historico-vigilante/<VIG>. Rendered by the shared
// sigos.historico component (public/js/historico_vigilante.js); without a guard in
// the route it asks for one.
frappe.pages["historico-vigilante"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({ parent: wrapper, title: __("Histórico do Vigilante"), single_column: true });
	wrapper.hv_page = page;
	page.main.addClass("hv-page-main");
	page.$picker = page.add_field({
		fieldname: "vigilante", fieldtype: "Link", options: "Vigilante", label: __("Vigilante"),
		change() {
			const v = page.$picker.get_value();
			if (v && v !== wrapper.hv_atual) frappe.set_route("historico-vigilante", v);
		},
	});
};

frappe.pages["historico-vigilante"].on_page_show = function (wrapper) {
	const page = wrapper.hv_page;
	const vig = frappe.get_route()[1] ? decodeURIComponent(frappe.get_route()[1]) : null;
	if (!vig) {
		wrapper.hv_atual = null;
		page.set_title(__("Histórico do Vigilante"));
		page.main.html(`<div class="hv-root hv-pagina"><div class="hv-vazio" style="margin-top:20px">
			<b>${__("Escolha um vigilante")}</b><span>${__("Use o campo Vigilante acima.")}</span></div></div>`);
		return;
	}
	if (vig === wrapper.hv_atual) return; // coming back from a document: keep filters/scroll
	wrapper.hv_atual = vig;
	page.$picker.set_value(vig);
	frappe.db.get_value("Vigilante", vig, "nome_completo").then((r) => {
		const nome = r.message && r.message.nome_completo;
		page.set_title(nome ? __("Histórico — {0}", [nome]) : __("Histórico do Vigilante"));
	});
	sigos.historico.montar(page.main, vig, { modo: "pagina" });
};
