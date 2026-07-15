import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_months

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
		base = frappe.db.get_value(
			"Salary Structure Assignment",
			{"employee": self.funcionario, "docstatus": 1},
			"base",
			order_by="from_date desc",
		)
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
		"""Enforce max months and max % of salary from Settings."""
		max_meses = (
			frappe.db.get_single_value("SIGOS Settings", "meses_maximos_emprestimo") or 3
		)
		max_pct = (
			frappe.db.get_single_value("SIGOS Settings", "percentagem_maxima_emprestimo") or 30
		)

		if self.meses_a_pagar and self.meses_a_pagar > max_meses:
			frappe.throw(
				_("Para empréstimos, o máximo é de <b>{0} meses</b>.").format(max_meses),
				title=_("Limite de Meses Excedido"),
			)

		if self.salario_base and self.valor_a_pagar:
			maximo = self.salario_base * (max_pct / 100)
			if self.valor_a_pagar > maximo:
				frappe.throw(
					_("O valor do empréstimo (<b>{0}</b>) excede <b>{1}%</b> do salário base. "
					  "Valor máximo permitido: <b>{2}</b>.").format(
						self.valor_a_pagar, max_pct, round(maximo, 2)
					),
					title=_("Valor Excedido"),
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
