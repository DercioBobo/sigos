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


class OutrasDeducoes(Document):

	def validate(self):
		self._aplicar_mes_referencia()
		self._calcular_valor_mensal()
		self._calcular_data_fim()
		self._validar_mes_nao_passado()

	# ─── Computed fields ──────────────────────────────────────────────────────

	def _aplicar_mes_referencia(self):
		"""Derive data_de_inicio from mes_referencia (1st of the resolved month) when
		it isn't already set, so a manual date is never clobbered. Year follows the
		Dez→Jan wrap rule in ano_para_mes."""
		if self.data_de_inicio or not self.mes_referencia:
			return
		mes_num = MESES.get(self.mes_referencia)
		if not mes_num:
			return
		self.data_de_inicio = f"{ano_para_mes(int(mes_num))}-{mes_num}-01"

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
