import frappe
from frappe import _
from frappe.model.document import Document


class TrocaDeRegime(Document):

	def on_submit(self):
		if (self.get("workflow_state") or "Aprovado") != "Aprovado":
			return
		if not self.vigilante:
			return

		try:
			vig = frappe.get_doc("Vigilante", self.vigilante)
			regime_antigo = vig.regime_do_vigilante
			if regime_antigo == self.novo_regime:
				return  # nothing to do

			modo = self.accao_escala or "Deixar sem escala"
			posto = vig.posto_de_vigilancia

			# Validate the chosen escala action against reality (one escala per posto+regime).
			from sigos.security_ops.doctype.escala_do_vigilante.escala_do_vigilante import _escala_do_par
			destino_existe = _escala_do_par(posto, self.novo_regime) if posto else None
			if modo == "Alocar em escala existente" and not destino_existe:
				frappe.throw(
					_("Não existe escala para o posto no regime <b>{0}</b>. "
					  "Escolha <b>Criar nova escala</b> ou <b>Deixar sem escala</b>.").format(self.novo_regime),
					title=_("Escala Inexistente"),
				)
			if modo == "Criar nova escala" and destino_existe:
				frappe.throw(
					_("Já existe uma escala para o posto no regime <b>{0}</b> ({1}). "
					  "Escolha <b>Alocar em escala existente</b>.").format(self.novo_regime, destino_existe),
					title=_("Escala Já Existe"),
				)

			# Set the new regime and let the guard's on_update migrate the escala
			# (keystone: escala follows the guard — same posto, old→new regime). The guard
			# always LEAVES the old regime's escala; whether it JOINS one in the new regime
			# depends on the chosen action (escala_modo flag below).
			vig.regime_do_vigilante = self.novo_regime
			vig.flags.via_troca_regime = True   # bypass the direct-change guard
			if modo == "Deixar sem escala":
				vig.flags.escala_modo = "sem_escala"   # remove from old escala, do NOT join a new one
			vig.save(ignore_permissions=True)

			from sigos.timeline import registar
			registar(self.vigilante,
				_("Regime alterado: <b>{0}</b> → <b>{1}</b>").format(regime_antigo or "-", self.novo_regime), self)

			if modo == "Deixar sem escala":
				extra, indicador = (
					_("O vigilante ficou <b>sem escala</b> — aloque-o manualmente quando quiser."),
					"orange",
				)
			elif modo == "Alocar em escala existente":
				extra, indicador = (
					_("O vigilante foi alocado na escala existente do novo regime."),
					"green",
				)
			else:
				extra, indicador = (
					_("Foi criada uma nova escala para o novo regime."),
					"green",
				)

			frappe.msgprint(
				_("Regime de <b>{0}</b> alterado: <b>{1}</b> → <b>{2}</b>. {3}").format(
					self.vigilante, regime_antigo, self.novo_regime, extra
				),
				title=_("Troca de Regime Concluída"),
				indicator=indicador,
			)

		except Exception as e:
			frappe.log_error(
				f"TrocaDeRegime {self.name}: erro ao trocar regime de {self.vigilante}: {e}",
				"SIGOS Troca De Regime",
			)
			raise
