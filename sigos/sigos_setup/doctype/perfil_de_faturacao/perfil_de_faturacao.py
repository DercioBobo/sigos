import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint


class PerfilDeFaturacao(Document):

	def validate(self):
		from sigos.descricao_fatura import validar_modelo
		validar_modelo(self.modelo_descricao, _("Texto da Linha"))
		if self.faturacao_automatica and not 1 <= cint(self.dia_faturacao) <= 31:
			frappe.throw(_("O Dia de Emissão deve estar entre 1 e 31."))
		vistos = set()
		for r in self.regimes:
			if r.regime in vistos:
				frappe.throw(_("O regime {0} aparece mais de uma vez nas excepções.").format(r.regime))
			vistos.add(r.regime)

	def on_trash(self):
		if frappe.db.get_single_value("SIGOS Settings", "perfil_faturacao_padrao") == self.name:
			frappe.throw(_("Este é o perfil padrão das Definições SIGOS — escolha outro antes de o apagar."))
