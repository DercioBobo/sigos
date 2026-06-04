import frappe
from frappe import _
from frappe.model.document import Document


class CategoriaVigilante(Document):

	def on_trash(self):
		if self.bloqueada:
			frappe.throw(
				_("A categoria <b>{0}</b> é de sistema e não pode ser eliminada.").format(
					self.nome
				),
				title=_("Categoria Protegida"),
			)

		# Also block deletion if any Vigilante uses this category
		em_uso = frappe.db.count("Vigilante", {"categoria": self.name})
		if em_uso:
			frappe.throw(
				_(
					"Não é possível eliminar a categoria <b>{0}</b> — "
					"está atribuída a {1} vigilante(s)."
				).format(self.nome, em_uso),
				title=_("Categoria em Uso"),
			)
