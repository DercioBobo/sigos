import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate, date_diff, flt

from sigos.utils import calcular_faltas_vigilante


class JustificacaoDeFaltas(Document):

	def validate(self):
		self._recompute_numero()
		self._validar_prazo()

	def _recompute_numero(self):
		"""
		`numero` (justified faltas) is authoritative server-side — never trust the
		value that arrives from the form/API. Recompute it from the SAME escala-aware
		source the salary slip uses for faltas (calcular_faltas_vigilante), so a
		justification can never credit more faltas than actually occurred in its window.
		This closes the deduction-suppression vector (inflating numero to shrink the
		Faltas deduction). An over-claim is logged for the audit trail.
		"""
		submetido = flt(self.numero)

		if self.vigilante and self.dia_de_inicio and self.dia_de_fim:
			real = calcular_faltas_vigilante(self.vigilante, self.dia_de_inicio, self.dia_de_fim)
		else:
			real = 0

		if submetido > real:
			frappe.log_error(
				f"Justificacao De Faltas {self.name or '(nova)'}: numero submetido "
				f"({submetido}) excede as faltas reais ({real}) de {self.vigilante} "
				f"entre {self.dia_de_inicio} e {self.dia_de_fim}. Corrigido para {real}.",
				"SIGOS Justificacao Numero",
			)

		self.numero = real

	def _validar_prazo(self):
		if not self.dia_de_fim or not self.data_do_justificativo:
			return

		prazo = frappe.db.get_single_value("SIGOS Settings", "prazo_justificacao_faltas") or 3

		diff = date_diff(self.data_do_justificativo, self.dia_de_fim)
		if diff > prazo:
			frappe.throw(
				_("O prazo para justificar faltas é de {0} dias após a falta. "
				  "A data do justificativo ({1}) está {2} dias depois do fim da falta ({3}).").format(
					prazo,
					self.data_do_justificativo,
					diff,
					self.dia_de_fim
				)
			)


@frappe.whitelist()
def preview_numero(vigilante, dia_de_inicio, dia_de_fim):
	"""
	Form preview of `numero` — returns the SAME escala-aware count that
	_recompute_numero stamps on save, so what the user sees matches what is stored.
	"""
	if not (vigilante and dia_de_inicio and dia_de_fim):
		return 0
	return calcular_faltas_vigilante(vigilante, dia_de_inicio, dia_de_fim)
