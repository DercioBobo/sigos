import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_months, add_days, getdate


MESES = {
	"Janeiro": "01", "Fevereiro": "02", "Março": "03", "Abril": "04",
	"Maio": "05", "Junho": "06", "Julho": "07", "Agosto": "08",
	"Setembro": "09", "Outubro": "10", "Novembro": "11", "Dezembro": "12",
}


class OutrasRemuneracoes(Document):

	def validate(self):
		self._calcular_valor_mensal()
		self._calcular_datas()

	def _calcular_valor_mensal(self):
		total = self.valor_a_pagar or 0
		meses = self.meses_a_pagar or 0
		self.valor_mensal = round(total / meses, 2) if meses > 0 else 0

	def _calcular_datas(self):
		if not self.mes_referencia:
			return

		mes_num = MESES.get(self.mes_referencia)
		if not mes_num:
			return

		ano = getdate().year
		self.data_de_inicio = f"{ano}-{mes_num}-01"

		if self.tipo_de_pagamento == "Determinado":
			self.meses_a_pagar = 1

		meses = self.meses_a_pagar or 1
		# Last day of the final covered month — must match the client formula exactly
		# (last-day-of-month), or the form re-dirties on every refresh (stale "Not Saved").
		self.data_de_fim = add_days(add_months(self.data_de_inicio, meses), -1)
