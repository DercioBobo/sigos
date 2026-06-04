import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_months, getdate


class Deducoes(Document):

	def validate(self):
		self._validar_emprestimo_ativo()
		self._validar_limites_emprestimo()
		self._calcular_valor_mensal()
		self._calcular_data_fim()

	# ─── Rules ────────────────────────────────────────────────────────────────

	def _validar_emprestimo_ativo(self):
		"""Only one active Emprestimo per employee at a time."""
		if self.tipo != "Emprestimo" or not self.funcionario:
			return

		ativo = frappe.get_all(
			"Deducoes",
			filters={
				"funcionario": self.funcionario,
				"tipo": "Emprestimo",
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

	def _validar_limites_emprestimo(self):
		"""Enforce max months and max % of salary from Settings."""
		if self.tipo != "Emprestimo":
			return

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

	# ─── Computed fields ──────────────────────────────────────────────────────

	def _calcular_valor_mensal(self):
		if self.valor_a_pagar and self.meses_a_pagar and self.meses_a_pagar > 0:
			self.valor_mensal = round(self.valor_a_pagar / self.meses_a_pagar, 2)
		else:
			self.valor_mensal = 0

	def _calcular_data_fim(self):
		if self.data_de_inicio and self.meses_a_pagar and self.meses_a_pagar > 0:
			self.data_de_fim = add_months(self.data_de_inicio, self.meses_a_pagar)
