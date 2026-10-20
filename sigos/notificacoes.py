"""
Signals for Frappe Notifications (Setup -> Notification, "Send Alert On: Method").

Some SIGOS changes are written straight to the database (no document save), so a
"New"/"Save"/"Value Change" Notification never sees them. For those, the code calls
sinal(doctype, name, metodo): it reloads the document and runs `metodo` through
Document.run_method, which fires every enabled Notification of that doctype with
Event = "Method" and Method = `metodo` (the method itself doesn't need to exist).

Signals (doctype: method):
  Vigilante: sigos_limite_faltas_atingido   abandono threshold reached (alert)
  Vigilante: sigos_salario_congelado        salary frozen (auto or by hand)
  Vigilante: sigos_salario_descongelado     salary unfrozen (auto or by hand)
  Participacao: sigos_suspensao_preventiva  guard suspended from this participacao
  Participacao: sigos_suspensao_terminada   suspension ended with a return
  Processo Disciplinar: sigos_pd_sindicato  diligencias overdue -> Sindicato
  Processo Disciplinar: sigos_pd_caducado   30 days without a decision
A failing Notification never breaks the action that emitted the signal.
"""

import frappe


def sinal(doctype, name, metodo):
	try:
		frappe.get_doc(doctype, name).run_method(metodo)
	except Exception as e:
		frappe.log_error(f"Sinal {metodo} ({doctype} {name}): {e}", "SIGOS Notificacoes")
