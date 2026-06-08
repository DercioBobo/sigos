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

			# Set the new regime and let the guard's on_update migrate the escala
			# (keystone: escala follows the guard — same posto, old→new regime).
			vig.regime_do_vigilante = self.novo_regime
			vig.flags.via_troca_regime = True   # bypass the direct-change guard
			vig.save(ignore_permissions=True)

			frappe.msgprint(
				_("Regime de <b>{0}</b> alterado: <b>{1}</b> → <b>{2}</b>. "
				  "A escala foi actualizada automaticamente.").format(
					self.vigilante, regime_antigo, self.novo_regime
				),
				title=_("Troca de Regime Concluída"),
				indicator="green",
			)

		except Exception as e:
			frappe.log_error(
				f"TrocaDeRegime {self.name}: erro ao trocar regime de {self.vigilante}: {e}",
				"SIGOS Troca De Regime",
			)
			raise
