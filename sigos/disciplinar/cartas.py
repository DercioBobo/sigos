"""
Letters of the disciplinary chain (Repreensão Registada, Denúncia do Período
Probatório) — the body text is generated once from the source data and stored on the
document (`texto_carta`), so the Jurista can still edit it before printing.

Legal basis per infraction comes from Tipo De Infracao (lei_dever_* = the duty of art.
59, lei_infracao_* = the infraction of art. 67 n.º 1, Lei n.º 13/2023 de 25 de Agosto).
"""

import frappe
from frappe.utils import getdate

LEI = "Lei n.º 13/2023, de 25 de Agosto"
MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto",
	"Setembro", "Outubro", "Novembro", "Dezembro"]


def data_extenso(d):
	if not d:
		return ""
	d = getdate(d)
	return f"{d.day:02d} de {MESES[d.month - 1]} de {d.year}"


def empresa():
	return (frappe.db.get_single_value("SIGOS Settings", "empresa_padrao")
		or frappe.db.get_single_value("Global Defaults", "default_company"))


def _juntar(partes):
	partes = [p for p in partes if p]
	if len(partes) <= 1:
		return "".join(partes)
	return ", ".join(partes[:-1]) + " e " + partes[-1]


def enquadramento(tipos):
	"""Distinct (texto, referência) duties and infractions of the given Tipo De Infracao
	names, in order. Types without a mapping are skipped."""
	deveres, infr = [], []
	if not tipos:
		return deveres, infr
	linhas = frappe.get_all("Tipo De Infracao", filters={"name": ["in", list(tipos)]},
		fields=["name", "lei_dever_ref", "lei_dever_texto", "lei_infracao_ref", "lei_infracao_texto"])
	por_nome = {r.name: r for r in linhas}
	for t in tipos:
		r = por_nome.get(t)
		if not r:
			continue
		if r.lei_dever_ref and r.lei_dever_texto and (r.lei_dever_texto, r.lei_dever_ref) not in deveres:
			deveres.append((r.lei_dever_texto.strip(), r.lei_dever_ref.strip()))
		if r.lei_infracao_ref and r.lei_infracao_texto and (r.lei_infracao_texto, r.lei_infracao_ref) not in infr:
			infr.append((r.lei_infracao_texto.strip(), r.lei_infracao_ref.strip()))
	return deveres, infr


def tipos_da_participacao(participacao):
	if not participacao:
		return []
	return frappe.get_all("Participacao Infracao",
		filters={"parent": participacao, "parenttype": "Participacao"},
		pluck="tipo_de_infracao", order_by="idx")


def texto_repreensao(doc):
	"""Body of the Repreensão Registada letter (XSS_RH.FR.008), from the salutation's
	next line down to the closing paragraphs."""
	emp = empresa() or "empresa"
	tipos = tipos_da_participacao(doc.participacao)
	deveres, infr = enquadramento(tipos)
	p = frappe.db.get_value("Participacao", doc.participacao, ["outras_descricao"], as_dict=True) or {}

	quando = f"No dia {data_extenso(doc.data_ocorrencia)}" if doc.data_ocorrencia else "Na data da participação"
	if doc.hora_ocorrencia:
		quando += f", pelas {doc.hora_ocorrencia}"
	if doc.posto_nome or doc.posto:
		quando += f", no posto {doc.posto_nome or doc.posto}"
	conduta = doc.infracoes or ""
	if p.get("outras_descricao"):
		conduta = f"{conduta} ({p.get('outras_descricao')})" if conduta else p.get("outras_descricao")

	paragrafos = [
		f"A empresa {emp} serve-se da presente para repreender V. Excia., nos termos da Lei do Trabalho, "
		"em virtude do comportamento desviante apresentado, o qual se expressou na seguinte conduta:",
		f"{quando}, foi formalmente participado por: {conduta}.",
	]
	if deveres:
		if len(deveres) == 1:
			t, r = deveres[0]
			paragrafos.append(f"Pela conduta de V. Excia., revela-se falha do dever de {t}, nos termos da {r} da Lei do Trabalho.")
		else:
			paragrafos.append("Pela conduta de V. Excia., revela-se falha dos deveres de "
				+ _juntar([f"{t} ({r})" for t, r in deveres]) + ", da Lei do Trabalho.")
	sancao = (f"constituindo fundamento bastante para a aplicação da presente repreensão registada, nos termos "
		f"do n.º 1 do artigo 66, conjugado com a alínea b) do n.º 1 do artigo 64, todos da {LEI}.")
	if infr:
		quais = _juntar([f"{t}, vide {r}" for t, r in infr])
		paragrafos.append(("A violação do preceito legal supra traduz-se no cometimento da infracção disciplinar de "
			if len(infr) == 1 else "A violação dos preceitos legais supra traduz-se no cometimento das infracções disciplinares de ")
			+ f"{quais} da Lei do Trabalho, " + sancao)
	else:
		paragrafos.append("Tal conduta constitui infracção disciplinar, " + sancao)
	paragrafos += [
		"Com esta medida disciplinar esperamos dissuadir o cometimento de novas falhas, de qualquer natureza, "
		"por parte de V. Excia., e contar com a sua colaboração e comprometimento para que possamos preservar a "
		"boa convivência, a harmonia e o correcto desenvolvimento das tarefas em nosso ambiente de trabalho.",
		"Todavia, a empresa decidiu dar-lhe nova oportunidade para melhorar o seu comportamento. Havendo novas "
		"falhas disciplinares, não hesitaremos em aplicar-lhe medidas mais graves e cabíveis ao caso.",
	]
	return "\n\n".join(paragrafos)


def _morada_empresa(emp):
	nome = frappe.db.sql("""
		SELECT a.name FROM `tabAddress` a JOIN `tabDynamic Link` dl ON dl.parent = a.name
		WHERE dl.link_doctype = 'Company' AND dl.link_name = %s AND dl.parenttype = 'Address'
		ORDER BY a.is_primary_address DESC, a.modified DESC LIMIT 1""", emp)
	if not nome:
		return ""
	a = frappe.db.get_value("Address", nome[0][0], ["address_line1", "address_line2", "city"], as_dict=True)
	return ", ".join(x.strip() for x in (a.address_line1, a.address_line2, a.city) if x and x.strip())


def texto_denuncia(doc):
	"""Body of the Denúncia do Período Probatório letter (XSS_RH.FR.014)."""
	emp = empresa() or "empresa"
	morada = _morada_empresa(emp) if emp != "empresa" else ""
	nuit = frappe.db.get_value("Company", emp, "tax_id") if emp != "empresa" else None
	rep = (frappe.db.get_single_value("SIGOS Settings", "representante_rh") or "").strip()

	quem = "A " + emp.upper()
	if morada:
		quem += f", situada em {morada}"
	if nuit:
		quem += f", portadora do NUIT {nuit}"
	if rep:
		quem += f", representada no acto por {rep}, na qualidade de Recursos Humanos"
	motivo = f" ({doc.infracoes})" if doc.infracoes else ""
	dias = (getdate(doc.data_de_demissao) - getdate(doc.data)).days if doc.data and doc.data_de_demissao else 0
	prazo = (f"deverá cessar as suas funções ({dias}) dias depois de receber o presente documento"
		if dias > 0 else "deverá cessar as suas funções")
	return (f"{quem}, vem através do presente documento, e nos termos dos n.ºs 1 e 2 do artigo 51 da "
		f"{LEI}, comunicar a V. Excia. a denúncia do contrato de trabalho no período probatório, devido ao "
		f"comportamento apresentado{motivo}, conduta que não é permitida pelas normas da empresa. "
		f"Sendo assim, V. Excia. {prazo}.")
