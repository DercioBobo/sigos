import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate, today

# Statuses that require an active Employee record
_REQUER_EMPLOYEE = frozenset({"Pre-Adimissão", "Activo", "Reserva", "Inactivo", "Demitido"})

# Canonical Vigilante → Employee status map (single source of truth, shared with sync.py)
# "Reserva" = benched/available (posto closed) — still employed, so Employee stays Active.
VIGILANTE_TO_EMP_STATUS = {
	"Pre-Adimissão RH": "Active",
	"Pre-Adimissão":    "Active",
	"Activo":            "Active",
	"Reserva":          "Active",
	"Inactivo":         "Suspended",
	"Demitido":         "Left",
}


class Vigilante(Document):

	def before_insert(self):
		self._calcular_idade()

	def before_save(self):
		self._calcular_idade()

	def validate(self):
		self._validar_data_admissao()           # required before admission/Employee creation
		self._criar_employee_se_necessario()    # must run before the link check
		self._auto_activar_com_posto()
		self._validar_status_com_posto()
		self._validar_capacidade_posto()
		self._validar_link_employee()
		self._guardar_mudanca_regime()

	def on_update(self):
		self._atualizar_ocupacao_postos()
		self._migrar_escala_se_mudou()
		self._seed_salario_base()

	def _seed_salario_base(self):
		"""
		Auto-assign the contract/regime base salary to a newly-onboarded or
		re-deployed guard's Salary Structure Assignment. Fires only when the guard
		is Activo with a Funcionário and the relevant fields actually changed; it's
		idempotent (no-op if the SSA already matches) and silent so a missing default
		structure or any error never blocks the guard's save.
		"""
		if self.status != "Activo" or not self.funcionario:
			return

		before = self.get_doc_before_save()
		mudou = (
			before is None
			or before.funcionario != self.funcionario
			or before.regime_do_vigilante != self.regime_do_vigilante
			or before.projecto != self.projecto
			or before.status != self.status
			or before.salario_base_manual != self.salario_base_manual
		)
		if not mudou:
			return

		try:
			from sigos.api import aplicar_salario_base
			aplicar_salario_base(vigilante=self.name, silent=True)
		except Exception as e:
			frappe.log_error(f"seed salario base {self.name}: {e}", "SIGOS Salario Base")

	# ─── Keystone: escala follows the guard ──────────────────────────────────────

	def _migrar_escala_se_mudou(self):
		"""
		When the guard's posto OR regime changes, migrate them between escalas.
		Universal — fires for Rotatividade, Troca De Regime, Atribuir, manual edits.
		A guard is only ADDED to the new escala when Activo with a posto+regime;
		otherwise (demitido / inactivo / no posto) they are just removed from the old.
		"""
		before = self.get_doc_before_save()
		if not before:
			return

		old_posto, old_regime = before.posto_de_vigilancia, before.regime_do_vigilante
		new_posto, new_regime = self.posto_de_vigilancia, self.regime_do_vigilante

		# Trigger on posto/regime change OR on activeness change (e.g. demissão:
		# status leaves Activo with same posto, so they must be pulled from the escala).
		posto_regime_mudou = (old_posto, old_regime) != (new_posto, new_regime)
		activo_mudou = (before.status == "Activo") != (self.status == "Activo")
		if not (posto_regime_mudou or activo_mudou):
			return

		# Only place the guard into a new escala if they are active and assigned.
		# escala_modo == "sem_escala" (set by Troca De Regime "Deixar sem escala") forces
		# a remove-only migration: the guard leaves the old escala but joins none.
		if self.flags.get("escala_modo") == "sem_escala":
			destino = (None, None)
		elif self.status == "Activo" and new_posto and new_regime:
			destino = (new_posto, new_regime)
		else:
			destino = (None, None)

		from sigos.security_ops.doctype.escala_do_vigilante.escala_do_vigilante import (
			migrar_escala_vigilante,
		)
		# Optional carry-forward slot (e.g. Rotatividade handing a substitute the exact
		# rotation position vacated by the guard they're replacing) — see
		# escala_do_vigilante.obter_turno_inicial_actual.
		turno_inicial = self.flags.get("turno_inicial_preferido")
		migrar_escala_vigilante(
			self.name, old_posto, old_regime, destino[0], destino[1], turno_inicial=turno_inicial
		)

	# ─── Auto-activation ─────────────────────────────────────────────────────────

	def _auto_activar_com_posto(self):
		"""
		Assigning a posto to an admitted OR reserve guard (with a Funcionário) promotes
		them to Activo automatically — this is how a Reserva guard is re-deployed.
		Keeps occupation counters correct (only Activo guards are counted).
		"""
		if (
			self.status in ("Pre-Adimissão", "Reserva")
			and self.posto_de_vigilancia
			and self.funcionario
		):
			self.status = "Activo"

	# ─── Validation ────────────────────────────────────────────────────────────

	def _validar_data_admissao(self):
		"""
		Data de Admissão must be set before RH admits (status leaves 'Pre-Adimissão RH').
		It becomes the Employee's Date of Joining, so an empty value would force a
		fallback to today() — RH must enter the real admission date.
		"""
		if self.status in _REQUER_EMPLOYEE and not self.data_admissao:
			frappe.throw(
				_("Preencha a <b>Data de Admissão</b> antes de admitir o vigilante — "
				  "é a data de início (Date of Joining) do Funcionário."),
				title=_("Data de Admissão Obrigatória"),
			)

	def _guardar_mudanca_regime(self):
		"""
		Block direct regime changes once the guard is scheduled. Regime drives the
		Escala (one per posto+regime); changing it here would orphan the guard in an
		escala built for the old regime. Changes must go through 'Troca De Regime',
		which migrates the escala properly. Initial set (onboarding) is allowed.
		"""
		before = self.get_doc_before_save()
		if not before:
			return  # new doc — initial regime is fine
		if before.regime_do_vigilante == self.regime_do_vigilante:
			return  # unchanged
		if self.status != "Activo":
			return  # only active scheduled guards are protected (demissão/inactive may clear regime)
		if self.flags.get("via_troca_regime"):
			return  # the Troca De Regime flow set this — allow

		from sigos.security_ops.doctype.escala_do_vigilante.escala_do_vigilante import (
			get_escalas_com_vigilante,
		)
		if get_escalas_com_vigilante(self.name):
			frappe.throw(
				_("Não altere o <b>Regime</b> directamente aqui — o vigilante está numa "
				  "escala activa. Use o documento <b>Troca De Regime</b>, que migra a escala "
				  "corretamente e mantém tudo consistente."),
				title=_("Use Troca De Regime"),
			)

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
				updates = {"status": expected}
				# Reactivating a previously-Left employee (readmissão): clear the stale
				# leaving date too, so HR/payroll stop treating them as gone.
				if expected == "Active" and current == "Left":
					updates["relieving_date"] = None
				frappe.db.set_value(
					"Employee", self.funcionario, updates, update_modified=False
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
		if self.status == "Activo" and not self.posto_de_vigilancia:
			frappe.throw(
				_("Um Vigilante com estado <b>Activo</b> deve ter um Posto de Vigilância atribuído."),
				title=_("Posto Obrigatório"),
			)
		# Regime is required once Activo — it drives the escala (one per posto+regime)
		# AND the billing tariff (per project+regime). A blank regime would orphan the
		# guard from both, so we lock it at activation.
		if self.status == "Activo" and not self.regime_do_vigilante:
			frappe.throw(
				_("Um Vigilante com estado <b>Activo</b> deve ter um <b>Regime</b> atribuído — "
				  "define a escala e a tarifa de facturação."),
				title=_("Regime Obrigatório"),
			)

	def _validar_capacidade_posto(self):
		"""Prevent assigning more vigilantes than the posto's maximum."""
		if not self.posto_de_vigilancia or self.status != "Activo":
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
				"status": "Activo",
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
		Auto-create an Employee when RH admits (status → Pre-Adimissão/Activo).
		Runs inside validate() so self.funcionario is set BEFORE the link check.
		On failure it raises a clear error instead of silently leaving the guard
		without an Employee (which would trip _validar_link_employee downstream).
		"""
		if self.funcionario:
			return
		if self.status not in ("Pre-Adimissão", "Activo"):
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

			# Mirror the guard's number onto the Employee: VIG-02 → FUNC-02 (same suffix),
			# so a vigilante and their funcionário always share one number. FUNC- is
			# reserved for vigilante employees; admin staff use the ADM-.## series.
			# We force the name (flags.name_set bypasses the Employee naming series) only
			# when that exact FUNC-<n> is free — otherwise fall back to the normal series.
			mirror = None
			if self.name and "-" in self.name:
				cand = "FUNC-" + self.name.rsplit("-", 1)[1]
				if not frappe.db.exists("Employee", cand):
					mirror = cand
					emp.name = mirror
					emp.employee = mirror
					emp.flags.name_set = True

			# ignore_links: self.name (VIG-####) is assigned by autoname but this
			# Vigilante row isn't written to the DB yet — validate() runs before
			# db_insert() — so a strict link check on custom_vigilante would fail
			# with "Could not find Vigilante". Same transaction/request, so the
			# row will exist by the time it commits.
			emp.flags.ignore_sync = True
			emp.insert(ignore_permissions=True, ignore_links=True)

			# Safety net: if the install's Employee naming overrode our forced name,
			# rename to the mirror so VIG/FUNC stay in lock-step.
			if mirror and emp.name != mirror and not frappe.db.exists("Employee", mirror):
				frappe.rename_doc("Employee", emp.name, mirror, force=True)
				emp.name = mirror
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

	# ─── Operational state transitions (called from the form buttons) ────────────

	@frappe.whitelist()
	def colocar_em_reserva(self, motivo=None):
		"""Bench the guard: release posto + contract, keep them employed (Reserva)."""
		return self._mudar_estado_operacional("Reserva", motivo)

	@frappe.whitelist()
	def inactivar(self, motivo=None):
		"""Suspend the guard: release posto + contract; Employee becomes Suspended."""
		return self._mudar_estado_operacional("Inactivo", motivo)

	def _mudar_estado_operacional(self, novo_estado, motivo=None):
		"""
		Move the guard to Reserva/Inactivo from a form action. Releases the posto and
		the derived contract fields, then saves — the save cascades the keystone escala
		migration, occupation recount and Employee status sync (Reserva→Active,
		Inactivo→Suspended). This is the controlled path that keeps the status read-only.
		"""
		if self.status == novo_estado:
			frappe.throw(
				_("O vigilante já está em <b>{0}</b>.").format(novo_estado),
				title=_("Sem alteração"),
			)

		self.status = novo_estado
		self.posto_de_vigilancia = None
		self.nome_do_posto = None
		self.tipo_de_posto = None
		self.regime_do_vigilante = None
		self.projecto = None
		self.cliente = None
		self.nome_do_projecto = None
		self.save()

		from sigos.timeline import registar
		rotulo = (
			_("colocado em <b>Reserva</b>")
			if novo_estado == "Reserva"
			else _("<b>inactivado</b> (Funcionário suspenso)")
		)
		texto = _("Vigilante {0}").format(rotulo)
		if motivo:
			texto += _(" — motivo: {0}").format(motivo)
		registar(self.name, texto, self)

		frappe.msgprint(_("Vigilante {0}.").format(rotulo), indicator="blue", alert=True)
		return self.status
