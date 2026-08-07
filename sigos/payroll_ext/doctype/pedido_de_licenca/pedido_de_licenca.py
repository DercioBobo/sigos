import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, formatdate, getdate, nowdate


@frappe.whitelist()
def consultar_saldo(vigilante, tipo_de_licenca, ate=None):
	"""Live balance preview for the form — the vigilante's ledger balance for this
	Leave Type as of the requested start date, computed via the same ledger-sum
	source ferias.py uses (SUM of Leave Ledger Entries, not new_leaves_allocated).
	Called before the doc is even saved, purely to help the approver decide."""
	from sigos.api import PAPEIS_INTERNOS
	frappe.only_for(PAPEIS_INTERNOS)
	if not (vigilante and tipo_de_licenca):
		return None
	funcionario = frappe.db.get_value("Vigilante", vigilante, "funcionario")
	if not funcionario:
		return None

	from sigos.ferias import _saldo
	return flt(_saldo(funcionario, tipo_de_licenca, getdate(ate) if ate else nowdate()))


class PedidoDeLicenca(Document):

	def validate(self):
		if self.data_inicio and self.data_fim and getdate(self.data_fim) < getdate(self.data_inicio):
			frappe.throw(_("A <b>Data de Fim</b> não pode ser anterior à <b>Data de Início</b>."))
		if not self.registado_por:
			self.registado_por = frappe.session.user

	def on_submit(self):
		if (self.get("workflow_state") or "Aprovado") != "Aprovado":
			return
		self._criar_leave_application()
		self._criar_cobertura_se_necessario()

	def on_cancel(self):
		self._cancelar_cobertura_se_existir()

		if not self.leave_application_ref:
			return
		if not frappe.db.exists("Leave Application", self.leave_application_ref):
			return
		la = frappe.get_doc("Leave Application", self.leave_application_ref)
		if la.docstatus == 1:
			la.flags.ignore_permissions = True
			la.cancel()
		self._registar_timeline(
			_("Pedido de Licença cancelado — Licença {0} revertida.").format(la.name)
		)

	def _criar_cobertura_se_necessario(self):
		"""Auto-create a Cobertura De Posto in 'Por Atribuir' so ops just has to
		pick a Cobridor — skipped when the covered guard has no real posto/regime
		to cover (e.g. already in Reserva) or a Cobertura already exists for this
		Pedido (idempotent — on_submit can run more than once via workflow states)."""
		if frappe.db.exists("Cobertura De Posto", {"pedido_de_licenca": self.name}):
			return

		posto, regime = frappe.db.get_value(
			"Vigilante", self.vigilante, ["posto_de_vigilancia", "regime_do_vigilante"]
		) or (None, None)
		if not (posto and regime):
			return

		cob = frappe.get_doc({
			"doctype": "Cobertura De Posto",
			"vigilante_coberto": self.vigilante,
			"tipo_cobertura": "Licença",
			"pedido_de_licenca": self.name,
			"data_inicio_prevista": self.data_inicio,
			"data_fim_prevista": self.data_fim,
			"estado": "Por Atribuir",
		})
		cob.insert(ignore_permissions=True)
		frappe.msgprint(
			_("Cobertura de Posto <b>{0}</b> criada — atribua um Cobridor quando tiver um "
			  "disponível.").format(cob.name),
			indicator="blue", alert=True,
		)

	def _cancelar_cobertura_se_existir(self):
		"""If cancelling this Pedido after a Cobertura (possibly already Activa,
		with a Cobridor deployed) was created for it, cancel/revert it too —
		otherwise a cancelled leave request leaves a Cobridor permanently
		mis-deployed with no linked leave."""
		nome = frappe.db.exists("Cobertura De Posto", {"pedido_de_licenca": self.name})
		if not nome:
			return
		cob = frappe.get_doc("Cobertura De Posto", nome)
		if cob.estado in ("Concluída", "Cancelada", "Efectivada"):
			return
		cob.cancelar(motivo=_("Pedido De Licença de origem foi cancelado."))

	def _criar_leave_application(self):
		"""Create + submit the real HRMS Leave Application that actually moves the
		leave ledger. Idempotent (skips if already processed)."""
		if self.leave_application_ref:
			return

		if not self.funcionario:
			frappe.throw(
				_("O vigilante <b>{0}</b> não tem Funcionário associado — não é possível "
				  "criar a Licença.").format(self.vigilante),
				title=_("Funcionário em Falta"),
			)

		company = frappe.db.get_value("Employee", self.funcionario, "company")

		try:
			la = frappe.get_doc({
				"doctype": "Leave Application",
				"employee": self.funcionario,
				"leave_type": self.tipo_de_licenca,
				"from_date": self.data_inicio,
				"to_date": self.data_fim,
				"company": company,
				"posting_date": self.data_pedido,
				"description": self.motivo,
				"status": "Approved",
			})
			la.flags.ignore_permissions = True
			la.insert()
			la.submit()
		except Exception as e:
			frappe.log_error(
				f"Pedido De Licenca {self.name}: erro ao criar Leave Application: {e}",
				"SIGOS Pedido De Licenca",
			)
			frappe.throw(
				_("Não foi possível criar a Licença automaticamente:<br><b>{0}</b>").format(e),
				title=_("Erro ao Aprovar Licença"),
			)

		self.db_set("leave_application_ref", la.name, update_modified=False)
		self.db_set("dias_aprovados", la.total_leave_days, update_modified=False)

		self._registar_timeline(
			_("Licença aprovada — <b>{0}</b> ({1} a {2}, {3} dia(s)).").format(
				self.tipo_de_licenca, formatdate(self.data_inicio), formatdate(self.data_fim),
				la.total_leave_days,
			)
		)
		frappe.msgprint(
			_("Licença {0} criada e aprovada — {1} dia(s).").format(la.name, la.total_leave_days),
			indicator="green", alert=True,
		)

	def _registar_timeline(self, texto):
		if not self.vigilante:
			return
		from sigos.timeline import registar
		registar(self.vigilante, texto, self)
