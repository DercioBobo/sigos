import frappe
from frappe import _
from frappe.model.document import Document


def limite_repreensoes():
	"""Repreensões (since the guard's last Processo Disciplinar) at which the Jurista is
	asked whether to open a process. The Jurista decides — nothing opens on its own."""
	from sigos.utils import valor_settings_bruto
	v = valor_settings_bruto("repreensoes_para_processo")
	return 3 if v in (None, "", "0", 0) else int(v)


@frappe.whitelist()
def limite():
	return limite_repreensoes()


@frappe.whitelist()
def abrir_processo_da_repreensao(repreensao, justificacao_fora_de_prazo=None):
	"""UI shortcut (Participação → "abrir processo?" after the Nth repreensão)."""
	return frappe.get_doc("Repreensao", repreensao).abrir_processo(justificacao_fora_de_prazo)


def contar_repreensoes(vigilante, excluir=None):
	"""Submitted repreensões of the guard since his most recent Processo Disciplinar
	(a process resets the count, like the participações accumulation)."""
	desde = frappe.db.get_value(
		"Processo Disciplinar", {"vigilante": vigilante, "docstatus": ["<", 2]}, "creation",
		order_by="creation desc")
	filtros = {"vigilante": vigilante, "docstatus": 1, "name": ["!=", excluir or ""]}
	if desde:
		filtros["creation"] = [">", desde]
	return frappe.db.count("Repreensao", filtros)


class Repreensao(Document):
	"""
	Repreensão — the Jurista's LIGHT outcome of a submitted Participação: a record that
	stays in the guard's history, with no effect on posto, escala or pay. Numbered per
	guard since his last Processo Disciplinar; reaching the limit (SIGOS Settings,
	default 3) makes the UI ask the Jurista whether to open a process (abrir_processo).
	"""

	def validate(self):
		p = frappe.db.get_value(
			"Participacao", self.participacao,
			["docstatus", "vigilante", "nome_do_vigilante", "mecanografico", "delegacao", "gravidade",
			 "tipo_de_infracao", "data_conhecimento_infracao"], as_dict=True,
		)
		if not p or p.docstatus != 1:
			frappe.throw(_("A repreensão parte de uma <b>Participação submetida</b>."))
		outra = frappe.db.get_value(
			"Repreensao", {"participacao": self.participacao, "docstatus": ["<", 2], "name": ["!=", self.name]})
		if outra:
			frappe.throw(_("Esta participação já tem a Repreensão <b>{0}</b>.").format(outra))
		self.vigilante = p.vigilante
		self.nome_do_vigilante = p.nome_do_vigilante
		self.mecanografico = p.mecanografico
		self.delegacao = p.delegacao
		self.gravidade = p.gravidade
		self.data_conhecimento_infracao = p.data_conhecimento_infracao
		infr = frappe.get_all("Participacao Infracao",
			filters={"parent": self.participacao, "parenttype": "Participacao"},
			pluck="tipo_de_infracao", order_by="idx")
		self.infracoes = ", ".join(infr) or p.tipo_de_infracao
		self.jurista = self.jurista or frappe.session.user

	def before_submit(self):
		self.numero = contar_repreensoes(self.vigilante, self.name) + 1

	def on_submit(self):
		frappe.db.set_value("Participacao", self.participacao, "repreensao", self.name, update_modified=False)
		from sigos.timeline import registar
		texto = _("<b>Repreensão</b> ({0}.ª) — {1}").format(self.numero, self.infracoes or "")
		if self.observacoes:
			texto += _(" · {0}").format(self.observacoes[:200])
		registar(self.vigilante, texto, self)

	def on_cancel(self):
		if frappe.db.get_value("Participacao", self.participacao, "repreensao") == self.name:
			frappe.db.set_value("Participacao", self.participacao, "repreensao", None, update_modified=False)
		from sigos.timeline import registar
		registar(self.vigilante, _("Repreensão <b>cancelada</b> ({0})").format(self.name), self)

	@frappe.whitelist()
	def abrir_processo(self, justificacao_fora_de_prazo=None):
		"""The Jurista decided this repreensão (normally the Nth) warrants a Processo
		Disciplinar — opened from its Participação, linked both ways."""
		frappe.has_permission("Processo Disciplinar", "create", throw=True)
		if self.docstatus != 1:
			frappe.throw(_("Submeta a repreensão primeiro."))
		if self.processo_disciplinar:
			return self.processo_disciplinar
		part = frappe.get_doc("Participacao", self.participacao)
		existente = frappe.db.exists(
			"Processo Disciplinar", {"participacao_referente": part.name, "docstatus": ["<", 2]})
		pd = existente or part._abrir_processo(
			_("{0}.ª Repreensão ({1})").format(self.numero, self.name), repreensao=self.name,
			justificacao_fora_de_prazo=justificacao_fora_de_prazo)
		self.db_set("processo_disciplinar", pd)
		return pd
