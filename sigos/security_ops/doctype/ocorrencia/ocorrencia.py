import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import formatdate, today


class Ocorrencia(Document):

	def validate(self):
		self._validar_posto_na_delegacao()
		if not self.registado_por:
			self.registado_por = frappe.session.user

	def after_insert(self):
		self._registar_timeline(
			_("Ocorrência registada — <b>{0}</b> ({1})").format(
				self.tipo or _("(sem tipo)"), self.gravidade or "-"
			)
		)

	# ─── Delegação ───────────────────────────────────────────────────────────────

	def _validar_posto_na_delegacao(self):
		"""Keep the incident's delegação consistent with the posto it happened at."""
		if not self.posto:
			return
		posto_deleg = frappe.db.get_value("Posto De Vigilancia", self.posto, "delegacao")
		if not posto_deleg:
			return
		if not self.delegacao:
			self.delegacao = posto_deleg
		elif self.delegacao != posto_deleg:
			frappe.throw(
				_("O posto <b>{0}</b> pertence à delegação <b>{1}</b>, mas a ocorrência está "
				  "na delegação <b>{2}</b>. Escolha um posto da mesma delegação.").format(
					self.posto, posto_deleg, self.delegacao
				),
				title=_("Posto de Outra Delegação"),
			)

	# ─── Lifecycle (estado) ──────────────────────────────────────────────────────

	@frappe.whitelist()
	def investigar(self):
		return self._mudar_estado("Em Investigação")

	@frappe.whitelist()
	def resolver(self, accao=None, resolvido_por=None):
		if accao:
			self.accao_tomada = accao
		if resolvido_por:
			self.resolvido_por = resolvido_por
		self.data_resolucao = today()
		return self._mudar_estado("Resolvida")

	@frappe.whitelist()
	def fechar(self):
		if not self.data_resolucao:
			self.data_resolucao = today()
		return self._mudar_estado("Fechada")

	@frappe.whitelist()
	def reabrir(self, motivo=None):
		self.resolvido_por = None
		self.data_resolucao = None
		return self._mudar_estado("Em Investigação", motivo=motivo)

	def _mudar_estado(self, novo_estado, motivo=None):
		if self.estado == novo_estado:
			frappe.throw(_("A ocorrência já está em <b>{0}</b>.").format(novo_estado))
		anterior = self.estado
		self.estado = novo_estado
		self.save()

		rotulos = {
			"Em Investigação": _("posta <b>em investigação</b>"),
			"Resolvida": _("marcada como <b>Resolvida</b>"),
			"Fechada": _("<b>Fechada</b>"),
		}
		texto = _("Ocorrência {0}").format(rotulos.get(novo_estado, novo_estado))
		if novo_estado == "Em Investigação" and anterior in ("Resolvida", "Fechada"):
			texto = _("Ocorrência <b>reaberta</b> (em investigação)")
		if motivo:
			texto += _(" — motivo: {0}").format(motivo)
		self._registar_timeline(texto)

		frappe.msgprint(
			_("Ocorrência {0}.").format(rotulos.get(novo_estado, novo_estado)),
			indicator="blue", alert=True,
		)
		return self.estado

	# ─── Participação ────────────────────────────────────────────────────────────

	@frappe.whitelist()
	def criar_participacao(self):
		"""Open a draft Participação pre-filled from this ocorrência.
		Returns the (existing or new) participação name so the UI can route to it.

		NOT surfaced in the UI right now (button hidden in ocorrencia.js) — with
		multiple vigilantes possibly involved, a single Participação (one guard's
		misconduct report) doesn't obviously map to "everyone on the list", and
		that's undecided. Kept working (picks the first guard) rather than broken,
		so it's a small step to re-enable once that's settled.
		"""
		primeiro = self.vigilantes_envolvidos[0].vigilante if self.vigilantes_envolvidos else None
		if not primeiro:
			frappe.throw(_("Defina o Vigilante envolvido antes de abrir uma Participação."))

		existente = frappe.db.exists("Participacao", {"ocorrencia_referente": self.name})
		if existente:
			frappe.msgprint(
				_("Já existe a Participação {0} para esta ocorrência.").format(existente),
				alert=True,
			)
			return existente

		# Participação has no "Crítica" tier — fold it into "Alta".
		mapa_gravidade = {"Baixa": "Baixa", "Média": "Média", "Alta": "Alta", "Crítica": "Alta"}
		participacao = frappe.get_doc({
			"doctype": "Participacao",
			"data": self.data,
			"delegacao": self.delegacao,
			"vigilante": primeiro,
			"posto": self.posto,
			"gravidade": mapa_gravidade.get(self.gravidade, "Média"),
			"relato": self.descricao,
			"ocorrencia_referente": self.name,
		})
		# tipo_de_infracao is mandatory on Participação but has no equivalent on
		# Ocorrencia — leave it blank and let the user pick it before submitting.
		participacao.insert(ignore_permissions=True, ignore_mandatory=True)
		frappe.msgprint(
			_("Participação {0} criada a partir desta ocorrência. Defina o "
			  "<b>Tipo de Infracção</b> antes de submeter.").format(participacao.name),
			indicator="blue", alert=True,
		)
		return participacao.name

	# ─── Timeline ────────────────────────────────────────────────────────────────

	def _registar_timeline(self, texto):
		"""Log the incident on every involved guard's timeline (if any)."""
		if not self.vigilantes_envolvidos:
			return
		from sigos.timeline import registar
		contexto = texto
		if self.posto:
			contexto += _(" · posto <b>{0}</b>").format(self.posto)
		if self.data:
			contexto += _(" · {0}").format(formatdate(self.data))
		for row in self.vigilantes_envolvidos:
			if row.vigilante:
				registar(row.vigilante, contexto, self)
