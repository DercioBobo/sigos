import frappe
from frappe import _
from frappe.model.document import Document


class TrocaDeCategoria(Document):

	def on_submit(self):
		if (self.get("workflow_state") or "Aprovado") != "Aprovado":
			return

		if not self.vigilante:
			return

		try:
			vigilante_doc = frappe.get_doc("Vigilante", self.vigilante)
			categoria_antiga = vigilante_doc.categoria
			vigilante_doc.categoria = self.categoria_nova
			vigilante_doc.save(ignore_permissions=True)

			from sigos.timeline import registar
			registar(self.vigilante,
				_("Categoria alterada: <b>{0}</b> → <b>{1}</b>").format(
					categoria_antiga or "-", self.categoria_nova), self)

			frappe.msgprint(
				_("Categoria do vigilante {0} atualizada para {1}.").format(
					self.vigilante, self.categoria_nova
				),
				alert=True
			)
		except Exception as e:
			frappe.log_error(
				f"TrocaDeCategoria {self.name}: erro ao atualizar categoria do vigilante {self.vigilante}: {e}",
				"SIGOS Troca De Categoria"
			)
