import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import date_diff, today, getdate


def _categoria_pode_substituir(categoria_nome: str) -> bool:
	if not categoria_nome:
		return False
	return bool(
		frappe.db.get_value("Categoria Vigilante", categoria_nome, "pode_ser_substituto")
	)


class Rotatividade(Document):

	def validate(self):
		self._validar_categoria()
		self._validar_regra_3meses()

	def before_submit(self):
		self._validar_categoria()
		self._validar_regra_3meses()

	def on_submit(self):
		if (self.get("workflow_state") or "Aprovado") != "Aprovado":
			return
		if not self.vigilante:
			return

		op = self._get_operacao()

		# 1. Apply the operation's changes to the main guard. vig.save() cascades:
		#    occupation recount, Employee sync, and the keystone escala migration.
		vig = frappe.get_doc("Vigilante", self.vigilante)
		posto_vago = vig.posto_de_vigilancia   # captured before any change

		if op and op.muda_posto:
			vig.posto_de_vigilancia = self.novo_posto
		if op and op.muda_regime and self.novo_regime:
			vig.regime_do_vigilante = self.novo_regime
			vig.flags.via_troca_regime = True
		if op and op.muda_categoria and self.nova_categoria:
			vig.categoria = self.nova_categoria

		# Demissão takes the guard out of service (status drives escala removal too)
		demite = bool(op and op.demite) or self.motivo == "Demissão"
		if demite:
			vig.status = "Demitido"

		vig.save(ignore_permissions=True)

		# 2. Substituto assumes the vacated posto (also cascades through the keystone)
		if op and op.requer_substituto and self.novo_vigilante and posto_vago:
			sub = frappe.get_doc("Vigilante", self.novo_vigilante)
			sub.posto_de_vigilancia = posto_vago
			sub.save(ignore_permissions=True)

		# 3. Create the Demissão record
		if demite:
			self._criar_demissao()

		frappe.msgprint(
			_("Rotatividade <b>{0}</b> aplicada a <b>{1}</b>.").format(
				op.operacao if op else self.abreviatura_op, self.vigilante
			),
			indicator="green",
			alert=True,
		)

	# ─── Operation lookup ────────────────────────────────────────────────────────

	def _get_operacao(self):
		if not self.abreviatura_op:
			return None
		try:
			return frappe.get_doc("Operacao De Rotatividade", self.abreviatura_op)
		except frappe.DoesNotExistError:
			return None

	def _criar_demissao(self):
		if frappe.db.exists("Demissao", {"vigilante": self.vigilante, "data_de_demissao": self.data}):
			return
		try:
			dem = frappe.get_doc({
				"doctype": "Demissao",
				"data_de_demissao": self.data,
				"vigilante": self.vigilante,
				"mecanografico": self.mecanografico,
				"delegacao": self.delegacao,
				"regime": self.regime,
				"motivo": self.motiv_demi,
				"uniforme": self.uniforme,
			})
			dem.insert(ignore_permissions=True)
			dem.submit()
			frappe.msgprint(_("Demissão criada automaticamente para {0}.").format(self.vigilante), alert=True)
		except Exception as e:
			frappe.log_error(
				f"Rotatividade {self.name}: erro ao criar Demissao para {self.vigilante}: {e}",
				"SIGOS Rotatividade",
			)

	# ─── Validation helpers ────────────────────────────────────────────────────

	def _validar_categoria(self):
		"""
		Categories must match unless one party has pode_ser_substituto = 1
		(configured on Categoria Vigilante — e.g. Reserva guards cover any category).
		"""
		if not (self.categoria_vigilante and self.categoria_vigilante_a_alocar):
			return
		# Only relevant when a substituto is actually involved
		if not self.novo_vigilante:
			return
		if self.categoria_vigilante == self.categoria_vigilante_a_alocar:
			return

		if _categoria_pode_substituir(self.categoria_vigilante):
			return
		if _categoria_pode_substituir(self.categoria_vigilante_a_alocar):
			return

		frappe.throw(
			_("A Categoria do Vigilante <b>{0}</b> é <b>{1}</b>, mas a do Substituto "
			  "<b>{2}</b> é <b>{3}</b>. As categorias devem ser iguais, ou um dos "
			  "vigilantes deve ter uma categoria autorizada para substituição.").format(
				self.vigilante,
				self.categoria_vigilante,
				self.novo_vigilante,
				self.categoria_vigilante_a_alocar,
			),
			title=_("Categorias Incompatíveis"),
		)

	def _validar_regra_3meses(self):
		"""Guard must have spent N days at the post before rotating, unless motivo_3meses is filled."""
		if not self.vigilante:
			return

		dias_minimos = (
			frappe.db.get_single_value("SIGOS Settings", "dias_minimos_rotatividade") or 90
		)

		# Last applied rotation for this guard (submitted = applied; workflow-agnostic)
		ultima = frappe.get_all(
			"Rotatividade",
			filters={
				"vigilante": self.vigilante,
				"docstatus": 1,
				"name": ["!=", self.name],
			},
			fields=["data"],
			order_by="data desc",
			limit=1,
		)

		data_base = getdate(ultima[0].data) if ultima else None

		if not data_base:
			data_base_raw = frappe.db.get_value("Vigilante", self.vigilante, "data_admissao")
			data_base = getdate(data_base_raw) if data_base_raw else None

		if not data_base:
			return  # No reference date — allow rotation

		diff = date_diff(today(), data_base)

		if diff < dias_minimos and not self.motivo_3meses:
			frappe.throw(
				_("O vigilante <b>{0}</b> ainda não completou <b>{1}</b> dias desde a última "
				  "rotatividade/admissão (<b>{2}</b>). Faltam <b>{3}</b> dias. "
				  "Preencha o campo <b>Motivo de Rotatividade Antes de 3 Meses</b> para continuar.").format(
					self.vigilante,
					dias_minimos,
					data_base,
					dias_minimos - diff,
				),
				title=_("Regra dos 3 Meses"),
			)
