"""
Billing profiles (Perfil De Faturacao): every invoicing choice for a customer in one
named record — what is counted (per service / per guard, Activos / Contratual), how
the invoice lines look (detail + text template) and when it is issued (automatic,
day, billed month). A Customer picks a profile (custom_perfil_faturacao); empty
means the SIGOS Settings default profile. Contracts keep only their prices and
quantities; the Regime keeps its guards per service.
"""
import frappe
from frappe import _
from frappe.utils import add_months, cint, get_first_day, getdate, nowdate

PERFIL = "Perfil De Faturacao"
PERFIL_PADRAO = "Padrão"

FATURAR_SERVICO = "Serviço"
FATURAR_VIGILANTE = "Vigilante"
DETALHE_CONTRATO = "Por Contrato"
DETALHE_POR_POSTO = "Por Posto"
DETALHE_UMA_LINHA = "Por Posto (uma linha)"
MES_ANTERIOR = "Mês Anterior"
MES_CORRENTE = "Mês Corrente"
MES_SEGUINTE = "Mês Seguinte"

# billed month relative to the month the invoice is issued in
DESVIO_MES = {MES_ANTERIOR: -1, MES_CORRENTE: 0, MES_SEGUINTE: 1}

# Built-in values: used when no profile exists at all (fresh site before setup).
PREDEFINIDO = dict(
	nome="", faturar_por=FATURAR_SERVICO, metodo_faturacao="Vigilantes Activos",
	detalhe_fatura=DETALHE_CONTRATO, modelo_descricao="", faturacao_automatica=0,
	dia_faturacao=25, mes_faturado=MES_CORRENTE, regimes={},
)


def perfil_padrao():
	"""Name of the SIGOS Settings default profile (may be empty)."""
	nome = frappe.db.get_single_value("SIGOS Settings", "perfil_faturacao_padrao")
	return nome if nome and frappe.db.exists(PERFIL, nome) else None


def carregar(nome):
	"""A profile as a plain _dict (regimes = {regime: guards per service})."""
	if not nome or not frappe.db.exists(PERFIL, nome):
		return frappe._dict(PREDEFINIDO, regimes={})
	doc = frappe.get_cached_doc(PERFIL, nome)
	dia = cint(doc.dia_faturacao) or 25
	return frappe._dict(
		nome=doc.name,
		faturar_por=doc.faturar_por or FATURAR_SERVICO,
		metodo_faturacao=doc.metodo_faturacao or "Vigilantes Activos",
		detalhe_fatura=doc.detalhe_fatura or DETALHE_CONTRATO,
		modelo_descricao=(doc.modelo_descricao or "").strip(),
		faturacao_automatica=cint(doc.faturacao_automatica),
		dia_faturacao=min(max(dia, 1), 31),
		mes_faturado=doc.mes_faturado or MES_CORRENTE,
		regimes={r.regime: cint(r.vigilantes_por_servico) for r in doc.regimes
			if r.regime and cint(r.vigilantes_por_servico) > 0},
	)


def perfis_dos_clientes(clientes, substituir=None):
	"""{cliente: profile _dict, with proprio=True when the customer chose one}.
	substituir = {cliente: profile name ('' = default)} to preview an unsaved choice."""
	clientes = [c for c in set(clientes or []) if c]
	escolhido = {}
	if clientes and frappe.db.has_column("Customer", "custom_perfil_faturacao"):
		escolhido = dict(frappe.get_all("Customer", filters={"name": ["in", clientes]},
			fields=["name", "custom_perfil_faturacao"], as_list=True))
	escolhido.update(substituir or {})
	padrao = perfil_padrao()
	cache = {}
	out = {}
	for c in clientes:
		nome = escolhido.get(c) or None
		if nome and not frappe.db.exists(PERFIL, nome):
			nome = None
		chave = nome or padrao
		if chave not in cache:
			cache[chave] = carregar(chave)
		out[c] = frappe._dict(cache[chave], proprio=bool(nome))
	return out


def perfil_do_cliente(cliente, perfil=None):
	sub = {cliente: perfil} if perfil is not None else None
	return perfis_dos_clientes([cliente], sub).get(cliente) or frappe._dict(PREDEFINIDO, proprio=False)


def vigilantes_por_servico(perfil, regime, por_regime):
	"""Guards per billed service: the profile's exception, else the Regime's, else 1."""
	return cint((perfil.regimes or {}).get(regime)) or por_regime.get(regime) or 1


def resumo(perfil):
	"""Short human lines describing a profile (Customer card, Previsão page)."""
	linhas = [
		_("Factura por serviço (ex. H24 com 3 vigilantes = 1)") if perfil.faturar_por == FATURAR_SERVICO
			else _("Factura por vigilante (cada vigilante conta 1)"),
		_("Quantidade: vigilantes activos") if perfil.metodo_faturacao == "Vigilantes Activos"
			else _("Quantidade: a escrita no contrato"),
		{DETALHE_CONTRATO: _("Uma linha por contrato e regime"),
		 DETALHE_POR_POSTO: _("Uma linha por posto e regime"),
		 DETALHE_UMA_LINHA: _("Uma linha por posto (soma dos regimes)")}.get(perfil.detalhe_fatura, ""),
	]
	if perfil.regimes:
		linhas.append(_("Excepções: {0}").format(", ".join(
			_("{0} = {1} vigilantes").format(r, n) for r, n in sorted(perfil.regimes.items()))))
	mes = {MES_ANTERIOR: _("o mês anterior"), MES_SEGUINTE: _("o mês seguinte")}.get(
		perfil.mes_faturado, _("o próprio mês"))
	if perfil.faturacao_automatica:
		dia = _("último dia") if perfil.dia_faturacao >= 31 else _("dia {0}").format(perfil.dia_faturacao)
		linhas.append(_("Automática: {0}, factura {1}").format(dia, mes))
	else:
		linhas.append(_("Emissão manual, factura {0}").format(mes))
	return linhas


@frappe.whitelist()
def resumo_cliente(customer, perfil=None, mes=None):
	"""Customer form card: the profile that applies (the unsaved choice when given),
	its summary and this month's invoice lines with its text."""
	frappe.has_permission("Customer", "read", customer, throw=True)
	p = perfil_do_cliente(customer, perfil if perfil is not None else None)
	from sigos.sigos_setup.doctype.faturacao_mensal.faturacao_mensal import calcular_linhas
	linhas, _activos = calcular_linhas(customer, mes, perfil=perfil)
	return {
		"perfil": p.nome or "",
		"proprio": p.proprio,
		"padrao": perfil_padrao() or "",
		"resumo": resumo(p),
		"linhas": [dict(descricao=l["descricao"], quantidade=l["quantidade"], total=l["total"])
			for l in linhas if l["quantidade"]],
	}


@frappe.whitelist()
def mes_proposto(cliente):
	"""'Faturar Mês': the month the customer's profile bills when issued today."""
	frappe.has_permission("Customer", "read", cliente, throw=True)
	p = perfil_do_cliente(cliente)
	mes = getdate(add_months(get_first_day(nowdate()), DESVIO_MES.get(p.mes_faturado, 0)))
	return {"mes": mes, "perfil": p.nome or "", "mes_faturado": p.mes_faturado}


@frappe.whitelist()
def definir_perfil_cliente(cliente, perfil=None):
	"""Previsão page: change a customer's profile ('' = default)."""
	from sigos.sigos_setup.doctype.faturacao_mensal.faturacao_mensal import PAPEIS_FATURACAO
	frappe.only_for(PAPEIS_FATURACAO)
	if not frappe.db.exists("Customer", cliente):
		frappe.throw(_("Cliente {0} não existe.").format(cliente))
	if perfil and not frappe.db.exists(PERFIL, perfil):
		frappe.throw(_("Perfil {0} não existe.").format(perfil))
	frappe.db.set_value("Customer", cliente, "custom_perfil_faturacao", perfil or None)
	return True
