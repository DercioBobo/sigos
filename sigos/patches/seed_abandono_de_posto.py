import frappe


def execute():
	"""Seed the "Abandono de Posto" Tipo De Infracao (for the Jurista's processes) on
	existing sites — fresh installs get it from default_data.json. (The ABP
	Rotatividade this patch used to seed was dropped: a guard in Abandono now keeps
	posto + escala — see sigos.patches.remover_operacao_abp.)"""
	if not frappe.db.exists("Tipo De Infracao", "Abandono de Posto"):
		frappe.get_doc({
			"doctype": "Tipo De Infracao",
			"nome": "Abandono de Posto",
			"gravidade_sugerida": "Alta",
			"ativo": 1,
			"descricao": "Ausência seguida acima do limite definido em SIGOS Settings (Abandono de Posto).",
		}).insert(ignore_permissions=True)
	frappe.db.commit()
