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
		self._calcular_dia_fim_falta()

	def _calcular_datas_periodo(self):
		if not self.mes_a_ser_pago:
			return

		mes_num = MESES.get(self.mes_a_ser_pago)
		if not mes_num:
			return

		import calendar
		ano = getdate().year
		mes = int(mes_num)
		ultimo_dia = calendar.monthrange(ano, mes)[1]

		self.data_de_inicio = f"{ano}-{mes_num}-01"
		self.data_de_fim    = f"{ano}-{mes_num}-{ultimo_dia:02d}"

	def _calcular_dia_fim_falta(self):
		if not self.dia_da_falta_inicio or not self.numero_faltas:
			return
		self.dia_da_falta_do_fim = add_days(
			self.dia_da_falta_inicio, (self.numero_faltas or 1) - 1
		)
