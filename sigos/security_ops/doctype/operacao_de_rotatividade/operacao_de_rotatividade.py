import frappe
from frappe import _
from frappe.model.document import Document


class OperacaoDeRotatividade(Document):

	def validate(self):
		self._validar_comportamento()

	def _validar_comportamento(self):
		"""
		Keep the behaviour flags coherent so users can't build an entangled operation.
		Primary outcomes (move / bench / fire) are mutually exclusive; substituto and
		regime/reserve modifiers only make sense with the right outcome.
		"""
		# ── One primary outcome ──
		primary = sum(1 for x in (self.muda_posto, self.enviar_reserva, self.demite) if x)
		if primary > 1:
			frappe.throw(
				_("Escolha apenas <b>uma</b> acção principal: <b>Muda Posto</b>, "
				  "<b>Enviar para Reserva</b> ou <b>Cria Demissão</b> — um vigilante não "
				  "pode ser movido, reservado e demitido ao mesmo tempo."),
				title=_("Acções em Conflito"),
			)
		if primary == 0 and not self.de_reserva:
			frappe.throw(
				_("Seleccione pelo menos uma acção principal: <b>Muda Posto</b>, "
				  "<b>Enviar para Reserva</b>, <b>Cria Demissão</b> ou <b>Origem: Reserva</b>."),
				title=_("Operação Sem Efeito"),
			)

		# ── Muda Regime only with Muda Posto ──
		if self.muda_regime and not self.muda_posto:
			frappe.throw(
				_("<b>Muda Regime</b> só é válido em conjunto com <b>Muda Posto</b>. "
				  "Para alterar apenas o regime, use o documento <b>Troca De Regime</b>."),
				title=_("Regime Sem Posto"),
			)

		# ── Origem: Reserva ──
		if self.de_reserva:
			if not self.muda_posto:
				frappe.throw(_("<b>Origem: Reserva</b> exige <b>Muda Posto</b> — o vigilante "
					"da reserva recebe um posto."), title=_("Reserva Sem Posto"))
			if self.demite or self.enviar_reserva:
				frappe.throw(_("<b>Origem: Reserva</b> não pode coexistir com Demissão nem "
					"Enviar para Reserva."), title=_("Acções em Conflito"))
			if self.requer_substituto:
				frappe.throw(_("<b>Origem: Reserva</b> não usa substituto — o vigilante vem da "
					"reserva e não liberta nenhum posto."), title=_("Substituto Sem Vaga"))

		# ── Requer Substituto needs a vacated posto ──
		if self.requer_substituto and not (self.muda_posto or self.enviar_reserva or self.demite):
			frappe.throw(
				_("<b>Requer Substituto</b> exige uma acção que liberte o posto "
				  "(<b>Muda Posto</b>, <b>Enviar para Reserva</b> ou <b>Cria Demissão</b>)."),
				title=_("Substituto Sem Vaga"),
			)

	def on_trash(self):
		if self.bloqueada:
			frappe.throw(
				_("A operação <b>{0}</b> é de sistema e não pode ser eliminada. "
				  "Desmarque <b>Activa</b> para a ocultar.").format(self.name),
				title=_("Operação Bloqueada"),
			)
