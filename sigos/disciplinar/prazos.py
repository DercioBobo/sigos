"""
Prazos disciplinares — counted in calendar days from the Participação's
Data de Conhecimento da Infracção:
  - the Participação must be CREATED within SIGOS Settings.prazo_participacao_dias
    (default 10);
  - the Processo Disciplinar must be OPENED within prazo_processo_dias (default 15).
Past a deadline the action is refused; a manager (SIGOS Manager / System Manager)
can still proceed by writing a justification, which is recorded on the document
(fora_de_prazo + justificacao_fora_de_prazo). The Presunção de Abandono has no
deadline (the system itself opens it).
"""

import frappe
from frappe import _
from frappe.utils import add_days, cint, date_diff, getdate, today

PAPEIS_FORCAR_PRAZO = ("System Manager", "SIGOS Manager")


def _setting(campo, padrao):
	v = frappe.db.get_value("Singles", {"doctype": "SIGOS Settings", "field": campo}, "value")
	return padrao if v in (None, "", "0", 0) else cint(v)


def prazo_participacao():
	return _setting("prazo_participacao_dias", 10)


def prazo_processo():
	return _setting("prazo_processo_dias", 15)


def pode_forcar(user=None):
	return bool(set(frappe.get_roles(user)) & set(PAPEIS_FORCAR_PRAZO))


def estado(conhecimento, prazo, referencia=None):
	"""{limite, dias, restam, expirado} for an action done on `referencia` (default today)."""
	if not conhecimento:
		return None
	conhecimento = getdate(conhecimento)
	ref = getdate(referencia or today())
	dias = date_diff(ref, conhecimento)
	return {"conhecimento": conhecimento, "prazo": prazo, "limite": getdate(add_days(conhecimento, prazo)),
		"dias": dias, "restam": prazo - dias, "expirado": dias > prazo}


def exigir(doc, conhecimento, prazo, accao, referencia=None):
	"""Refuse `accao` when past the deadline, unless a manager justified it on `doc`
	(justificacao_fora_de_prazo) — then stamp fora_de_prazo."""
	e = estado(conhecimento, prazo, referencia)
	if not e or not e["expirado"]:
		doc.fora_de_prazo = 0
		return e
	msg = _("Fora de prazo: {0} até <b>{1} dias</b> após a Data de Conhecimento da Infracção "
		"({2}) — limite {3}, passaram <b>{4} dias</b>.").format(
		accao, prazo, frappe.format_value(e["conhecimento"], {"fieldtype": "Date"}),
		frappe.format_value(e["limite"], {"fieldtype": "Date"}), e["dias"])
	if not pode_forcar():
		frappe.throw(msg + "<br>" + _("Só um gestor (SIGOS Manager) pode avançar, com justificação."),
			title=_("Prazo Expirado"))
	if not (doc.get("justificacao_fora_de_prazo") or "").strip():
		frappe.throw(msg + "<br>" + _("Para avançar, escreva a <b>Justificação (Fora de Prazo)</b>."),
			title=_("Prazo Expirado"))
	doc.fora_de_prazo = 1
	return e


@frappe.whitelist()
def prazo_processo_da_participacao(participacao):
	"""UI: before opening a Processo from a Participação — is it still in time?"""
	frappe.has_permission("Participacao", "read", doc=participacao, throw=True)
	conhecimento = frappe.db.get_value("Participacao", participacao, "data_conhecimento_infracao")
	e = estado(conhecimento, prazo_processo()) or {}
	e["pode_forcar"] = pode_forcar()
	return e


@frappe.whitelist()
def prazos():
	return {"participacao": prazo_participacao(), "processo": prazo_processo(), "pode_forcar": pode_forcar()}
