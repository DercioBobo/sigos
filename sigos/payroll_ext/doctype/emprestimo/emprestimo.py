import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_months, cint, flt

MESES = {
	"Janeiro": "01", "Fevereiro": "02", "Março": "03", "Abril": "04",
	"Maio": "05", "Junho": "06", "Julho": "07", "Agosto": "08",
	"Setembro": "09", "Outubro": "10", "Novembro": "11", "Dezembro": "12",
}


class Emprestimo(Document):

	def validate(self):
		self._fetch_salario_base()
		self._validar_emprestimo_ativo()
		self._validar_limites()
		self._aplicar_mes_referencia()
		self._calcular_valor_mensal()
		self._calcular_data_fim()

	# ─── Salário base (para o tecto de %) ────────────────────────────────────────

	def _fetch_salario_base(self):
		"""Pull the latest assigned base so the % cap below is meaningful."""
		if self.salario_base or not self.funcionario:
			return
		base = _buscar_salario_base(self.funcionario)
		if base:
			self.salario_base = base

	# ─── Regras ──────────────────────────────────────────────────────────────────

	def _validar_emprestimo_ativo(self):
		"""Only one active loan per employee at a time."""
		if not self.funcionario:
			return

		ativo = frappe.get_all(
			"Emprestimo",
			filters={
				"funcionario": self.funcionario,
				"docstatus": 1,
				"estado": "Activo",
				"name": ["!=", self.name or "__new__"],
			},
			fields=["name", "data_de_fim"],
			limit=1,
		)
		if ativo:
			frappe.throw(
				_("O funcionário já possui um empréstimo activo: <b>{0}</b> "
				  "(termina em <b>{1}</b>). Não é possível criar um novo até o actual terminar.").format(
					ativo[0].name, ativo[0].data_de_fim
				),
				title=_("Empréstimo Activo"),
			)

	def _validar_limites(self):
		"""Max months and max % of net pay (monthly installment) are hard limits —
		always enforced, no exception possible: they protect what actually leaves
		the employee's pay each month. Only the total loan value (% of salário
		base) can be overridden via an authorized exception (excepcao_limite +
		motivo_excepcao), since operations sometimes needs to lend more than the
		employee's salary up front — that amount is received once, not deducted
		monthly, so it doesn't threaten take-home pay the way the other two do."""
		limites = _calcular_excedencias(
			self.funcionario, self.salario_base, self.valor_a_pagar, self.meses_a_pagar
		)

		if limites["bloqueantes"]:
			frappe.throw(
				"<br>".join(limites["bloqueantes"]),
				title=_("Limite de Empréstimo Excedido"),
			)

		if limites["excepcionaveis"] and not (self.excepcao_limite and self.motivo_excepcao):
			frappe.throw(
				"<br>".join(limites["excepcionaveis"]),
				title=_("Limite de Empréstimo Excedido"),
			)

	# ─── Campos calculados ───────────────────────────────────────────────────────

	def _aplicar_mes_referencia(self):
		if not self.data_de_inicio and self.mes_referencia:
			mes_num = MESES.get(self.mes_referencia)
			if mes_num:
				from frappe.utils import getdate
				from sigos.utils import resolver_periodo_folha
				self.data_de_inicio = resolver_periodo_folha(int(mes_num), getdate().year)[0]

	def _calcular_valor_mensal(self):
		if self.valor_a_pagar and self.meses_a_pagar and self.meses_a_pagar > 0:
			self.valor_mensal = round(self.valor_a_pagar / self.meses_a_pagar, 2)
		else:
			self.valor_mensal = 0

	def _calcular_data_fim(self):
		if self.data_de_inicio and self.meses_a_pagar and self.meses_a_pagar > 0:
			self.data_de_fim = add_months(self.data_de_inicio, self.meses_a_pagar)


# ─── Salário base (partilhado entre a validação do servidor e o preview do form) ──

def _buscar_salario_base(funcionario):
	return frappe.db.get_value(
		"Salary Structure Assignment",
		{"employee": funcionario, "docstatus": 1},
		"base",
		order_by="from_date desc",
	)


@frappe.whitelist()
def buscar_salario_base(funcionario):
	"""Lets the form show salário base — and therefore the limit previews and
	defaults that depend on it — as soon as the funcionário is picked, instead
	of only after the first save."""
	return _buscar_salario_base(funcionario)


# ─── Limites (partilhado entre a validação do servidor e o preview do form) ──

def _referencia_salario_liquido(funcionario, salario_base):
	"""Best available net-pay reference for the monthly-installment cap: the
	employee's most recent submitted Salary Slip net_pay (real net). Falls
	back to salario_base for employees with no payroll history yet (e.g.
	brand-new hires) — flagged as an estimate since base isn't true net."""
	net_pay = frappe.db.get_value(
		"Salary Slip",
		{"employee": funcionario, "docstatus": 1},
		"net_pay",
		order_by="end_date desc",
	)
	if net_pay:
		return net_pay, False
	return salario_base, True


def _calcular_excedencias(funcionario, salario_base, valor_a_pagar, meses_a_pagar):
	"""Checks the three configured limits and splits any violation into two
	buckets:
	- bloqueantes: max months and max % of net pay for the monthly installment —
	  hard limits, never overridable (they cap what leaves the employee's pay).
	- excepcionaveis: max % of salário base for the total loan value — can be
	  waived via an authorized exception (excepcao_limite + motivo_excepcao),
	  since the amount is received once and doesn't affect monthly take-home pay.
	Empty lists = within all limits."""
	salario_base = flt(salario_base)
	valor_a_pagar = flt(valor_a_pagar)
	meses_a_pagar = cint(meses_a_pagar)

	max_meses = frappe.db.get_single_value("SIGOS Settings", "meses_maximos_emprestimo") or 3
	max_pct = frappe.db.get_single_value("SIGOS Settings", "percentagem_maxima_emprestimo") or 100
	max_pct_mensal = (
		frappe.db.get_single_value("SIGOS Settings", "percentagem_maxima_prestacao_mensal") or 30
	)

	bloqueantes = []
	excepcionaveis = []

	if meses_a_pagar and meses_a_pagar > max_meses:
		bloqueantes.append(
			_("Meses a pagar (<b>{0}</b>) excede o máximo de <b>{1}</b>.").format(meses_a_pagar, max_meses)
		)

	if salario_base and valor_a_pagar:
		maximo = salario_base * (max_pct / 100)
		if valor_a_pagar > maximo:
			excepcionaveis.append(
				_("O valor do empréstimo (<b>{0}</b>) excede <b>{1}%</b> do salário base. "
				  "Valor máximo permitido: <b>{2}</b>.").format(
					valor_a_pagar, max_pct, round(maximo, 2)
				)
			)

	if valor_a_pagar and meses_a_pagar and meses_a_pagar > 0:
		mensal = valor_a_pagar / meses_a_pagar
		referencia, estimado = _referencia_salario_liquido(funcionario, salario_base)
		if referencia:
			maximo_mensal = referencia * (max_pct_mensal / 100)
			if mensal > maximo_mensal:
				fonte = (
					_("salário base — estimativa, sem folha anterior")
					if estimado else _("último salário líquido")
				)
				bloqueantes.append(
					_("A prestação mensal (<b>{0}</b>) excede <b>{1}%</b> do {2} (<b>{3}</b>). "
					  "Prestação máxima permitida: <b>{4}</b>. Aumente o número de meses ou "
					  "reduza o valor do empréstimo.").format(
						round(mensal, 2), max_pct_mensal, fonte, referencia, round(maximo_mensal, 2)
					)
				)

	return {"bloqueantes": bloqueantes, "excepcionaveis": excepcionaveis}


@frappe.whitelist()
def verificar_limites(funcionario=None, salario_base=0, valor_a_pagar=0, meses_a_pagar=0):
	"""Form preview of the same limit checks _validar_limites enforces on save —
	lets the client prompt for an authorized exception before the user hits Save."""
	return _calcular_excedencias(funcionario, salario_base, valor_a_pagar, meses_a_pagar)
