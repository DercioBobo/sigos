import frappe
from frappe import _
from frappe.model.document import Document


class Demissao(Document):

	def on_submit(self):
		# Validate no duplicate submitted Demissao for same vigilante
		existing = frappe.get_all(
			"Demissao",
			filters={
				"vigilante": self.vigilante,
				"name": ["!=", self.name],
				"docstatus": 1
			},
			limit=1
		)
		if existing:
			frappe.throw(
				_("Já existe uma Demissão submetida para o vigilante {0}.").format(self.vigilante)
			)

		# Update Vigilante
		try:
			vigilante_doc = frappe.get_doc("Vigilante", self.vigilante)
			vigilante_doc.delegacao = None
			vigilante_doc.projecto = None
			vigilante_doc.nome_do_projecto = None
			vigilante_doc.cliente = None
			vigilante_doc.posto_de_vigilancia = None
			vigilante_doc.categoria = None
			vigilante_doc.regime_do_vigilante = None
			vigilante_doc.tipo_de_vigilante = None
			vigilante_doc.status = "Demitido"
			vigilante_doc.save(ignore_permissions=True)
		except Exception as e:
			frappe.log_error(
				f"Demissao {self.name}: erro ao atualizar Vigilante {self.vigilante}: {e}",
				"SIGOS Demissao"
			)

		# Update linked Employee
		try:
			funcionario = frappe.db.get_value("Vigilante", self.vigilante, "funcionario")
			if funcionario:
				emp = frappe.get_doc("Employee", funcionario)
				emp.status = "Left"
				emp.relieving_date = self.data_de_demissao
				emp.save(ignore_permissions=True)
		except Exception as e:
			frappe.log_error(
				f"Demissao {self.name}: erro ao atualizar Employee para vigilante {self.vigilante}: {e}",
				"SIGOS Demissao"
			)
