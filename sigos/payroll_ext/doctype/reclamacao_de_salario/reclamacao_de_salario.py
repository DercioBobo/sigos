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
		self._resolver_folha_processada()
		self._calcular_datas_periodo()
		self._validar_mes_a_ser_pago()
		self._calcular_dia_fim_falta()

	def _resolver_folha_processada(self):
		"""Find the processed Salary Slip for the claimed month and surface what the
		system actually paid (gross + net) as read-only reference. Always recomputed
		from funcionario + mês/ano de reclamação so the figures can't go stale.
		When no slip is found the fields are left BLANK (not 0) — a claim for a
		genuinely-unpaid month is valid, so this never blocks the save; it just means
		'no processed payment on record'."""
		self.slip_do_funcionario = None
		self.valor_bruto_processado = None
		self.valor_liquido_processado = None

		res = resolver_folha_reclamacao(
			self.funcionario, self.mes_de_reclamacao, self.ano_de_reclamacao
		)
		if res:
			self.slip_do_funcionario = res["slip"]
			self.valor_bruto_processado = res["bruto"]
			self.valor_liquido_processado = res["liquido"]

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

		hoje = getdate()
		mes = int(mes_num)
		# Resolve to the nearest current/future occurrence: a month-name already behind
		# us this year means next year (e.g. "Janeiro" chosen in Dezembro → next Jan).
		ano = hoje.year if mes >= hoje.month else hoje.year + 1

		from sigos.utils import resolver_periodo_folha
		self.data_de_inicio, self.data_de_fim = resolver_periodo_folha(mes, ano)

	def _calcular_dia_fim_falta(self):
		if not self.dia_da_falta_inicio or not self.numero_faltas:
			return
		self.dia_da_falta_do_fim = add_days(
			self.dia_da_falta_inicio, (self.numero_faltas or 1) - 1
		)


@frappe.whitelist()
def resolver_folha_reclamacao(funcionario, mes=None, ano=None):
	"""Locate the submitted Salary Slip for `funcionario` covering the given month/year
	and return its processed amounts. Used both by the controller (authoritative, on
	save) and by the form (live preview). Returns {} when inputs are incomplete or no
	slip exists. Picks the most recent slip if more than one overlaps the month."""
	from frappe.utils import cint
	from sigos.utils import resolver_periodo_folha

	mes_num = MESES.get(mes)
	ano = cint(ano)
	if not (funcionario and mes_num and ano):
		return {}

	inicio, fim = resolver_periodo_folha(int(mes_num), ano)

	slips = frappe.get_all(
		"Salary Slip",
		filters={
			"employee": funcionario,
			"docstatus": 1,
			"start_date": ["<=", fim],
			"end_date": [">=", inicio],
		},
		fields=["name", "gross_pay", "net_pay"],
		order_by="start_date desc",
		limit=1,
	)
	if not slips:
		return {}
	s = slips[0]
	return {"slip": s.name, "bruto": s.gross_pay or 0, "liquido": s.net_pay or 0}
