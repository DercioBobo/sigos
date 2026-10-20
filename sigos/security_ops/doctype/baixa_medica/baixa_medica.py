import frappe
from frappe import _
from frappe.model.document import Document

# Set only by sigos.doenca (Marcar Doente / Registar Regresso) — never by hand.
_CAMPOS_DE_SISTEMA = (
	"vigilante", "estado", "data_inicio", "data_regresso", "dias", "posto_anterior",
	"regime_anterior", "turno_anterior", "tipo_de_vigilante_anterior", "estado_anterior",
	"vaga", "destino_regresso", "pago_por",
)


class BaixaMedica(Document):
	"""
	One sick-leave episode of a guard (sigos.doenca). Opened by the Vigilante's
	"Marcar Doente" button (status Doente, off posto + escala), closed by its
	"Registar Regresso" (or a dismissal). The days are paid by INSS, not the
	company: the guard is left out of Payroll Entries while Doente, and any
	payslip overlapping an episode deducts those days (salary_slip_hooks).
	Only the atestado and observações are editable here.
	"""

	def validate(self):
		if self.is_new() or self.flags.sistema:
			return
		antes = self.get_doc_before_save()
		if not antes:
			return
		for campo in _CAMPOS_DE_SISTEMA:
			if str(antes.get(campo) or "") != str(self.get(campo) or ""):
				frappe.throw(
					_("O campo <b>{0}</b> é gerido pelo Vigilante (Marcar Doente / Registar "
					  "Regresso) e não pode ser alterado aqui.").format(self.meta.get_label(campo)),
					title=_("Campo Bloqueado"),
				)
