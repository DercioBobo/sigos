import json

import frappe
from frappe import _
from frappe.model.document import Document


class ProjectSubsidioItem(Document):

	def validate(self):
		self._sincronizar_resumo_beneficiarios()

	def _sincronizar_resumo_beneficiarios(self):
		"""Keeps the read-only summary column in sync server-side too — the client
		script (project_subsidio_item.js) already updates it live, but this is the
		authority (e.g. for a Data Import or any other non-UI write path)."""
		if self.aplicar_a != "Vigilantes Específicos":
			self.vigilantes_json = "[]"
			self.resumo_beneficiarios = _("Todos")
			return

		try:
			selecionados = json.loads(self.vigilantes_json or "[]")
		except (TypeError, ValueError):
			selecionados = []

		self.resumo_beneficiarios = (
			_("{0} vigilante(s) seleccionado(s)").format(len(selecionados))
			if selecionados else _("Nenhum seleccionado")
		)
