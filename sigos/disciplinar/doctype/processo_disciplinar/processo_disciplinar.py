import frappe
from frappe import _
from frappe.model.document import Document


class ProcessoDisciplinar(Document):

	def after_insert(self):
		# Fires the moment an investigation opens (draft, before any decisão is
		# known) — the posto needs covering immediately, not only once the
		# process is eventually submitted/approved.
		self._criar_cobertura_se_necessario()

	def on_cancel(self):
		self._cancelar_cobertura_se_existir()

	def on_update(self):
		# docstatus == 1 (not just workflow_state) is the real gate: on_update fires
		# on EVERY save, including drafts. Without this, a site where the Workflow
		# isn't provisioned yet (workflow_state missing → falls back to "Aprovado")
		# would create and submit a real payroll deduction from a mere draft save.
		if self.docstatus != 1:
			return
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

	def _criar_cobertura_se_necessario(self):
		"""Auto-create a Cobertura De Posto in 'Por Atribuir' so ops just has to
		pick a Cobridor — skipped when the guard has no real posto/regime to
		cover, or a Cobertura already exists for this process (idempotent)."""
		if frappe.db.exists("Cobertura De Posto", {"processo_disciplinar": self.name}):
			return

		posto, regime = frappe.db.get_value(
			"Vigilante", self.vigilante, ["posto_de_vigilancia", "regime_do_vigilante"]
		) or (None, None)
		if not (posto and regime):
			return

		cob = frappe.get_doc({
			"doctype": "Cobertura De Posto",
			"vigilante_coberto": self.vigilante,
			"tipo_cobertura": "Suspensão/Investigação",
			"processo_disciplinar": self.name,
			"data_inicio_prevista": self.data,
			"estado": "Por Atribuir",
		})
		cob.insert(ignore_permissions=True)
		frappe.msgprint(
			_("Cobertura de Posto <b>{0}</b> criada — atribua um Cobridor quando tiver um "
			  "disponível.").format(cob.name),
			indicator="blue", alert=True,
		)

	def _cancelar_cobertura_se_existir(self):
		"""If cancelling this Processo Disciplinar after a Cobertura (possibly
		already Activa, with a Cobridor deployed) was created for it, cancel/
		revert it too — otherwise a cancelled process leaves a Cobridor
		permanently mis-deployed with no linked case."""
		nome = frappe.db.exists("Cobertura De Posto", {"processo_disciplinar": self.name})
		if not nome:
			return
		cob = frappe.get_doc("Cobertura De Posto", nome)
		if cob.estado in ("Concluída", "Cancelada", "Efectivada"):
			return
		cob.cancelar(motivo=_("Processo Disciplinar de origem foi cancelado."))

	def _criar_deducao(self):
		"""Create an Outras Deducoes record linked to this Processo Disciplinar."""
		# Avoid duplicates
		existing = frappe.db.exists(
			"Outras Deducoes",
			{"processo_disciplinar": self.name}
		)
		if existing:
			return

		try:
			componente = frappe.db.get_single_value(
				"SIGOS Settings", "componente_processo_disciplinar"
			) or "Processo Disciplinar"
			# Outras Deducoes is keyed on the Employee — derive it from the vigilante.
			funcionario = frappe.db.get_value("Vigilante", self.vigilante, "funcionario")
			deducao = frappe.get_doc({
				"doctype": "Outras Deducoes",
				"tipo": componente,
				"estado": "Activo",
				"funcionario": funcionario,
				"valor_a_pagar": self.valor_a_pagar,
				"meses_a_pagar": self.meses_a_pagar,
				"mes_referencia": self.mes_referencia,
				"data_de_inicio": self.data_de_inicio,
				"descricao": self.descricao,
				"termo_de_responsabilidade": self.termo_de_responsabilidade,
				"processo_disciplinar": self.name
			})
			deducao.insert(ignore_permissions=True)
			deducao.submit()
			frappe.msgprint(
				_("Dedução {0} criada automaticamente.").format(deducao.name),
				alert=True
			)
		except Exception as e:
			frappe.log_error(
				f"ProcessoDisciplinar {self.name}: erro ao criar Outras Deducoes: {e}",
				"SIGOS Processo Disciplinar"
			)
			raise

	def _aplicar_retencao_salario(self):
		"""Suspend Employee and deactivate Vigilante."""
		try:
			if self.vigilante:
				vig = frappe.get_doc("Vigilante", self.vigilante)
				vig.status = "Inactivo"
				vig.save(ignore_permissions=True)

				# Employee is derived from the vigilante (no funcionario field on the PD).
				if vig.funcionario:
					emp = frappe.get_doc("Employee", vig.funcionario)
					emp.status = "Suspended"
					emp.save(ignore_permissions=True)
		except Exception as e:
			frappe.log_error(
				f"ProcessoDisciplinar {self.name}: erro ao aplicar Retenção de Salário: {e}",
				"SIGOS Processo Disciplinar"
			)
			raise

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
			raise
