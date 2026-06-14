import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_days, getdate


MESES = {
	"Janeiro": "01", "Fevereiro": "02", "Março": "03", "Abril": "04",
	"Maio": "05", "Junho": "06", "Julho": "07", "Agosto": "08",
	"Setembro": "09", "Outubro": "10", "Novembro": "11", "Dezembro": "12",
}


class ReclamacaoDeSalario(Document):

	def validate(self):
		self._calcular_datas_periodo()
		self._validar_mes_a_ser_pago()
		self._calcular_dia_fim_falta()

	def _validar_mes_a_ser_pago(self):
		"""
		A reclamação is paid out on the target month's slip, so that month must still
		be open:
		  (a) it cannot be a month already in the past, and
		  (b) it cannot be a month whose Salary Slip was already submitted for this
		      employee (that slip has run — the retroactivo would never be applied).
		Anchored to the server's today (not self.data) so backdating the document can't
		slip a closed month through.
		"""
		if not self.data_de_inicio or not self.data_de_fim:
			return

		inicio_mes_actual = getdate().replace(day=1)
		if getdate(self.data_de_fim) < inicio_mes_actual:
			frappe.throw(
				_("O mês a ser pago ({0}) já passou. Só pode reclamar para o mês "
				  "actual ou um mês futuro.").format(self.mes_a_ser_pago)
			)

		if not self.funcionario:
			return

		slip = frappe.get_all(
			"Salary Slip",
			filters={
				"employee": self.funcionario,
				"docstatus": 1,
				"start_date": ["<=", self.data_de_fim],
				"end_date": [">=", self.data_de_inicio],
			},
			fields=["name"],
			limit=1,
		)
		if slip:
			frappe.throw(
				_("Já existe uma Salary Slip submetida ({0}) para este funcionário no "
				  "período de {1}. Não é possível reclamar para um mês já processado — "
				  "corrija a slip por amendment.").format(slip[0].name, self.mes_a_ser_pago)
			)

	def _calcular_datas_periodo(self):
		if not self.mes_a_ser_pago:
			return

		mes_num = MESES.get(self.mes_a_ser_pago)
		if not mes_num:
			return

		import calendar
		hoje = getdate()
		mes = int(mes_num)
		# Resolve to the nearest current/future occurrence: a month-name already behind
		# us this year means next year (e.g. "Janeiro" chosen in Dezembro → next Jan).
		ano = hoje.year if mes >= hoje.month else hoje.year + 1
		ultimo_dia = calendar.monthrange(ano, mes)[1]

		self.data_de_inicio = f"{ano}-{mes_num}-01"
		self.data_de_fim    = f"{ano}-{mes_num}-{ultimo_dia:02d}"

	def _calcular_dia_fim_falta(self):
		if not self.dia_da_falta_inicio or not self.numero_faltas:
			return
		self.dia_da_falta_do_fim = add_days(
			self.dia_da_falta_inicio, (self.numero_faltas or 1) - 1
		)
