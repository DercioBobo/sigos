import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import today

from sigos.abandono import (
	PRESUNCAO_ABERTA, PRESUNCAO_ARQUIVADA, PRESUNCAO_EM_ANALISE, PRESUNCAO_EM_PROCESSO,
	sincronizar_presuncao,
)

# Who moves a Presunção along (the Jurista's workflow; SIGOS Manager can stand in).
PAPEIS_JURISTA = ("System Manager", "SIGOS Manager", "Jurista")


class PresuncaoDeAbandono(Document):
	"""
	Evidence of a presumed Abandono de Posto (sigos.abandono): one per guard per
	episode, opened by the daily detection (or the Vigilante's button). While
	Aberta the faltas table keeps piling up (sigos.abandono.sincronizar_presuncao);
	the Jurista moving it to Em Análise freezes the evidence. Estado is read-only —
	only the buttons below (and the guard leaving Abandono: Regressou / Concluída)
	change it. Not submittable: a living record, like Ocorrência.
	"""

	def validate(self):
		if self.is_new():
			return
		antes = self.get_doc_before_save()
		if antes and antes.estado != self.estado and not self.flags.ignore_permissions:
			frappe.throw(_("O estado só muda pelos botões da Presunção."), title=_("Estado Bloqueado"))

	def on_update(self):
		antes = self.get_doc_before_save()
		if antes and antes.estado != self.estado:
			from sigos.timeline import registar
			registar(self.vigilante, _("Presunção de Abandono <b>{0}</b>: {1}").format(
				self.name, self.estado), self)

	def _mudar_estado(self, novo, permitidos, **campos):
		frappe.only_for(PAPEIS_JURISTA)
		if self.estado not in permitidos:
			frappe.throw(
				_("Não é possível passar de <b>{0}</b> para <b>{1}</b>.").format(self.estado, novo),
				title=_("Estado Inválido"),
			)
		self.estado = novo
		for k, v in campos.items():
			self.set(k, v)
		self.flags.ignore_permissions = True
		self.save()
		return self.estado

	@frappe.whitelist()
	def actualizar_faltas(self):
		"""Re-read the faltas now (the daily job and every Ausencias submit do it too)."""
		frappe.has_permission(self.doctype, "read", doc=self, throw=True)
		sincronizar_presuncao(self.name)
		return True

	@frappe.whitelist()
	def iniciar_analise(self):
		"""Jurista takes it — the faltas table stops piling (frozen evidence)."""
		sincronizar_presuncao(self.name)
		self.reload()
		return self._mudar_estado(
			PRESUNCAO_EM_ANALISE, (PRESUNCAO_ABERTA,),
			jurista=frappe.session.user, data_analise=today(),
		)

	@frappe.whitelist()
	def reabrir(self):
		"""Back to Aberta — piles faltas again (e.g. analysis taken too early)."""
		estado = self._mudar_estado(PRESUNCAO_ABERTA, (PRESUNCAO_EM_ANALISE,))
		sincronizar_presuncao(self.name)
		return estado

	@frappe.whitelist()
	def encaminhar_para_processo(self, processo_disciplinar=None):
		"""Forward to a Processo Disciplinar — an existing one, or (default) a new
		draft opened here from the Presunção (motivo Abandono de Posto, the faltas as
		detalhes). The Jurista decides there; a Demissão decision dismisses the guard
		and concludes this Presunção. Returns {estado, processo_disciplinar}."""
		if not processo_disciplinar and not self.processo_disciplinar:
			processo_disciplinar = self._abrir_processo()
		self._mudar_estado(
			PRESUNCAO_EM_PROCESSO, (PRESUNCAO_ABERTA, PRESUNCAO_EM_ANALISE),
			processo_disciplinar=processo_disciplinar or self.processo_disciplinar,
			jurista=self.jurista or frappe.session.user,
		)
		return {"estado": self.estado, "processo_disciplinar": self.processo_disciplinar}

	def _abrir_processo(self):
		frappe.only_for(PAPEIS_JURISTA)
		frappe.has_permission("Processo Disciplinar", "create", throw=True)
		faltas = "".join(
			f"<li>{frappe.utils.formatdate(f.data)} — {f.turno or ''} ({f.n_de_faltas or 0})</li>"
			for f in self.faltas
		)
		pd = frappe.get_doc({
			"doctype": "Processo Disciplinar",
			"data": today(),
			"delegacao": self.delegacao,
			"vigilante": self.vigilante,
			"gravidade": "Alta",
			"motivo": _("Abandono de Posto"),
			"detalhes": _("<p>Presunção de Abandono <b>{0}</b>: ausente desde {1} — {2} dia(s) com falta, "
				"{3} falta(s).</p><ul>{4}</ul>").format(
				self.name, frappe.utils.formatdate(self.primeira_falta), self.total_dias or 0,
				self.total_faltas or 0, faltas),
			"automatico": _("Presunção de Abandono {0}").format(self.name),
		})
		pd.insert(ignore_permissions=True)
		return pd.name

	@frappe.whitelist()
	def arquivar(self, nota=None):
		"""No case (e.g. faltas justified). The guard's status is handled on the
		Vigilante (Registar Regresso / Demitir)."""
		if not (nota or "").strip():
			frappe.throw(_("Indique o motivo do arquivamento."))
		return self._mudar_estado(
			PRESUNCAO_ARQUIVADA, (PRESUNCAO_ABERTA, PRESUNCAO_EM_ANALISE, PRESUNCAO_EM_PROCESSO),
			data_fecho=today(), nota_fecho=nota.strip(),
		)
