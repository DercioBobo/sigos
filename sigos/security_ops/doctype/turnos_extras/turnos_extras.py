import frappe
from frappe.model.document import Document


class TurnosExtras(Document):
	def on_submit(self):
		self.aprovado_por = frappe.session.user
