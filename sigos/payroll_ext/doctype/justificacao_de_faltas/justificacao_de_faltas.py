import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate, date_diff


class JustificacaoDeFaltas(Document):

	def validate(self):
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
