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
		if self.workflow_state != "Aprovado":
			return

		# 1. Update original vigilante posto
		if self.vigilante:
			try:
				vigilante_doc = frappe.get_doc("Vigilante", self.vigilante)
				vigilante_doc.posto_de_vigilancia = self.novo_posto
				vigilante_doc.save(ignore_permissions=True)
			except Exception as e:
				frappe.log_error(
					f"Rotatividade {self.name}: erro ao atualizar posto do vigilante {self.vigilante}: {e}",
					"SIGOS Rotatividade"
				)

		# 2. APV — swap: set novo_vigilante to antigo_posto
		if self.abreviatura_op == "APV" and self.novo_vigilante:
			try:
				novo_doc = frappe.get_doc("Vigilante", self.novo_vigilante)
				novo_doc.posto_de_vigilancia = self.alocado_ao_posto
				novo_doc.categoria = "Vigilante Normal"
				novo_doc.save(ignore_permissions=True)
			except Exception as e:
				frappe.log_error(
					f"Rotatividade {self.name}: erro ao atualizar novo vigilante APV {self.novo_vigilante}: {e}",
					"SIGOS Rotatividade"
				)

		# 3. RVP with substituto
		elif (
			self.abreviatura_op == "RVP"
			and self.alocar_vigilante_substituto == "Sim"
			and self.novo_vigilante
		):
			try:
				novo_doc = frappe.get_doc("Vigilante", self.novo_vigilante)
				novo_doc.posto_de_vigilancia = self.alocado_ao_posto
				novo_doc.save(ignore_permissions=True)
			except Exception as e:
				frappe.log_error(
					f"Rotatividade {self.name}: erro ao atualizar substituto RVP {self.novo_vigilante}: {e}",
					"SIGOS Rotatividade"
				)

		# 4. Create Demissao if motivo == "Demissão"
		if self.motivo == "Demissão":
			try:
				existing = frappe.db.exists(
					"Demissao",
					{"vigilante": self.vigilante, "data_de_demissao": self.data}
				)
				if not existing:
					demissao_doc = frappe.get_doc({
						"doctype": "Demissao",
						"data_de_demissao": self.data,
						"vigilante": self.vigilante,
						"mecanografico": self.mecanografico,
						"delegacao": self.delegacao,
						"regime": self.regime,
						"motivo": self.motiv_demi,
						"uniforme": self.uniforme,
					})
					demissao_doc.insert(ignore_permissions=True)
					demissao_doc.submit()
					frappe.msgprint(
						_("Demissão criada automaticamente para {0}.").format(self.vigilante),
						alert=True
					)
			except Exception as e:
				frappe.log_error(
					f"Rotatividade {self.name}: erro ao criar Demissao para {self.vigilante}: {e}",
					"SIGOS Rotatividade"
				)

	# ─── Validation helpers ────────────────────────────────────────────────────

	def _validar_categoria(self):
		"""
		Categories must match unless one party has pode_ser_substituto = 1
		(configured on Categoria Vigilante — e.g. Reserva guards cover any category).
		"""
		if not (self.categoria_vigilante and self.categoria_vigilante_a_alocar):
			return
		if self.abreviatura_op == "RVP" and self.alocar_vigilante_substituto != "Sim":
			return
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

		# Last approved rotation for this guard
		ultima = frappe.get_all(
			"Rotatividade",
			filters={
				"vigilante": self.vigilante,
				"workflow_state": "Aprovado",
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
