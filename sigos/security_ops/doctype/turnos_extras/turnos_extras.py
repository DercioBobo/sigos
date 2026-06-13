import frappe
from frappe import _
from frappe.model.document import Document


class TurnosExtras(Document):
	def on_submit(self):
		self.aprovado_por = frappe.session.user

		from sigos.timeline import registar
		from frappe.utils import formatdate
		texto = _("Turno extra — <b>{0}</b> no posto <b>{1}</b> · {2}").format(
			self.get("turno") or "-", self.get("posto") or "-",
			formatdate(self.data) if self.get("data") else "-")
		if self.get("motivo"):
			texto += _(" · motivo: {0}").format(self.motivo)
		registar(self.get("vigilante"), texto, self)
