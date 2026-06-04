import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate, today


class Vigilante(Document):

	def before_insert(self):
		self._calcular_idade()

	def before_save(self):
		self._calcular_idade()

	def validate(self):
		self._validar_status_com_posto()
		self._validar_capacidade_posto()

	def on_update(self):
		self._criar_employee_se_necessario()
		self._atualizar_ocupacao_postos()

	# ─── Validation ────────────────────────────────────────────────────────────

	def _validar_status_com_posto(self):
		if self.status == "Ativo" and not self.posto_de_vigilancia:
			frappe.throw(
				_("Um Vigilante com estado <b>Ativo</b> deve ter um Posto de Vigilância atribuído."),
				title=_("Posto Obrigatório"),
			)

	def _validar_capacidade_posto(self):
		"""Prevent assigning more vigilantes than the posto's maximum."""
		if not self.posto_de_vigilancia or self.status != "Ativo":
			return

		max_vagas = frappe.db.get_value(
			"Posto de Vigilancia", self.posto_de_vigilancia, "numero_de_vagas"
		) or 0

		if not max_vagas:
			return  # No limit defined

		# Count other active vigilantes at this posto (exclude self)
		ocupados = frappe.db.count(
			"Vigilante",
			{
				"posto_de_vigilancia": self.posto_de_vigilancia,
				"status": "Ativo",
				"name": ["!=", self.name or "__new__"],
			},
		)

		if ocupados >= max_vagas:
			frappe.throw(
				_(
					"O posto <b>{0}</b> já atingiu a capacidade máxima de "
					"<b>{1}</b> vigilante(s). Não é possível adicionar mais."
				).format(self.posto_de_vigilancia, max_vagas),
				title=_("Posto no Limite Máximo"),
			)

	# ─── Occupation tracking ───────────────────────────────────────────────────

	def _atualizar_ocupacao_postos(self):
		"""Update occupation counters for old posto (if changed) and new posto."""
		from sigos.utils import atualizar_ocupacao_posto

		if self.posto_de_vigilancia:
			atualizar_ocupacao_posto(self.posto_de_vigilancia)

		# Also update the old posto if the guard moved
		doc_before = self.get_doc_before_save()
		if (
			doc_before
			and doc_before.posto_de_vigilancia
			and doc_before.posto_de_vigilancia != self.posto_de_vigilancia
		):
			atualizar_ocupacao_posto(doc_before.posto_de_vigilancia)

	# ─── Private helpers ───────────────────────────────────────────────────────

	def _calcular_idade(self):
		if not self.data_de_nascimento:
			return
		dob = getdate(self.data_de_nascimento)
		hoje = getdate(today())
		self.idade = (
			hoje.year - dob.year
			- ((hoje.month, hoje.day) < (dob.month, dob.day))
		)

	def _criar_employee_se_necessario(self):
		"""Auto-create an Employee when RH approves (status moves to Pre-Adimissão)."""
		if self.funcionario:
			return
		if self.status not in ("Pre-Adimissão", "Ativo"):
			return

		try:
			emp = frappe.new_doc("Employee")
			parts = (self.nome_completo or "").strip().split()
			emp.first_name = parts[0] if parts else self.nome_completo
			emp.last_name  = " ".join(parts[1:]) if len(parts) > 1 else ""
			emp.employee_name = self.nome_completo
			emp.date_of_birth = self.data_de_nascimento
			emp.gender = "Male" if self.sexo == "Masculino" else "Female"
			emp.cell_number = self.contacto
			emp.date_of_joining = self.data_admissao or today()
			emp.company = self.empresa or frappe.db.get_single_value("SIGOS Settings", "empresa_padrao")
			emp.status = "Active"
			emp.custom_vigilante = self.name
			emp.custom_mecanografico = self.mecanografico
			emp.custom_categoria = self.categoria
			emp.custom_regime = self.regime_do_vigilante
			emp.custom_delegacao = self.delegacao
			emp.custom_posto = self.posto_de_vigilancia

			emp.flags.ignore_sync = True
			emp.insert(ignore_permissions=True)

			frappe.db.set_value("Vigilante", self.name, "funcionario", emp.name, update_modified=False)
			self.funcionario = emp.name

			frappe.msgprint(
				_("Funcionário {0} criado automaticamente.").format(emp.name),
				alert=True,
			)
		except Exception as e:
			frappe.log_error(f"Erro ao criar Employee para Vigilante {self.name}: {e}", "SIGOS")
