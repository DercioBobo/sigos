"""Exclusive outcomes of a Participação.

The Jurista's Recusa (final, with a motivo), a Termo de Responsabilidade
(Jurista's, not PD-born) or a Denúncia closes the
participação: nothing else (Repreensão, Processo Disciplinar, the other one) may
follow. Deleting/cancelling the outcome reopens it.
"""

import frappe
from frappe import _


def desfecho_exclusivo(participacao, excluir=None):
	"""(label, name) of the participação's exclusive outcome, or None."""
	if not participacao:
		return None
	if frappe.db.get_value("Participacao", participacao, "recusada"):
		return _("Recusa do Jurista"), participacao
	t =frappe.db.get_value("Termo De Responsabilidade",
		{"participacao": participacao, "processo_disciplinar": ["is", "not set"],
		 "docstatus": ["<", 2], "name": ["!=", excluir or ""]})
	if t:
		return _("Termo de Responsabilidade"), t
	d = frappe.db.get_value("Denuncia",
		{"participacao": participacao, "docstatus": ["<", 2], "name": ["!=", excluir or ""]})
	if d:
		return _("Denúncia"), d
	return None


def exigir_livre(participacao, accao, excluir=None):
	x = desfecho_exclusivo(participacao, excluir)
	if x:
		frappe.throw(_("Esta participação foi encerrada com {0} <b>{1}</b> — não admite {2}.").format(
			x[0], x[1], accao), title=_("Participação Encerrada"))
