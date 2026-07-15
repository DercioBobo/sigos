import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_months, add_days, getdate


MESES = {
	"Janeiro": "01", "Fevereiro": "02", "Março": "03", "Abril": "04",
	"Maio": "05", "Junho": "06", "Julho": "07", "Agosto": "08",
	"Setembro": "09", "Outubro": "10", "Novembro": "11", "Dezembro": "12",
}


def ano_para_mes(mes):
	"""Year for the chosen month, anchored to today:
	  - current month or later  → current year;
	  - earlier month, only at year-end (we're in December) → next year (Dez→Jan wrap);
	  - any other earlier month  → current year (a genuine past month — left to be
	    rejected by the past-month validation, e.g. Março escolhido em Junho).
	"""
	hoje = getdate()
	if mes >= hoje.month:
		return hoje.year
	if hoje.month == 12:
		return hoje.year + 1
	return hoje.year


class OutrasRemuneracoes(Document):

	def validate(self):
		self._calcular_valor_mensal()
		self._calcular_datas()
		self._validar_mes_nao_passado()

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

		from sigos.utils import resolver_periodo_folha
		self.data_de_inicio = resolver_periodo_folha(int(mes_num), ano_para_mes(int(mes_num)))[0]

		if self.tipo_de_pagamento == "Determinado":
			self.meses_a_pagar = 1

		meses = self.meses_a_pagar or 1
		# Last day of the final covered month — must match the client formula exactly
		# (last-day-of-month), or the form re-dirties on every refresh (stale "Not Saved").
		self.data_de_fim = add_days(add_months(self.data_de_inicio, meses), -1)

	def _validar_mes_nao_passado(self):
		"""Reject a month already past (e.g. Março quando estamos em Junho). The Dez→Jan
		wrap in ano_para_mes keeps year-end selections in the future, so only genuine
		back-references are blocked. Edit-safe: only fires for new records or when the
		start date is actually changed."""
		if not self.data_de_inicio:
			return
		before = self.get_doc_before_save()
		if before and str(before.data_de_inicio) == str(self.data_de_inicio):
			return
		if getdate(self.data_de_inicio) < getdate().replace(day=1):
			frappe.throw(
				_("O mês seleccionado (<b>{0}</b>) já passou. Escolha o mês actual ou um "
				  "mês futuro.").format(self.mes_referencia or str(self.data_de_inicio)),
				title=_("Mês no Passado"),
			)
