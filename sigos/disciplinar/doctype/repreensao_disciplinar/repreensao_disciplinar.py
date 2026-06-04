import frappe
from frappe import _
from frappe.model.document import Document


class RepreensaoDisciplinar(Document):

	def on_update(self):
		if self.workflow_state != "Aprovado":
			return

		self._verificar_criar_processo_disciplinar()

	def _verificar_criar_processo_disciplinar(self):
		funcionario = self.funcionario
		if not funcionario:
			return

		# Count reprimendas by gravidade for this employee
		rep_baixa = frappe.db.count(
			"Repreensao Disciplinar",
			{"funcionario": funcionario, "gravidade": "Baixa", "docstatus": 1}
		)
		rep_media = frappe.db.count(
			"Repreensao Disciplinar",
			{"funcionario": funcionario, "gravidade": "Média", "docstatus": 1}
		)
		rep_alta = frappe.db.count(
			"Repreensao Disciplinar",
			{"funcionario": funcionario, "gravidade": "Alta", "docstatus": 1}
		)

		# Get thresholds from settings (defaults if not configured)
		limite_baixa = frappe.db.get_single_value("SIGOS Settings", "reprimendas_baixa_pd") or 3
		limite_media = frappe.db.get_single_value("SIGOS Settings", "reprimendas_media_pd") or 2
		limite_alta = frappe.db.get_single_value("SIGOS Settings", "reprimendas_alta_pd") or 1

		criar_pd = False
		razao = None

		if rep_alta >= limite_alta:
			criar_pd = True
			razao = f"Uma Repreensão Alta (total: {rep_alta})"
		elif rep_media >= limite_media:
			criar_pd = True
			razao = f"Mais de {limite_media} Repreensões Médias (total: {rep_media})"
		elif rep_baixa >= limite_baixa:
			criar_pd = True
			razao = f"Mais de {limite_baixa} Repreensões Baixas (total: {rep_baixa})"

		if not criar_pd:
			return

		# Check if a PD already exists from this reprimenda
		existing_pd = frappe.db.exists(
			"Processo Disciplinar",
			{"repreensao_referente": self.name}
		)
		if existing_pd:
			return

		try:
			pd = frappe.new_doc("Processo Disciplinar")
			pd.naming_series = "PD-.YY.-.##"
			pd.funcionario = funcionario
			pd.vigilante = self.vigilante
			pd.nome_do_vigilante = self.nome_do_vigilante
			pd.delegacao = self.delegacao
			pd.posto = self.posto
			pd.gravidade = self.gravidade
			pd.categoria = self.categoria
			pd.motivo = self.motivo
			pd.detalhes = self.detalhes
			pd.repreensao_referente = self.name
			pd.automatico = razao
			pd.insert(ignore_permissions=True)

			frappe.msgprint(
				_("Processo Disciplinar {0} criado automaticamente. Razão: {1}").format(
					pd.name, razao
				),
				alert=True
			)
		except Exception as e:
			frappe.log_error(
				f"RepreensaoDisciplinar {self.name}: erro ao criar Processo Disciplinar: {e}",
				"SIGOS Repreensao Disciplinar"
			)
