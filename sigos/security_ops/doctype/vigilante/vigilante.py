import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate, today

# Statuses that require an active Employee record
_REQUER_EMPLOYEE = frozenset({"Pre-Adimissão", "Ativo", "Inactivo", "Demitido"})

# Canonical Vigilante → Employee status map (single source of truth, shared with sync.py)
VIGILANTE_TO_EMP_STATUS = {
	"Pre-Adimissão RH": "Active",
	"Pre-Adimissão":    "Active",
	"Ativo":            "Active",
	"Inactivo":         "Suspended",
	"Demitido":         "Left",
}


class Vigilante(Document):

	def before_insert(self):
		self._calcular_idade()

	def before_save(self):
		self._calcular_idade()

	def validate(self):
		self._criar_employee_se_necessario()   # must run before the link check
		self._auto_activar_com_posto()
		self._validar_status_com_posto()
		self._validar_capacidade_posto()
		self._validar_link_employee()

	def on_update(self):
		self._atualizar_ocupacao_postos()

	# ─── Auto-activation ─────────────────────────────────────────────────────────

	def _auto_activar_com_posto(self):
		"""
		When a posto is assigned to an admitted vigilante (already has a Funcionário),
		promote them to Ativo automatically. This keeps posto occupation counters
		correct — occupation counts only Ativo vigilantes.
		"""
		if (
			self.status == "Pre-Adimissão"
			and self.posto_de_vigilancia
			and self.funcionario
		):
			self.status = "Ativo"

	# ─── Validation ────────────────────────────────────────────────────────────

	def _validar_link_employee(self):
		"""Enforce Employee link and status consistency for every operational status."""
		if self.status not in _REQUER_EMPLOYEE:
			return

		if not self.funcionario:
			frappe.throw(
				_("Vigilante em estado <b>{0}</b> exige um Funcionário (Employee) associado. "
				  "Use o botão <b>Admitir (RH)</b> para criar o registo.").format(self.status),
				title=_("Funcionário Obrigatório"),
			)

		if not frappe.db.exists("Employee", self.funcionario):
			frappe.throw(
				_("O Funcionário <b>{0}</b> não existe. Verifique o campo Funcionário.").format(
					self.funcionario
				),
				title=_("Funcionário Inválido"),
			)

		# Status consistency — auto-correct the Employee side; only warn user when
		# the divergence is severe (Active employee being marked as Demitido vigilante
		# or vice-versa) so they know something is being fixed.
		expected = VIGILANTE_TO_EMP_STATUS.get(self.status)
		if expected:
			current = frappe.db.get_value("Employee", self.funcionario, "status")
			if current != expected:
				frappe.db.set_value(
					"Employee", self.funcionario, "status", expected, update_modified=False
				)
				frappe.msgprint(
					_("Estado do Funcionário <b>{0}</b> actualizado de <b>{1}</b> para <b>{2}</b> "
					  "para reflectir o estado do Vigilante.").format(
						self.funcionario, current, expected
					),
					indicator="blue",
					alert=True,
				)

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
			"Posto De Vigilancia", self.posto_de_vigilancia, "numero_de_vagas"
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
		"""
		Auto-create an Employee when RH admits (status → Pre-Adimissão/Ativo).
		Runs inside validate() so self.funcionario is set BEFORE the link check.
		On failure it raises a clear error instead of silently leaving the guard
		without an Employee (which would trip _validar_link_employee downstream).
		"""
		if self.funcionario:
			return
		if self.status not in ("Pre-Adimissão", "Ativo"):
			return

		empresa = self.empresa or frappe.db.get_single_value("SIGOS Settings", "empresa_padrao")
		if not empresa:
			frappe.throw(
				_("Defina a <b>Empresa</b> do vigilante ou a <b>Empresa Padrão</b> em "
				  "SIGOS Settings antes de admitir — é necessária para criar o Funcionário."),
				title=_("Empresa em Falta"),
			)

		try:
			emp = frappe.new_doc("Employee")
			parts = (self.nome_completo or "").strip().split()
			emp.first_name = parts[0] if parts else (self.nome_completo or "Sem Nome")
			emp.last_name  = " ".join(parts[1:]) if len(parts) > 1 else ""
			emp.employee_name = self.nome_completo
			emp.date_of_birth = self.data_de_nascimento
			emp.gender = "Male" if self.sexo == "Masculino" else "Female"
			emp.cell_number = self.contacto
			emp.date_of_joining = self.data_admissao or today()
			emp.company = empresa
			emp.status = "Active"
			emp.custom_vigilante = self.name
			emp.custom_mecanografico = self.mecanografico
			emp.custom_categoria = self.categoria
			emp.custom_regime = self.regime_do_vigilante
			emp.custom_delegacao = self.delegacao
			emp.custom_posto = self.posto_de_vigilancia

			emp.flags.ignore_sync = True
			emp.insert(ignore_permissions=True)
		except Exception as e:
			frappe.log_error(f"Erro ao criar Employee para Vigilante {self.name}: {e}", "SIGOS")
			frappe.throw(
				_("Não foi possível criar o Funcionário automaticamente:<br><b>{0}</b>").format(e),
				title=_("Erro ao Criar Funcionário"),
			)

		# Set in memory — written when this Vigilante save commits (no db.set_value
		# on a possibly-unsaved row). Name is already assigned (autoname runs before validate).
		self.funcionario = emp.name
		frappe.msgprint(
			_("Funcionário <b>{0}</b> criado automaticamente.").format(emp.name),
			indicator="green",
			alert=True,
		)
