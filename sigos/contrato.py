import frappe
from frappe import _
from frappe.utils import cint, flt


def project_validate(doc, method=None):
	"""
	Contract (Project) tables: one row per regime in each, and the Finance table's
	line totals + Total Mensal Contratado kept in sync (qty x valor).
	"""
	_regimes_unicos(doc, "custom_faturacao_regimes", _("Faturação por Regime"))
	_regimes_unicos(doc, "custom_regime_rates", _("Salários por Regime"))

	# A row without its own price uses the customer's (Tarifas por Regime).
	do_cliente = tarifas_do_cliente(doc.customer)
	total = 0
	for row in doc.get("custom_faturacao_regimes") or []:
		valor = flt(row.valor) or flt((do_cliente.get(row.regime) or {}).get("valor"))
		row.total = cint(row.quantidade) * valor
		total += row.total
	if doc.meta.has_field("custom_total_contratual"):
		doc.custom_total_contratual = total


def customer_validate(doc, method=None):
	"""Customer 'Tarifas por Regime': one row per regime."""
	_regimes_unicos(doc, "custom_tarifas_regime", _("Tarifas por Regime"))


def _regimes_unicos(doc, campo, rotulo):
	vistos = set()
	for row in doc.get(campo) or []:
		if not row.regime:
			continue
		if row.regime in vistos:
			frappe.throw(
				_("O regime <b>{0}</b> aparece mais de uma vez em <b>{1}</b> (linha {2}).").format(
					row.regime, rotulo, row.idx),
				title=_("Regime Duplicado"),
			)
		vistos.add(row.regime)


# ─── Billing rate: contract first, then the customer ─────────────────────────

def tarifas_dos_clientes(clientes):
	"""{(cliente, regime): {valor, descricao}} from each Customer's Tarifas por Regime."""
	clientes = [c for c in set(clientes or []) if c]
	if not clientes or not frappe.db.table_exists("Customer Tarifa Regime"):
		return {}
	return {
		(r.parent, r.regime): r
		for r in frappe.get_all("Customer Tarifa Regime",
			filters={"parenttype": "Customer", "parent": ["in", clientes]},
			fields=["parent", "regime", "valor", "descricao"])
	}


def tarifas_do_cliente(cliente):
	"""{regime: {valor, descricao}} for one customer."""
	return {regime: r for (_c, regime), r in tarifas_dos_clientes([cliente]).items()}


def resolver_tarifa(linha_contrato, tarifa_cliente):
	"""
	The ONE rule for a contract+regime billing rate, used everywhere (billing lines,
	stale-preview check, contract totals, rate API):
	  1. the contract's own Valor / Vigilante, when set;
	  2. else the customer's Tarifas por Regime;
	  3. else unpriced (0, '') — flagged 'sem tarifa', never billed.
	Returns (valor, origem, descricao) — origem 'Contrato' | 'Cliente' | ''.
	"""
	if linha_contrato and flt(linha_contrato.get("valor")):
		return flt(linha_contrato.get("valor")), "Contrato", (linha_contrato.get("descricao") or "")
	desc_contrato = (linha_contrato or {}).get("descricao") or ""
	if tarifa_cliente and flt(tarifa_cliente.get("valor")):
		return (flt(tarifa_cliente.get("valor")), "Cliente",
			desc_contrato or (tarifa_cliente.get("descricao") or ""))
	return 0.0, "", desc_contrato


# ─── Billing unit: per service or per guard (chosen in the billing profile) ──────

def vigilantes_por_servico_regimes():
	"""{regime: guards per billed service} from the Regime (default 1)."""
	if not frappe.db.has_column("Regime", "vigilantes_por_servico"):
		return {}
	return {r.name: cint(r.vigilantes_por_servico) or 1
		for r in frappe.get_all("Regime", fields=["name", "vigilantes_por_servico"])}


def servicos(vigilantes, perfil, regime, por_regime):
	"""Billed quantity for `vigilantes` guards of one posto in `regime`. Per guard:
	the guard count. Per service: guards ÷ guards-per-service (the profile's
	exception for the regime, else the Regime's), rounded UP — a short-staffed posto
	still bills its whole service."""
	from sigos.perfil_faturacao import FATURAR_SERVICO, vigilantes_por_servico
	vigilantes = cint(vigilantes)
	if perfil.faturar_por != FATURAR_SERVICO or vigilantes <= 0:
		return vigilantes
	return -(-vigilantes // vigilantes_por_servico(perfil, regime, por_regime))


@frappe.whitelist()
def get_tarifas_cliente(customer):
	"""Contract form: the customer's rates, to show live totals for rows without a price."""
	if not customer:
		return {}
	frappe.has_permission("Customer", "read", customer, throw=True)
	return {regime: flt(r.valor) for regime, r in tarifas_do_cliente(customer).items()}
