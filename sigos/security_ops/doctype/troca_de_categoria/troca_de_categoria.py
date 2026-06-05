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
			vigilante_doc.categoria = self.categoria_nova
			vigilante_doc.save(ignore_permissions=True)
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
