import frappe
from frappe import _
from frappe.model.document import Document


class PostoDeVigilancia(Document):

	def validate(self):
		self._validar_temporario()

	def after_insert(self):
		self._recalcular_ocupacao()

	def on_update(self):
		before = self.get_doc_before_save()
		self._tratar_vagas(before)
		self._tratar_estado(before)
		self._propagar_cliente_projecto(before)

	# ─── Temporary posts ────────────────────────────────────────────────────────

	def _validar_temporario(self):
		if self.tipo_de_posto != "Temporário":
			# Clear temp-only fields when permanent (data_de_abertura is universal — keep it)
			self.data_fim_prevista = None
			self.aviso_expiracao_enviado = 0
			return

		# Temporário
		if not self.data_fim_prevista:
			frappe.msgprint(
				_("Posto temporário sem <b>Fim Previsto</b> definido. "
				  "Recomenda-se indicar a data prevista de encerramento."),
				indicator="orange",
				alert=True,
			)

		if self.data_fim_prevista and self.data_de_abertura:
			from frappe.utils import getdate
			if getdate(self.data_fim_prevista) < getdate(self.data_de_abertura):
				frappe.throw(_("O Fim Previsto não pode ser anterior à Data de Abertura."))

		# Reset expiry-notice flag if the end date was pushed forward
		before = self.get_doc_before_save()
		if before and before.data_fim_prevista != self.data_fim_prevista:
			self.aviso_expiracao_enviado = 0

	@frappe.whitelist()
	def tornar_permanente(self):
		"""Convert a temporary post into a permanent one (keeps data_de_abertura)."""
		self.tipo_de_posto = "Permanente"
		self.data_fim_prevista = None
		self.aviso_expiracao_enviado = 0
		self.save()
		frappe.msgprint(
			_("Posto <b>{0}</b> convertido em Permanente.").format(self.name),
			indicator="green",
			alert=True,
		)
		return True

	def on_trash(self):
		self._validar_eliminacao()

	# ─── Capacity ──────────────────────────────────────────────────────────────

	def _tratar_vagas(self, before):
		if before and before.numero_de_vagas == self.numero_de_vagas:
			return
		self._recalcular_ocupacao()

		atual = frappe.db.get_value("Posto De Vigilancia", self.name, "ocupacao_atual") or 0
		if self.numero_de_vagas and atual > self.numero_de_vagas:
			frappe.msgprint(
				_("O posto tem <b>{0}</b> vigilantes activos, acima da nova capacidade de "
				  "<b>{1}</b>. O estado de ocupação ficou <b>Excedido</b> — reveja as atribuições.").format(
					atual, self.numero_de_vagas
				),
				indicator="orange",
				alert=True,
			)

	def _recalcular_ocupacao(self):
		from sigos.utils import atualizar_ocupacao_posto
		atualizar_ocupacao_posto(self.name)

	# ─── Estado (Ativo / Inativo) ───────────────────────────────────────────────

	def _tratar_estado(self, before):
		if not before or before.estado == self.estado:
			return

		# Ativo → Inativo: archive active escalas so they stop generating
		if self.estado == "Inativo":
			escalas = frappe.get_all(
				"Escala Do Vigilante",
				filters={"posto_de_vigilancia": self.name, "estado": "Activo"},
				pluck="name",
			)
			for e in escalas:
				frappe.db.set_value("Escala Do Vigilante", e, "estado", "Arquivado", update_modified=False)

			vigs = frappe.db.count("Vigilante", {"posto_de_vigilancia": self.name, "status": "Ativo"})

			msg = []
			if escalas:
				msg.append(_("{0} escala(s) arquivada(s) — deixam de gerar.").format(len(escalas)))
			if vigs:
				msg.append(_("{0} vigilante(s) continuam atribuídos a este posto e precisam de ser "
				             "transferidos ou demitidos.").format(vigs))
			if msg:
				frappe.msgprint("<br>".join(msg), title=_("Posto Inactivado"), indicator="orange")

		# Inativo → Ativo: just a hint (escalas are not auto-reactivated)
		elif self.estado == "Ativo":
			arquivadas = frappe.db.count(
				"Escala Do Vigilante",
				{"posto_de_vigilancia": self.name, "estado": "Arquivado"},
			)
			if arquivadas:
				frappe.msgprint(
					_("Posto reactivado. Existem {0} escala(s) arquivada(s) — reactive-as "
					  "manualmente se quiser retomar a geração.").format(arquivadas),
					indicator="blue",
					alert=True,
				)

	# ─── Cliente / Projecto / Tipo propagation ──────────────────────────────────

	def _propagar_cliente_projecto(self, before):
		if not before:
			return
		mudou = (
			before.cliente != self.cliente
			or before.project != self.project
			or before.tipo_de_posto != self.tipo_de_posto
		)
		if not mudou:
			return

		nome_proj = (
			frappe.db.get_value("Project", self.project, "project_name")
			if self.project else None
		)

		vigs = frappe.get_all(
			"Vigilante", filters={"posto_de_vigilancia": self.name}, pluck="name"
		)
		for v in vigs:
			frappe.db.set_value(
				"Vigilante",
				v,
				{
					"cliente": self.cliente,
					"projecto": self.project,
					"nome_do_projecto": nome_proj,
					"tipo_de_posto": self.tipo_de_posto,
				},
				update_modified=False,
			)

		escalas = frappe.get_all(
			"Escala Do Vigilante", filters={"posto_de_vigilancia": self.name}, pluck="name"
		)
		for e in escalas:
			frappe.db.set_value(
				"Escala Do Vigilante", e, "cliente", self.cliente, update_modified=False
			)

		if vigs or escalas:
			frappe.msgprint(
				_("Cliente/Projecto/Tipo actualizado em <b>{0}</b> vigilante(s) e "
				  "<b>{1}</b> escala(s).").format(len(vigs), len(escalas)),
				indicator="blue",
				alert=True,
			)

	# ─── Deletion guard ──────────────────────────────────────────────────────────

	def _validar_eliminacao(self):
		n_vig = frappe.db.count("Vigilante", {"posto_de_vigilancia": self.name})
		if n_vig:
			frappe.throw(
				_("Não é possível eliminar o posto <b>{0}</b> — tem {1} vigilante(s) atribuído(s). "
				  "Transfira-os ou demita-os primeiro.").format(self.name, n_vig),
				title=_("Posto em Uso"),
			)
		n_esc = frappe.db.count("Escala Do Vigilante", {"posto_de_vigilancia": self.name})
		if n_esc:
			frappe.throw(
				_("Não é possível eliminar o posto <b>{0}</b> — existe(m) {1} escala(s) associada(s). "
				  "Elimine-as primeiro.").format(self.name, n_esc),
				title=_("Posto em Uso"),
			)
