import frappe

# Lei n.º 13/2023, de 25 de Agosto — art. 59 (deveres do trabalhador) and art. 67 n.º 1
# (infracções disciplinares). Used by the Repreensão letter (sigos.disciplinar.cartas).
DEVER = {
	"a": "comparecer ao serviço com pontualidade e assiduidade",
	"b": "prestar o trabalho com zelo e diligência",
	"c": "respeitar e tratar com correcção e lealdade o empregador, os superiores hierárquicos, "
		"os colegas de trabalho e demais pessoas que estejam ou entrem em contacto com a empresa",
	"d": "obedecer a ordens e instruções do empregador, dos seus representantes ou dos superiores hierárquicos",
	"e": "utilizar correctamente e conservar em boas condições os bens e equipamentos de trabalho "
		"que lhe forem confiados pelo empregador",
	"g": "não utilizar para fins pessoais ou alheios ao serviço, sem a devida autorização do empregador, "
		"os locais, equipamentos, bens, serviços e meios de trabalho da empresa",
	"h": "ser leal ao empregador",
}
INFRACCAO = {
	"a": "incumprimento do horário de trabalho ou das tarefas atribuídas",
	"b": "falta de comparência ao trabalho, sem justificação válida",
	"c": "ausência do posto ou local de trabalho no período de trabalho, sem a devida autorização",
	"d": "desobediência a ordens legais ou instruções decorrentes do contrato de trabalho e das normas que o regem",
	"e": "falta de respeito aos superiores hierárquicos, colegas de trabalho e terceiros",
	"h": "abuso de funções ou invocação do cargo para a obtenção de vantagens ilícitas",
	"j": "desvio, para fins pessoais ou alheios ao serviço, de equipamentos, bens, serviços e outros "
		"meios de trabalho ou utilização indevida do local de trabalho",
	"k": "danificação, destruição ou deterioração culposa de bens do local de trabalho",
	"m": "embriaguez ou estado de drogado no posto ou local de trabalho ou no desempenho das suas funções",
	"n": "furto, roubo, abuso de confiança, burla e outras fraudes praticadas no local de trabalho "
		"ou durante a realização do trabalho",
}
# tipo de infracção → (alínea do art. 59, alínea do n.º 1 do art. 67)
MAPA = {
	"Embriaguez": ("b", "m"),
	"Dormir em Serviço": ("b", "a"),
	"Abandono de Posto": ("b", "c"),
	"Furto": ("h", "n"),
	"Ausências Injustificadas": ("a", "b"),
	"Cobrança de Parqueamento": ("g", "j"),
	"Cobranças Ilícitas": ("h", "h"),
	"Mau Posicionamento": ("d", "d"),
	"Danificação de Equipamento": ("e", "k"),
	"Incumprimento de Ordem": ("d", "d"),
	"Não Responder ao Rádio": ("b", "a"),
	"Não Fez Barba ou Cabelo": ("d", "d"),
	"Aprumo": ("d", "d"),
	"Injúria ou Falta de Respeito": ("c", "e"),
	"Atraso": ("a", "a"),
	"Negligência": ("b", "a"),
}


def valores(nome):
	if nome not in MAPA:
		return None
	d, i = MAPA[nome]
	return {
		"lei_dever_ref": f"alínea {d}) do artigo 59",
		"lei_dever_texto": DEVER[d],
		"lei_infracao_ref": f"alínea {i}) do n.º 1 do artigo 67",
		"lei_infracao_texto": INFRACCAO[i],
	}


def execute():
	"""Fill the legal basis of the standard infraction types — only where still empty,
	so a customer's own wording is never overwritten."""
	frappe.reload_doc("disciplinar", "doctype", "tipo_de_infracao")
	for nome in MAPA:
		if not frappe.db.exists("Tipo De Infracao", nome):
			continue
		if frappe.db.get_value("Tipo De Infracao", nome, "lei_dever_ref"):
			continue
		frappe.db.set_value("Tipo De Infracao", nome, valores(nome), update_modified=False)
