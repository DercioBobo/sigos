"""
SIGOS — Vigilante timeline.

Every operational document that changes a guard's situation leaves an Info entry
on the Vigilante's timeline (Rotatividade, Troca De Regime/Categoria, Demissão,
Readmissão, Ausências, Turnos Extras). Entries are Comments of type "Info" —
they render as grey activity lines in the form's timeline, with a link back to
the originating document.

A timeline entry must NEVER break the operation that writes it — all failures
are swallowed into the error log.
"""
import frappe


def registar(vigilante: str, texto: str, origem=None):
	"""Add an Info timeline entry to the Vigilante. `origem` = source doc (linked)."""
	if not vigilante:
		return
	try:
		if not frappe.db.exists("Vigilante", vigilante):
			return
		conteudo = texto
		if origem is not None and getattr(origem, "name", None):
			url = frappe.utils.get_url_to_form(origem.doctype, origem.name)
			conteudo += f" &middot; <a href='{url}'>{origem.name}</a>"
		frappe.get_doc({
			"doctype": "Comment",
			"comment_type": "Info",
			"reference_doctype": "Vigilante",
			"reference_name": vigilante,
			"content": conteudo,
		}).insert(ignore_permissions=True)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "SIGOS Timeline")
