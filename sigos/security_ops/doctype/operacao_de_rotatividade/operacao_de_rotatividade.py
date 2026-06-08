import frappe
from frappe import _
from frappe.model.document import Document


class OperacaoDeRotatividade(Document):

	def on_trash(self):
		if self.bloqueada:
			frappe.throw(
				_("A operação <b>{0}</b> é de sistema e não pode ser eliminada. "
				  "Desmarque <b>Activa</b> para a ocultar.").format(self.name),
				title=_("Operação Bloqueada"),
			)
