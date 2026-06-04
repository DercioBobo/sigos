import frappe
from frappe import _
from frappe.model.document import Document


class Turno(Document):

	def validate(self):
		if self.e_folga and not self.periodo:
			# Folga turns don't need a periodo — that's fine
			pass
		if not self.e_folga and not self.periodo:
			frappe.msgprint(
				_("Turnos de trabalho devem ter um Período definido (Manhã, Noite ou Tarde)."),
				alert=True,
				indicator="orange",
			)
