import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_months, getdate


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
		if self.data_de_inicio and self.meses_a_pagar and self.meses_a_pagar > 0:
			self.data_de_fim = add_months(self.data_de_inicio, self.meses_a_pagar)
