import frappe
from frappe import _
from frappe.model.document import Document


class MovimentacaoDeArma(Document):

	def before_insert(self):
		if not self.referencia_da_arma:
			return

		try:
			arma_doc = frappe.get_doc("Arma", self.referencia_da_arma)
			arma_doc.posto = self.novo_posto
			arma_doc.numero_de_municoes = self.novo_numero
			arma_doc.save(ignore_permissions=True)
		except Exception as e:
			frappe.log_error(
				f"MovimentacaoDeArma: erro ao atualizar Arma {self.referencia_da_arma}: {e}",
				"SIGOS Movimentacao De Arma"
			)
