import frappe

# The infracções of the paper Participação (XSS_OP.FR.006), in its order: left
# column first, then the right one. (nome, gravidade sugerida, ordem, pede descrição)
TIPOS = [
	("Embriaguez", "Alta", 1, 0),
	("Dormir em Serviço", "Alta", 2, 0),
	("Abandono de Posto", "Alta", 3, 0),
	("Furto", "Alta", 4, 0),
	("Ausências Injustificadas", "Média", 5, 0),
	("Cobrança de Parqueamento", "Média", 6, 0),
	("Cobranças Ilícitas", "Alta", 7, 0),
	("Mau Posicionamento", "Baixa", 8, 0),
	("Outras", "Baixa", 9, 1),
	("Danificação de Equipamento", "Média", 10, 0),
	("Incumprimento de Ordem", "Média", 11, 0),
	("Não Responder ao Rádio", "Média", 12, 0),
	("Não Fez Barba ou Cabelo", "Baixa", 13, 0),
	("Aprumo", "Baixa", 14, 0),
	("Injúria ou Falta de Respeito", "Média", 15, 0),
	("Atraso", "Baixa", 16, 0),
	("Negligência", "Média", 17, 0),
]


def execute():
	"""Seed the paper form's infracções (existing sites; fresh installs get them from
	default_data.json). Existing records only get their ordem / pede_descricao filled
	when still empty — a customer's own gravidade/ordem is never overwritten."""
	for nome, gravidade, ordem, pede in TIPOS:
		if frappe.db.exists("Tipo De Infracao", nome):
			if not frappe.db.get_value("Tipo De Infracao", nome, "ordem"):
				frappe.db.set_value("Tipo De Infracao", nome, {"ordem": ordem, "pede_descricao": pede},
					update_modified=False)
			continue
		frappe.get_doc({
			"doctype": "Tipo De Infracao", "nome": nome, "gravidade_sugerida": gravidade,
			"ativo": 1, "ordem": ordem, "pede_descricao": pede,
		}).insert(ignore_permissions=True)
	frappe.db.commit()
