"""
SIGOS billing on Sales Invoice — the direct route, without a Faturacao Mensal run.

'Contratos SIGOS' (Get Items From, on a draft Sales Invoice) fills the items from
the customer's contracts with the same lines Faturacao Mensal would build
(calcular_linhas). Both routes stamp custom_mes_referencia, and the Sales Invoice
validate hook below is the single double-billing guard for either of them.
"""
import frappe
from frappe import _
from frappe.utils import cint, formatdate, get_first_day, get_last_day, getdate, nowdate

from sigos.sigos_setup.doctype.faturacao_mensal.faturacao_mensal import (
	ITEM_GROUP_FATURACAO,
	PAPEIS_FATURACAO,
	UOM_FATURACAO,
	_clientes_ja_faturados,
	_item_para_regime,
	calcular_linhas,
)


def sales_invoice_validate(doc, method=None):
	"""One SIGOS invoice per customer + company + month (drafts count, cancelled don't)."""
	if not doc.get("custom_mes_referencia"):
		return
	mes = get_first_day(getdate(doc.custom_mes_referencia))
	doc.custom_mes_referencia = mes
	ja = _clientes_ja_faturados(doc.company, mes, {doc.customer}, excluir=doc.name)
	if ja:
		frappe.throw(
			_("O cliente <b>{0}</b> já tem factura SIGOS de {1}: {2}.<br><br>"
			  "Para refacturar, cancele (ou apague, se ainda em rascunho) a factura existente.").format(
				doc.customer, formatdate(mes, "MMMM yyyy"), ", ".join(ja[doc.customer])),
			title=_("Já Facturado"),
		)


@frappe.whitelist()
def obter_linhas_contrato(doc, mes_referencia, substituir=1):
	"""
	Fill a draft Sales Invoice with the customer's SIGOS contract lines for a month.
	Takes the (possibly unsaved) invoice from the form and returns it with the items
	added, for frappe.model.sync on the client — the same round-trip ERPNext's own
	'Get Items From' mapping uses, so item details/accounts/totals come from ERPNext.
	"""
	frappe.only_for(PAPEIS_FATURACAO)
	si = frappe.get_doc(frappe.parse_json(doc))
	if si.doctype != "Sales Invoice" or si.docstatus != 0:
		frappe.throw(_("Só é possível em facturas de venda em rascunho."))
	if si.get("is_return"):
		frappe.throw(_("Não disponível em notas de crédito."))
	if not (si.customer and si.company):
		frappe.throw(_("Defina primeiro o <b>Cliente</b> e a <b>Empresa</b>."))

	mes = get_first_day(getdate(mes_referencia))
	mes_label = formatdate(mes, "MMMM yyyy")

	excluir = None if si.get("__islocal") else si.name
	ja = _clientes_ja_faturados(si.company, mes, {si.customer}, excluir=excluir)
	if ja:
		frappe.throw(
			_("O cliente <b>{0}</b> já tem factura SIGOS de {1}: {2}.").format(
				si.customer, mes_label, ", ".join(ja[si.customer])),
			title=_("Já Facturado"),
		)

	linhas, activos_contratos = calcular_linhas(si.customer)
	sem_tarifa = [f"{l['project']} / {l['regime']}" for l in linhas
		if l["quantidade"] and not l["valor_unitario"]]
	linhas = [l for l in linhas if l["quantidade"] and l["valor_unitario"]]
	if not linhas:
		frappe.throw(
			_("Nada a facturar para <b>{0}</b>: sem contratos com vigilantes e tarifa "
			  "(Faturação por Regime no Projecto).").format(si.customer),
			title=_("Sem Linhas"),
		)

	regimes = sorted({l["regime"] for l in linhas})
	if any(not frappe.db.exists("Item", f"VIG-{r}") for r in regimes):
		erros = []
		if not frappe.db.exists("Item Group", {"name": ITEM_GROUP_FATURACAO, "is_group": 0}):
			erros.append(_("Falta o Grupo de Artigos <b>{0}</b>.").format(ITEM_GROUP_FATURACAO))
		if not frappe.db.exists("UOM", {"name": UOM_FATURACAO, "enabled": 1}):
			erros.append(_("Falta a Unidade de Medida <b>{0}</b>.").format(UOM_FATURACAO))
		if erros:
			frappe.throw("<br>".join(erros), title=_("Configuração em Falta"))
	itens = {r: _item_para_regime(r) for r in regimes}

	if cint(substituir):
		si.set("items", [])
	proj_nomes = {p: frappe.db.get_value("Project", p, "project_name") or p
		for p in {l["project"] for l in linhas}}
	for l in linhas:
		texto = l.get("descricao") or "{0}{1} — {2}".format(
			l["regime"], " [Temporário]" if l["tipo_posto"] == "Temporário" else "",
			proj_nomes[l["project"]])
		si.append("items", {
			"item_code": itens[l["regime"]],
			"qty": l["quantidade"],
			"rate": l["valor_unitario"],
			"description": f"{texto} ({mes_label})",
			"project": l["project"],
		})

	si.ignore_pricing_rule = 1   # the contract rate is final — no Pricing Rule may alter it
	si.custom_mes_referencia = mes
	if si.meta.has_field("custom_total_vigilantes"):
		si.custom_total_vigilantes = sum(cint(d.qty) for d in si.items
			if (d.item_code or "").startswith("VIG-"))

	si.set_missing_values()
	si.calculate_taxes_and_totals()

	if sem_tarifa:
		frappe.msgprint(
			_("Sem tarifa (não incluídos): {0}. Defina a <b>Faturação por Regime</b> no contrato.").format(
				", ".join(sem_tarifa)),
			title=_("Tarifas em Falta"), indicator="orange")
	if activos_contratos and get_last_day(mes) < getdate(nowdate()):
		frappe.msgprint(
			_("Contratos em <b>Vigilantes Activos</b> foram contados com o efectivo <b>de hoje</b>, "
			  "não o de {0}. Confirme as quantidades.").format(mes_label),
			title=_("Mês Já Encerrado"), indicator="orange")

	return si.as_dict()
