import frappe
from frappe import _
from frappe.model.document import Document


class Readimissao(Document):

	def on_submit(self):
		if (self.get("workflow_state") or "Aprovado") != "Aprovado":
			return

		if not self.vigilante:
			return

		try:
			vigilante_doc = frappe.get_doc("Vigilante", self.vigilante)
			if vigilante_doc.status != "Demitido":
				frappe.throw(
					_("O vigilante {0} não está com status Demitido. Readmissão não é possível.").format(
						self.vigilante
					)
				)

			# Clear operational fields
			vigilante_doc.posto_de_vigilancia = None
			vigilante_doc.projecto = None
			vigilante_doc.nome_do_projecto = None
			vigilante_doc.cliente = None
			vigilante_doc.categoria = None
			vigilante_doc.regime_do_vigilante = None
			vigilante_doc.tipo_de_vigilante = None
			vigilante_doc.data_admissao = None
			vigilante_doc.status = "Pre-Adimissão"
			vigilante_doc.save(ignore_permissions=True)

			frappe.msgprint(
				_("Vigilante {0} foi Pre-Admitido com sucesso.").format(self.vigilante),
				alert=True
			)
		except frappe.ValidationError:
			raise
		except Exception as e:
			frappe.log_error(
				f"Readimissao {self.name}: erro ao readmitir vigilante {self.vigilante}: {e}",
				"SIGOS Readimissao"
			)
