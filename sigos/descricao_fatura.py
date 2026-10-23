"""
Invoice line text from a template with {variables}.

Template: the customer's billing profile 'Texto da Linha' (sigos.perfil_faturacao),
else the built-in one for the line's detail (Por Contrato / Por Posto / Por Posto
(uma linha)) below. Rendered by calcular_linhas, so the
Faturação Mensal preview, the Sales Invoice fetch and the automatic billing all show
the same text.
"""
import re

import frappe
from frappe import _
from frappe.utils import add_months, add_days, formatdate, get_first_day, getdate

MESES_PT = ("Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
	"Agosto", "Setembro", "Outubro", "Novembro", "Dezembro")

# name -> what it is (shown as help in SIGOS Settings, used to validate templates)
VARIAVEIS = {
	"regime": "Regime (ex. H24). Na linha única: os regimes do posto.",
	"categoria": "Nome na factura da categoria (ex. Armado). Na linha única: as do posto.",
	"descricao": "Descrição na Factura da tarifa (contrato ou cliente); vazio = regime e categoria, ex. H24 Armado.",
	"composicao": "Quantidades por regime e categoria, ex. 2 × H24 Armado + 1 × TDN Simples.",
	"quantidade": "Quantidade facturada (serviços ou vigilantes).",
	"vigilantes": "Número de vigilantes.",
	"nome_financeiro": "Nome financeiro do posto (ou o nome do posto). Sem posto: os postos do contrato.",
	"posto": "Nome do posto. Sem posto: os postos do contrato.",
	"indicativo": "Indicativo do posto.",
	"localizacao": "Localização do posto.",
	"delegacao": "Delegação do posto.",
	"tipo_posto": "Permanente ou Temporário.",
	"temporario": "'[Temporário]' nos postos temporários, senão vazio.",
	"postos": "Postos activos do contrato, separados por vírgula.",
	"contrato": "Nome do contrato (projecto).",
	"cliente": "Nome do cliente.",
	"mes": "Mês facturado, ex. Outubro.",
	"mes_num": "Mês facturado em número, ex. 10.",
	"ano": "Ano, ex. 2026.",
	"mes_ano": "Mês e ano, ex. Outubro 2026.",
	"periodo": "Período, ex. 01-10-2026 a 31-10-2026.",
}

MODELO_CONTRATO = "{descricao} — {contrato} {temporario} ({mes_ano})"
MODELO_POSTO = "{descricao} — {nome_financeiro} {temporario} ({mes_ano})"
MODELO_UMA_LINHA = "{nome_financeiro} — {composicao} {temporario} ({mes_ano})"

_VAR = re.compile(r"\{(\w+)\}")
_SEP = r"[—–\-·|,:/]"


def variaveis_do_mes(mes):
	"""Month variables for the billed month (any date inside it)."""
	ini = get_first_day(getdate(mes))
	fim = add_days(add_months(ini, 1), -1)
	return {
		"mes": MESES_PT[ini.month - 1],
		"mes_num": f"{ini.month:02d}",
		"ano": str(ini.year),
		"mes_ano": f"{MESES_PT[ini.month - 1]} {ini.year}",
		"periodo": f"{formatdate(ini, 'dd-MM-yyyy')} a {formatdate(fim, 'dd-MM-yyyy')}",
	}


def render(modelo, valores):
	"""Fill {variables}; tidy what empty ones leave behind (double separators,
	empty brackets, stray spaces) so an unused variable never shows."""
	texto = _VAR.sub(lambda m: str(valores.get(m.group(1)) or "")
		if m.group(1) in VARIAVEIS else m.group(0), modelo or "")
	texto = re.sub(r"\(\s*\)|\[\s*\]", "", texto)
	texto = re.sub(rf"\s*({_SEP})(\s*{_SEP})+", r" \1", texto)
	texto = re.sub(r"\s+", " ", texto).strip()
	return re.sub(rf"^{_SEP}\s*|\s*{_SEP}$", "", texto).strip()


def validar_modelo(modelo, rotulo):
	"""Throw on a {variable} that doesn't exist (typo would print literally)."""
	desconhecidas = sorted({v for v in _VAR.findall(modelo or "") if v not in VARIAVEIS})
	if desconhecidas:
		frappe.throw(
			_("{0}: variável desconhecida {1}. Disponíveis: {2}").format(
				rotulo,
				", ".join("{" + v + "}" for v in desconhecidas),
				" ".join("{" + v + "}" for v in VARIAVEIS)),
			title=_("Modelo da Descrição"),
		)


MODELOS = {
	"Por Contrato": MODELO_CONTRATO,
	"Por Posto": MODELO_POSTO,
	"Por Posto (uma linha)": MODELO_UMA_LINHA,
}


def modelo_para(perfil, detalhe):
	"""The billing profile's template, else the built-in one for that line detail."""
	return (perfil.get("modelo_descricao") or "").strip() or MODELOS.get(detalhe, MODELO_CONTRATO)


def _exemplo(mes=None):
	return dict(variaveis_do_mes(mes or frappe.utils.nowdate()),
		regime="H24", categoria="Armado", descricao="H24 Armado",
		composicao="2 × H24 Armado + 1 × TDN Simples", quantidade=1,
		vigilantes=3, nome_financeiro="Agência Baixa", posto="Agência Baixa",
		indicativo="AB-01", localizacao="Av. 25 de Setembro", delegacao="Maputo",
		tipo_posto="Permanente", temporario="", postos="Agência Baixa, Sede",
		contrato="Contrato 01", cliente="Cliente Exemplo")


@frappe.whitelist()
def previsualizar_modelo(modelo=None, detalhe=None):
	"""Billing profile form: the line text on example values (errors inline, no popup)."""
	desconhecidas = sorted({v for v in _VAR.findall(modelo or "") if v not in VARIAVEIS})
	if desconhecidas:
		return {"erro": _("Variável desconhecida: {0}").format(
			", ".join("{" + v + "}" for v in desconhecidas))}
	return {"texto": render(modelo_para({"modelo_descricao": modelo}, detalhe), _exemplo())}
