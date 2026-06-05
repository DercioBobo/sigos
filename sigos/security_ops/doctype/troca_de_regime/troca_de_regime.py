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
			vigilante_doc = frappe.get_doc("Vigilante", self.vigilante)
			vigilante_doc.regime_do_vigilante = self.novo_regime
			vigilante_doc.flags.via_troca_regime = True  # bypass the direct-change guard
			vigilante_doc.save(ignore_permissions=True)
			frappe.msgprint(
				_("Regime do vigilante <b>{0}</b> atualizado para <b>{1}</b>.").format(
					self.vigilante, self.novo_regime
				),
				alert=True,
			)
		except Exception as e:
			frappe.log_error(
				f"TrocaDeRegime {self.name}: erro ao atualizar regime do vigilante {self.vigilante}: {e}",
				"SIGOS Troca De Regime",
			)

		# Wizard triggered client-side via after_submit in troca_de_regime.js
