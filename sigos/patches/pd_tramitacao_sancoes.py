import frappe

# Old decisão values → the sanctions of the labour law (2026-10).
MAPA = {
	"Advertência": "Repreensão",
	"Dedução": "Multa",
	"Retenção De Salário": "Suspensão do Trabalho",
	"Demissão": "Despedimento",
}


def execute():
	for antigo, novo in MAPA.items():
		frappe.db.sql(
			"UPDATE `tabProcesso Disciplinar` SET decisao = %s WHERE decisao = %s", (novo, antigo))
	from sigos.disciplinar.tramitacao import actualizar_estado
	for nome in frappe.get_all("Processo Disciplinar", pluck="name"):
		pd = frappe.get_doc("Processo Disciplinar", nome)
		if pd.docstatus == 1:
			frappe.db.set_value("Processo Disciplinar", nome, "fase", "Concluído", update_modified=False)
			continue
		actualizar_estado(pd)
		frappe.db.set_value("Processo Disciplinar", nome, {
			"fase": pd.fase, "prazo_defesa": pd.prazo_defesa, "prazo_decisao": pd.prazo_decisao,
			"sindicato_desde": pd.sindicato_desde,
		}, update_modified=False)
	frappe.db.commit()
