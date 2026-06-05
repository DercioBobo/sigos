import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import today


class TrocaDeRegime(Document):

	def on_submit(self):
		if (self.get("workflow_state") or "Aprovado") != "Aprovado":
			return
		if not self.vigilante:
			return

		try:
			vig = frappe.get_doc("Vigilante", self.vigilante)
			posto = vig.posto_de_vigilancia
			regime_antigo = vig.regime_do_vigilante   # authoritative current regime

			if regime_antigo == self.novo_regime:
				return  # nothing to do

			# 1) Update the guard's regime (bypass the direct-change guard)
			vig.regime_do_vigilante = self.novo_regime
			vig.flags.via_troca_regime = True
			vig.save(ignore_permissions=True)

			# 2) Move the guard between escalas at the SAME posto
			migrou = self._migrar_escala(posto, regime_antigo, self.novo_regime)

			msg = _("Regime de <b>{0}</b> alterado: <b>{1}</b> → <b>{2}</b>.").format(
				self.vigilante, regime_antigo, self.novo_regime
			)
			if migrou:
				msg += "<br>" + migrou
			frappe.msgprint(msg, title=_("Troca de Regime Concluída"), indicator="green")

		except Exception as e:
			frappe.log_error(
				f"TrocaDeRegime {self.name}: erro ao trocar regime de {self.vigilante}: {e}",
				"SIGOS Troca De Regime",
			)
			raise

	# ─── Escala migration (same posto, old regime → new regime) ──────────────────

	def _migrar_escala(self, posto, regime_antigo, regime_novo):
		"""
		Remove the guard from the (posto, regime_antigo) escala and add them to the
		(posto, regime_novo) escala — creating the latter if it doesn't exist.
		Saving each escala runs reconciliar_escala(), which drops/generates day-rows.
		Returns a human summary, or None when the guard has no posto.
		"""
		if not posto:
			return None

		removido_de = self._remover_da_escala(posto, regime_antigo)
		adicionado_a, criada = self._adicionar_a_escala(posto, regime_novo)

		partes = []
		if removido_de:
			partes.append(_("Removido da escala {0}").format(removido_de))
		if adicionado_a:
			partes.append(
				_("Adicionado à escala {0}{1}").format(
					adicionado_a, _(" (criada)") if criada else ""
				)
			)
		return " · ".join(partes) if partes else None

	def _remover_da_escala(self, posto, regime):
		nome = frappe.db.get_value(
			"Escala Do Vigilante",
			{"posto_de_vigilancia": posto, "regime_do_vigilante": regime, "estado": ["!=", "Arquivado"]},
			"name",
		)
		if not nome:
			return None
		esc = frappe.get_doc("Escala Do Vigilante", nome)
		antes = len(esc.tab_vigilante_do_posto)
		esc.set("tab_vigilante_do_posto", [
			g for g in esc.tab_vigilante_do_posto if g.vigilante != self.vigilante
		])
		if len(esc.tab_vigilante_do_posto) == antes:
			return None  # guard wasn't in it
		esc.save(ignore_permissions=True)  # reconcile drops their future rows
		return nome

	def _adicionar_a_escala(self, posto, regime):
		nome = frappe.db.get_value(
			"Escala Do Vigilante",
			{"posto_de_vigilancia": posto, "regime_do_vigilante": regime, "estado": ["!=", "Arquivado"]},
			"name",
		)
		criada = False
		if nome:
			esc = frappe.get_doc("Escala Do Vigilante", nome)
		else:
			esc = frappe.new_doc("Escala Do Vigilante")
			esc.posto_de_vigilancia = posto
			esc.regime_do_vigilante = regime
			esc.data_de_inicio = today()
			esc.estado = "Activo"
			cliente = frappe.db.get_value("Posto De Vigilancia", posto, "cliente")
			if cliente:
				esc.cliente = cliente
			criada = True

		if not any(g.vigilante == self.vigilante for g in esc.tab_vigilante_do_posto):
			esc.append("tab_vigilante_do_posto", {
				"vigilante": self.vigilante,
				"turno_inicial": self._escolher_turno_inicial(esc, regime),
			})

		esc.save(ignore_permissions=True)  # reconcile generates their rows
		return esc.name, criada

	def _escolher_turno_inicial(self, esc, regime):
		"""Pick a free working turno to keep coverage; fall back to the first working turno."""
		from sigos.utils import get_regime_turno_sequence
		seq = get_regime_turno_sequence(regime)
		working = [t["turno"] for t in seq if not t.get("e_folga")]
		if not working:
			return None
		usados = {g.turno_inicial for g in esc.tab_vigilante_do_posto if g.turno_inicial}
		livres = [t for t in working if t not in usados]
		return livres[0] if livres else working[0]
