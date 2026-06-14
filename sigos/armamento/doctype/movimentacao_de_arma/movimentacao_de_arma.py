import frappe
from frappe import _
from frappe.model.document import Document


class MovimentacaoDeArma(Document):

	def on_submit(self):
		"""Apply the transfer to the Arma. Errors (e.g. posto in another delegação,
		caught by Arma.validate) surface here and block the submission — the register
		never drifts out of sync with the movement."""
		self._aplicar_no_arma(self.novo_posto, self.novo_numero)

	def on_cancel(self):
		"""Reverse the transfer, restoring the posto/ammo captured at registration —
		but only if no later movement has since moved the weapon, to avoid clobbering
		a newer allocation."""
		if not self.referencia_da_arma:
			return

		atual = frappe.db.get_value("Arma", self.referencia_da_arma, "posto")
		if atual != self.novo_posto:
			frappe.msgprint(
				_("A arma já foi movida novamente depois deste registo — a alocação "
				  "atual foi mantida."),
				indicator="orange",
				alert=True,
			)
			return

		self._aplicar_no_arma(self.posto_atual or None, self.numero_municoes_atual or 0)

	def _aplicar_no_arma(self, posto, municoes):
		arma_doc = frappe.get_doc("Arma", self.referencia_da_arma)
		arma_doc.posto = posto
		arma_doc.numero_de_municoes = municoes
		arma_doc.save(ignore_permissions=True)
