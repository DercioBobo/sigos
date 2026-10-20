import frappe


def execute():
	"""Seed what the Abandono de Posto status needs on existing sites (fresh installs
	get the same records from default_data.json): the ABP Rotatividade operation and
	the "Abandono de Posto" Tipo De Infracao used by its automatic Participação.
	SIGOS Settings.abandono_tipo_infracao is then filled by install._seed_settings_defaults."""
	if not frappe.db.exists("Tipo De Infracao", "Abandono de Posto"):
		frappe.get_doc({
			"doctype": "Tipo De Infracao",
			"nome": "Abandono de Posto",
			"gravidade_sugerida": "Alta",
			"ativo": 1,
			"descricao": "Ausência seguida acima do limite definido em SIGOS Settings (Abandono de Posto).",
		}).insert(ignore_permissions=True)

	if not frappe.db.exists("Operacao De Rotatividade", "ABP"):
		frappe.get_doc({
			"doctype": "Operacao De Rotatividade",
			"abreviatura": "ABP",
			"operacao": "Abandono de Posto",
			"activo": 1,
			"bloqueada": 1,
			"marca_abandono": 1,
			"requer_substituto": 1,
			"descricao": (
				"Vigilante com ausências seguidas acima do limite: sai do posto e da escala, "
				"fica em Abandono de Posto (empregado, sem remuneração). Um substituto pode "
				"assumir o posto. Cria uma Participação automaticamente."
			),
		}).insert(ignore_permissions=True)
	frappe.db.commit()
