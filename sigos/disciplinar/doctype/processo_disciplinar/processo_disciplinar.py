import frappe
from frappe import _
from frappe.model.document import Document


class ProcessoDisciplinar(Document):

	def on_update(self):
		if (self.get("workflow_state") or "Aprovado") != "Aprovado":
			return

		if self.decisao == "Dedução":
			self._criar_deducao()

	def on_submit(self):
		decisao = (self.decisao or "").strip()

		if decisao == "Retenção De Salário":
			self._aplicar_retencao_salario()

		elif decisao == "Demissão":
			self._criar_demissao()

	# ─── Private helpers ──────────────────────────────────────────────────────

	def _criar_deducao(self):
		"""Create a Deducoes record linked to this Processo Disciplinar."""
		# Avoid duplicates
		existing = frappe.db.exists(
			"Deducoes",
			{"processo_disciplinar": self.name}
		)
		if existing:
			return

		try:
			deducao = frappe.get_doc({
				"doctype": "Deducoes",
				"tipo": "Processo Disciplinar",
				"estado": "Activo",
				"funcionario": self.funcionario,
				"vigilante": self.vigilante,
				"valor_a_pagar": self.valor_a_pagar,
				"meses_a_pagar": self.meses_a_pagar,
				"mes_referencia": self.mes_referencia,
				"data_de_inicio": self.data_de_inicio,
				"descricao": self.descricao,
				"termo_de_responsabilidade": self.termo_de_responsabilidade,
				"processo_disciplinar": self.name
			})
			deducao.insert(ignore_permissions=True)
			frappe.msgprint(
				_("Dedução {0} criada automaticamente.").format(deducao.name),
				alert=True
			)
		except Exception as e:
			frappe.log_error(
				f"ProcessoDisciplinar {self.name}: erro ao criar Deducoes: {e}",
				"SIGOS Processo Disciplinar"
			)

	def _aplicar_retencao_salario(self):
		"""Suspend Employee and deactivate Vigilante."""
		try:
			if self.funcionario:
				emp = frappe.get_doc("Employee", self.funcionario)
				emp.status = "Suspended"
				emp.save(ignore_permissions=True)

			if self.vigilante:
				vig = frappe.get_doc("Vigilante", self.vigilante)
				vig.status = "Inactivo"
				vig.save(ignore_permissions=True)
		except Exception as e:
			frappe.log_error(
				f"ProcessoDisciplinar {self.name}: erro ao aplicar Retenção de Salário: {e}",
				"SIGOS Processo Disciplinar"
			)

	def _criar_demissao(self):
		"""Create and submit a Demissao document."""
		try:
			existing = frappe.db.exists(
				"Demissao",
				{"vigilante": self.vigilante, "docstatus": 1}
			)
			if existing:
				frappe.msgprint(
					_("Já existe uma Demissão submetida para o vigilante {0}.").format(self.vigilante),
					alert=True
				)
				return

			demissao_doc = frappe.get_doc({
				"doctype": "Demissao",
				"data_de_demissao": self.data,
				"vigilante": self.vigilante,
				"mecanografico": self.mecanografico,
				"delegacao": self.delegacao,
				"motivo": "Disciplinar",
				"uniforme": self.uniforme
			})
			demissao_doc.insert(ignore_permissions=True)
			demissao_doc.submit()
			frappe.msgprint(
				_("Demissão {0} criada automaticamente para {1}.").format(
					demissao_doc.name, self.vigilante
				),
				alert=True
			)
		except Exception as e:
			frappe.log_error(
				f"ProcessoDisciplinar {self.name}: erro ao criar Demissao: {e}",
				"SIGOS Processo Disciplinar"
			)
