import frappe
from frappe import _
from frappe.model.document import Document


class Readimissao(Document):

	def on_submit(self):
		if (self.get("workflow_state") or "Aprovado") != "Aprovado":
			return

		if not self.vigilante:
			return

		vig = frappe.get_doc("Vigilante", self.vigilante)
		if vig.status != "Demitido":
			frappe.throw(
				_("O vigilante {0} não está com estado <b>Demitido</b>. Readmissão não é possível.").format(
					self.vigilante
				),
				title=_("Readmissão Inválida"),
			)

		# Send the guard back to the START of the onboarding pipeline. RH will re-admit
		# with a FRESH admission date and the SAME Employee is reactivated at that point
		# (Active + relieving_date cleared). We keep funcionario so history is preserved.
		# ignore_sync: don't reactivate the Employee yet — they're only re-admitted once
		# RH completes the admission (status -> Pre-Adimissão). Until then it stays Left.
		vig.posto_de_vigilancia = None
		vig.projecto = None
		vig.nome_do_projecto = None
		vig.cliente = None
		vig.categoria = None
		vig.regime_do_vigilante = None
		vig.tipo_de_vigilante = None
		vig.data_admissao = None
		vig.status = "Pre-Adimissão RH"
		vig.flags.ignore_sync = True
		vig.save(ignore_permissions=True)

		# Reiniciar a antiguidade de FÉRIAS (ano 1) — limpamos a âncora e a última
		# acumulação no Employee; quando o RH concluir a admissão com a nova Data de
		# Admissão, o motor de férias re-fixa a âncora nessa data nova.
		if vig.funcionario and frappe.db.exists("Employee", vig.funcionario):
			frappe.db.set_value(
				"Employee", vig.funcionario,
				{"custom_data_antiguidade_ferias": None, "custom_ultima_acumulacao_ferias": None},
				update_modified=False,
			)

		from sigos.timeline import registar
		registar(self.vigilante,
			_("Readmitido — de <b>Demitido</b> para <b>Pre-Adimissão RH</b> (aguarda nova admissão)"), self)

		frappe.msgprint(
			_("Vigilante <b>{0}</b> readmitido — agora em <b>Pre-Adimissão RH</b>. "
			  "Conclua a admissão (RH) com uma nova <b>Data de Admissão</b> para o reactivar.").format(
				self.vigilante),
			indicator="green",
			alert=True,
		)
