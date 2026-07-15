import frappe
from frappe import _
from frappe.model.document import Document


class SIGOSSettings(Document):

	def validate(self):
		self._validar_dia_corte_folha()

	def _validar_dia_corte_folha(self):
		# Capped below 29 so every month (incl. February) always has that day —
		# no realistic cutoff-day policy needs day 29-31 anyway.
		dia = self.get("dia_corte_folha")
		if dia and not (1 <= dia <= 28):
			frappe.throw(
				_("Dia de Corte deve estar entre 1 e 28."),
				title=_("Dia de Corte Inválido"),
			)


def get_settings() -> "SIGOSSettings":
	return frappe.get_single("SIGOS Settings")
