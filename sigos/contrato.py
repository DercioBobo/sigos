import frappe
from frappe import _
from frappe.utils import cint, flt


def project_validate(doc, method=None):
	"""
	Contract (Project) tables: one row per regime in each, and the Finance table's
	line totals + Total Mensal Contratado kept in sync (qty x valor).
	"""
	for campo, rotulo in (
		("custom_faturacao_regimes", _("Faturação por Regime")),
		("custom_regime_rates", _("Salários por Regime")),
	):
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

	total = 0
	for row in doc.get("custom_faturacao_regimes") or []:
		row.total = cint(row.quantidade) * flt(row.valor)
		total += row.total
	if doc.meta.has_field("custom_total_contratual"):
		doc.custom_total_contratual = total
