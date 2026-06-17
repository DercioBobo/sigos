import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_months, add_days, getdate


class OutrasDeducoes(Document):

	def validate(self):
		self._calcular_valor_mensal()
		self._calcular_data_fim()

	# ─── Computed fields ──────────────────────────────────────────────────────

	def _calcular_valor_mensal(self):
		if self.valor_a_pagar and self.meses_a_pagar and self.meses_a_pagar > 0:
			self.valor_mensal = round(self.valor_a_pagar / self.meses_a_pagar, 2)
		else:
			self.valor_mensal = 0

	def _calcular_data_fim(self):
		# Last day of the final covered month — must match the client formula
		# (add_months then −1 day) exactly, or the form re-dirties on every refresh.
		if self.data_de_inicio and self.meses_a_pagar and self.meses_a_pagar > 0:
			self.data_de_fim = add_days(add_months(self.data_de_inicio, self.meses_a_pagar), -1)
