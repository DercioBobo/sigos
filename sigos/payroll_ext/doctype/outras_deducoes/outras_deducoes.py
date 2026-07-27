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
		self._fetch_salario_base()
		self._aplicar_mes_referencia()
		self._calcular_valor_mensal()
		self._validar_limite_mensal()
		self._calcular_data_fim()
		self._validar_mes_nao_passado()

	# ─── Salário base (para o tecto de %) ────────────────────────────────────────

	def _fetch_salario_base(self):
		"""Pull the latest assigned base so the % cap below is meaningful (and as a
		fallback reference when the guard has no Salary Slip history yet)."""
		if self.salario_base or not self.funcionario:
			return
		from sigos.payroll_ext.doctype.emprestimo.emprestimo import _buscar_salario_base
		base = _buscar_salario_base(self.funcionario)
		if base:
			self.salario_base = base

	def _validar_limite_mensal(self):
		"""The monthly cut can never exceed a configurable % of the guard's net
		salary — same principle as Emprestimo's prestação mensal cap, but its own
		dedicated setting (percentagem_maxima_deducao_mensal) so HR can tune it
		independently of the loan ceiling. Always a hard block, no exception: this
		money leaves take-home pay every month, regardless of what any active
		Empréstimo is separately taking."""
		excedencia = _calcular_excedencia_mensal(self.funcionario, self.salario_base, self.valor_mensal)
		if excedencia:
			frappe.throw(excedencia, title=_("Limite de Dedução Mensal Excedido"))

	# ─── Computed fields ──────────────────────────────────────────────────────

	def _aplicar_mes_referencia(self):
		"""Derive data_de_inicio from mes_referencia (start of the resolved payroll
		period, per SIGOS Settings.dia_corte_folha) when it isn't already set, so a
		manual date is never clobbered. Year follows the Dez→Jan wrap rule in
		ano_para_mes."""
		if self.data_de_inicio or not self.mes_referencia:
			return
		mes_num = MESES.get(self.mes_referencia)
		if not mes_num:
			return
		from sigos.utils import resolver_periodo_folha
		self.data_de_inicio = resolver_periodo_folha(int(mes_num), ano_para_mes(int(mes_num)))[0]

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


# ─── Limite mensal (partilhado entre a validação do servidor e o preview do form) ──

def _calcular_excedencia_mensal(funcionario, salario_base, valor_mensal):
	"""Checks the monthly cut against percentagem_maxima_deducao_mensal, using the
	same net-pay reference Emprestimo uses for its own prestação mensal cap (last
	submitted Salary Slip's net_pay, falling back to salário base when there's no
	payroll history yet). Returns the excedência message, or None when within limit."""
	from frappe.utils import flt
	from sigos.payroll_ext.doctype.emprestimo.emprestimo import _referencia_salario_liquido

	valor_mensal = flt(valor_mensal)
	if not funcionario or not valor_mensal:
		return None

	max_pct = frappe.db.get_single_value("SIGOS Settings", "percentagem_maxima_deducao_mensal") or 30
	referencia, estimado = _referencia_salario_liquido(funcionario, salario_base)
	if not referencia:
		return None

	maximo = flt(referencia) * (max_pct / 100)
	if valor_mensal <= maximo:
		return None

	fonte = (
		_("salário base — estimativa, sem folha anterior")
		if estimado else _("último salário líquido")
	)
	return _(
		"O valor mensal da dedução (<b>{0}</b>) excede <b>{1}%</b> do {2} (<b>{3}</b>). "
		"Valor mensal máximo permitido: <b>{4}</b>. Aumente o número de meses ou "
		"reduza o valor a pagar."
	).format(round(valor_mensal, 2), max_pct, fonte, referencia, round(maximo, 2))


@frappe.whitelist()
def verificar_limite_mensal(funcionario=None, salario_base=0, valor_mensal=0):
	"""Form preview of the same check _validar_limite_mensal enforces on save — lets
	the client warn before the user hits Save (no exception flow: this cap is
	always a hard block)."""
	from sigos.api import PAPEIS_SALARIO
	frappe.only_for(PAPEIS_SALARIO)
	return _calcular_excedencia_mensal(funcionario, salario_base, valor_mensal)
