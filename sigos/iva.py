"""
IVA on SIGOS invoices (Faturação Mensal, Previsão, 'Contratos SIGOS').

Which tax template a SIGOS invoice gets, in order:
  1. taxes already on the invoice (chosen by hand on the form) — kept
  2. customer is 'Isento de IVA' (custom_isento_iva)          — none
  3. an ERPNext Tax Rule that matches the customer             — that template
  4. SIGOS Settings › Modelo de IVA (same company)             — that template
  5. the company's default Sales Taxes and Charges Template    — that template
"""
import frappe
from frappe import _
from frappe.utils import cint, flt, today

MODELO = "Sales Taxes and Charges Template"
TAXA_PADRAO = 16  # IVA em Moçambique


def isento(cliente):
	return bool(frappe.db.has_column("Customer", "custom_isento_iva")
		and cint(frappe.db.get_value("Customer", cliente, "custom_isento_iva")))


def _valido(modelo, company):
	return bool(modelo) and bool(frappe.db.exists(MODELO, {"name": modelo, "company": company, "disabled": 0}))


def modelo_iva(cliente, company, data=None):
	"""The template a SIGOS invoice for this customer gets (None = no IVA)."""
	if isento(cliente):
		return None
	try:
		from erpnext.accounts.party import set_taxes
		c = frappe.db.get_value("Customer", cliente, ["customer_group", "tax_category"], as_dict=True) or {}
		regra = set_taxes(cliente, "Customer", data or today(), company,
			customer_group=c.get("customer_group"), tax_category=c.get("tax_category"))
		if _valido(regra, company):
			return regra
	except Exception:
		pass
	definido = frappe.db.get_single_value("SIGOS Settings", "modelo_iva")
	if _valido(definido, company):
		return definido
	return frappe.db.get_value(MODELO, {"company": company, "is_default": 1, "disabled": 0}, "name")


def aplicar_iva(si):
	"""Put the IVA lines on a draft SIGOS Sales Invoice (call before insert /
	calculate_taxes_and_totals). Taxes already present are left alone."""
	if si.get("taxes"):
		return
	if isento(si.customer):
		si.taxes_and_charges = None
		return
	modelo = modelo_iva(si.customer, si.company, si.get("posting_date"))
	if not modelo:
		return
	from erpnext.controllers.accounts_controller import get_taxes_and_charges
	si.taxes_and_charges = modelo
	for t in get_taxes_and_charges(MODELO, modelo) or []:
		si.append("taxes", t)


def aviso_sem_iva(company):
	"""Warning text when SIGOS invoices of this company would go out without IVA."""
	if _valido(frappe.db.get_single_value("SIGOS Settings", "modelo_iva"), company):
		return None
	if frappe.db.exists(MODELO, {"company": company, "is_default": 1, "disabled": 0}):
		return None
	return _("Sem Modelo de IVA para {0} — as facturas serão criadas sem IVA. "
		"Defina-o em Definições SIGOS › Faturação.").format(company)


@frappe.whitelist()
def criar_modelo_iva(company, conta, taxa=TAXA_PADRAO):
	"""Definições SIGOS › 'Criar Modelo de IVA': one-line template (taxa % on net
	total to the IVA account), set as SIGOS's Modelo de IVA."""
	frappe.only_for(("System Manager", "Accounts Manager"))
	taxa = flt(taxa)
	if not (0 < taxa < 100):
		frappe.throw(_("Taxa de IVA inválida."))
	if frappe.db.get_value("Account", conta, "company") != company:
		frappe.throw(_("A conta {0} não pertence à empresa {1}.").format(conta, company))
	titulo = f"IVA {taxa:g}%"
	nome = frappe.db.get_value(MODELO, {"title": titulo, "company": company}, "name")
	if not nome:
		doc = frappe.get_doc({
			"doctype": MODELO,
			"title": titulo,
			"company": company,
			"is_default": 0 if frappe.db.exists(MODELO, {"company": company, "is_default": 1}) else 1,
			"taxes": [{
				"charge_type": "On Net Total",
				"account_head": conta,
				"rate": taxa,
				"description": titulo,
			}],
		}).insert()
		nome = doc.name
	frappe.db.set_single_value("SIGOS Settings", "modelo_iva", nome)
	return nome
