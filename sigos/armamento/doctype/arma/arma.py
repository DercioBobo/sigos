import frappe
from frappe import _
from frappe.model.document import Document


class Arma(Document):

	def validate(self):
		self._validar_posto_na_delegacao()

	def _validar_posto_na_delegacao(self):
		"""
		The weapon is owned by a delegação and stays at a posto within it (handed
		guard-to-guard across rounds). A posto from another delegação would put the
		weapon outside its armory's control, so we block it. Also auto-fills the
		delegação from the posto when it was left blank (e.g. legacy/imported rows).
		"""
		if not self.posto:
			return

		posto_deleg = frappe.db.get_value("Posto De Vigilancia", self.posto, "delegacao")
		if not posto_deleg:
			return

		if not self.delegacao:
			self.delegacao = posto_deleg
		elif self.delegacao != posto_deleg:
			frappe.throw(
				_("O posto <b>{0}</b> pertence à delegação <b>{1}</b>, mas a arma está "
				  "registada na delegação <b>{2}</b>. Escolha um posto da mesma delegação.").format(
					self.posto, posto_deleg, self.delegacao
				),
				title=_("Posto de Outra Delegação"),
			)
