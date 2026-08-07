import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime, today


class CoberturaDePosto(Document):

	def validate(self):
		if self.modo_termino == "Automático pela Data" and not self.data_fim_prevista:
			frappe.throw(
				_("Defina a <b>Fim Previsto</b> quando o encerramento é <b>Automático pela Data</b>.")
			)

	@frappe.whitelist()
	def atribuir_cobridor(self, vigilante_cobridor):
		if self.estado != "Por Atribuir":
			frappe.throw(_("Só é possível atribuir um Cobridor a uma cobertura <b>Por Atribuir</b>."))
		if not (self.posto_de_vigilancia and self.regime):
			frappe.throw(
				_("O vigilante coberto <b>{0}</b> não tem posto/regime definido — nada para cobrir.")
				.format(self.vigilante_coberto)
			)

		from sigos.security_ops.doctype.escala_do_vigilante.escala_do_vigilante import (
			obter_turno_inicial_actual, deployar_cobridor,
		)
		turno = obter_turno_inicial_actual(self.vigilante_coberto, self.posto_de_vigilancia, self.regime)
		if not turno:
			frappe.throw(
				_("O vigilante coberto <b>{0}</b> não tem uma posição de rotação activa neste "
				  "posto/regime — não é possível determinar que turno o Cobridor deve seguir.")
				.format(self.vigilante_coberto)
			)

		deployar_cobridor(vigilante_cobridor, self.name, self.posto_de_vigilancia, self.regime, turno)

		self.vigilante_cobridor = vigilante_cobridor
		self.turno_inicial_coberto = turno
		self.data_atribuicao = now_datetime()
		self.estado = "Activa"
		self.save(ignore_permissions=True)

		frappe.msgprint(
			_("Cobridor <b>{0}</b> atribuído — passa a seguir a escala de <b>{1}</b>.")
			.format(vigilante_cobridor, self.vigilante_coberto),
			indicator="green", alert=True,
		)

	@frappe.whitelist()
	def concluir(self):
		"""O vigilante coberto regressou — devolve o Cobridor à Reserva."""
		if self.estado != "Activa":
			return
		self._reverter_cobridor()
		self.estado = "Concluída"
		self.data_fim_real = today()
		self.save(ignore_permissions=True)
		frappe.msgprint(
			_("Cobertura concluída — Cobridor devolvido à Reserva."), indicator="green", alert=True
		)

	@frappe.whitelist()
	def efectivar(self):
		"""O vigilante coberto NÃO vai regressar a este posto — o Cobridor passa a
		titular efectivo (fica Activo, com o mesmo posto/regime/turno, mas deixa de
		ser um "shadow": liberta a marca que o excluía da contagem de capacidade e
		da facturação). O vigilante coberto NÃO é alterado por esta acção — a
		situação dele (Demissão, Rotatividade, etc.) é tratada separadamente."""
		if self.estado != "Activa":
			return
		if self.vigilante_cobridor:
			sub = frappe.get_doc("Vigilante", self.vigilante_cobridor)
			sub.cobertura_de_posto_activa = None
			sub.save(ignore_permissions=True)
		self.estado = "Efectivada"
		self.data_fim_real = today()
		self.save(ignore_permissions=True)
		frappe.msgprint(
			_("<b>{0}</b> passa a titular efectivo do posto. O vigilante coberto <b>{1}</b> "
			  "continua com este posto/regime no seu registo — resolva a situação dele "
			  "separadamente (Demissão, Rotatividade, etc.).")
			.format(self.vigilante_cobridor, self.vigilante_coberto),
			indicator="orange", title=_("Cobertura Efectivada"),
		)

	@frappe.whitelist()
	def cancelar(self, motivo=None):
		if self.estado in ("Concluída", "Cancelada", "Efectivada"):
			return
		if self.estado == "Activa":
			self._reverter_cobridor()
		self.estado = "Cancelada"
		self.motivo_cancelamento = motivo
		self.data_fim_real = today()
		self.save(ignore_permissions=True)
		frappe.msgprint(_("Cobertura cancelada."), indicator="orange", alert=True)

	def _reverter_cobridor(self):
		if not self.vigilante_cobridor:
			return
		from sigos.security_ops.doctype.escala_do_vigilante.escala_do_vigilante import reverter_cobridor
		reverter_cobridor(self.vigilante_cobridor)
