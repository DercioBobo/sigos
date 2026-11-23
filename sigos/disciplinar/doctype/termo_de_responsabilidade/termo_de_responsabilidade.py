import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import formatdate

# Placeholders: {nome} {numero} {categoria} {origem} {participacao} {processo} {infracoes} {data} {posto}
TEXTO_PADRAO = (
	"Eu, {nome}, vigilante n.º {numero}, declaro que tomei conhecimento da {origem}, "
	"relativa a: {infracoes}, ocorrida em {data}.\n\n"
	"Reconheço os factos descritos, assumo inteira responsabilidade pelos mesmos e comprometo-me "
	"a cumprir as normas, regulamentos e instruções de serviço da empresa.\n\n"
	"Declaro ainda ter sido informado de que a repetição de comportamento semelhante poderá dar "
	"lugar à instauração de procedimento disciplinar."
)


def termo_da_participacao(participacao, excluir=None):
	"""The Jurista's Termo for this participação (draft or submitted, not PD-born).
	A Termo is the participação's ONLY outcome: no Repreensão or Processo after it."""
	if not participacao:
		return None
	return frappe.db.get_value("Termo De Responsabilidade",
		{"participacao": participacao, "processo_disciplinar": ["is", "not set"],
		 "docstatus": ["<", 2], "name": ["!=", excluir or ""]})


def exigir_sem_termo(participacao, accao):
	"""Kept for callers: a Termo OR a Denúncia closes the participação."""
	from sigos.disciplinar.desfechos import exigir_livre
	exigir_livre(participacao, accao)


class _Seguro(dict):
	def __missing__(self, k):
		return "{" + k + "}"


class TermoDeResponsabilidade(Document):
	"""
	Termo de Responsabilidade — an acknowledgment, NOT a sanction: the guard signs that
	he took note of the facts and commits to the rules. No effect on posto, escala or
	pay. Two sources:
	  - a submitted Participação (Jurista button, instead of / besides a Repreensão);
	  - a Processo Disciplinar decided "Termo de Responsabilidade" (created on approval,
	    `processo_disciplinar` set; the participação, if any, is only context).
	The declaration text comes from SIGOS Settings (or TEXTO_PADRAO), editable until submit.
	"""

	def validate(self):
		if self.processo_disciplinar:
			self._de_processo()
		elif self.participacao:
			self._de_participacao()
		else:
			frappe.throw(_("O termo de responsabilidade parte de uma <b>Participação</b> ou de um "
				"<b>Processo Disciplinar</b>."))
		# PD-born termos are created at approval (often by RH): stamped when the Jurista saves
		if not self.jurista and (not self.processo_disciplinar or "Jurista" in frappe.get_roles()):
			self.jurista = frappe.session.user
		if not (self.declaracao or "").strip():
			self.declaracao = self._texto_padrao()

	def _de_participacao(self):
		p = frappe.db.get_value(
			"Participacao", self.participacao,
			["docstatus", "vigilante", "nome_do_vigilante", "mecanografico", "categoria", "posto",
			 "posto_nome", "delegacao", "gravidade", "tipo_de_infracao", "data", "data_conhecimento_infracao"],
			as_dict=True,
		)
		if not p or p.docstatus != 1:
			frappe.throw(_("O termo de responsabilidade parte de uma <b>Participação submetida</b>."))
		from sigos.disciplinar.desfechos import exigir_livre
		exigir_livre(self.participacao, _("outro Termo de Responsabilidade"), excluir=self.name)
		# exclusive outcome: only on a participação the Jurista hasn't acted on yet
		rep = frappe.db.get_value("Repreensao", {"participacao": self.participacao, "docstatus": ["<", 2]})
		pd = frappe.db.get_value("Processo Disciplinar",
			{"participacao_referente": self.participacao, "docstatus": ["<", 2]})
		if rep or pd:
			frappe.throw(_("Esta participação já seguiu para {0} <b>{1}</b> — o Termo de Responsabilidade "
				"só é possível sem outra acção.").format(
				_("Repreensão") if rep else _("Processo Disciplinar"), rep or pd), title=_("Participação com Acção"))
		infr = frappe.get_all("Participacao Infracao",
			filters={"parent": self.participacao, "parenttype": "Participacao"},
			pluck="tipo_de_infracao", order_by="idx")
		self._copiar(p, ", ".join(infr) or p.tipo_de_infracao, p.posto, p.posto_nome, p.data)

	def _de_processo(self):
		pd = frappe.db.get_value(
			"Processo Disciplinar", self.processo_disciplinar,
			["docstatus", "decisao", "vigilante", "nome_do_vigilante", "mecanografico", "categoria", "posto",
			 "posto_nome", "posto_ocorrencia", "posto_ocorrencia_nome", "delegacao", "gravidade", "infracoes",
			 "motivo", "data_ocorrencia", "data_conhecimento_infracao", "participacao_referente"],
			as_dict=True,
		)
		if not pd or pd.docstatus == 2:
			frappe.throw(_("Processo Disciplinar inválido."))
		outro = frappe.db.get_value("Termo De Responsabilidade",
			{"processo_disciplinar": self.processo_disciplinar, "docstatus": ["<", 2], "name": ["!=", self.name]})
		if outro:
			frappe.throw(_("Este processo já tem o Termo de Responsabilidade <b>{0}</b>.").format(outro))
		self.participacao = pd.participacao_referente
		self._copiar(pd, pd.infracoes or pd.motivo, pd.posto_ocorrencia or pd.posto,
			pd.posto_ocorrencia_nome or pd.posto_nome, pd.data_ocorrencia)

	def _copiar(self, src, infracoes, posto, posto_nome, data_ocorrencia):
		self.vigilante = src.vigilante
		self.nome_do_vigilante = src.nome_do_vigilante
		self.mecanografico = src.mecanografico
		self.categoria = src.categoria
		self.posto = posto
		self._posto_nome = posto_nome or posto or ""
		self.delegacao = src.delegacao
		self.gravidade = src.gravidade
		self.data_ocorrencia = data_ocorrencia
		self.data_conhecimento_infracao = src.data_conhecimento_infracao
		self.infracoes = infracoes

	def before_submit(self):
		if not (self.declaracao or "").strip():
			frappe.throw(_("Preencha a <b>Declaração do Vigilante</b>."))

	def _texto_padrao(self):
		from sigos.utils import valor_settings_bruto
		modelo = (valor_settings_bruto("texto_termo_responsabilidade") or "").strip() or TEXTO_PADRAO
		try:
			return self._preencher(modelo)
		except (ValueError, IndexError):  # stray braces in a customised template
			return modelo

	def _preencher(self, modelo):
		origem = (_("decisão do Processo Disciplinar n.º {0}").format(self.processo_disciplinar)
			if self.processo_disciplinar else _("Participação n.º {0}").format(self.participacao))
		return modelo.format_map(_Seguro(
			nome=(self.nome_do_vigilante or self.vigilante or "").upper(),
			numero=self.mecanografico or "",
			categoria=self.categoria or "",
			origem=origem,
			participacao=self.participacao or "",
			processo=self.processo_disciplinar or "",
			infracoes=self.infracoes or "",
			data=formatdate(self.data_ocorrencia, "dd-MM-yyyy") if self.data_ocorrencia else "",
			posto=getattr(self, "_posto_nome", "") or self.posto or "",
		))

	def after_insert(self):
		self._ligar(self.name)  # a draft already closes the participação to other actions

	def on_trash(self):
		self._ligar(None)

	def on_submit(self):
		self._ligar(self.name)
		from sigos.timeline import registar
		registar(self.vigilante, _("<b>Termo de Responsabilidade</b> — {0}").format(self.infracoes or ""), self)

	def on_cancel(self):
		self._ligar(None)
		from sigos.timeline import registar
		registar(self.vigilante, _("Termo de Responsabilidade <b>cancelado</b> ({0})").format(self.name), self)

	def _ligar(self, valor):
		"""Participação.termo_responsabilidade = the Jurista's direct outcome only (a
		PD-born termo is reached through the process, which mirrors it itself)."""
		if self.processo_disciplinar or not self.participacao:
			return
		atual = frappe.db.get_value("Participacao", self.participacao, "termo_responsabilidade")
		if valor or atual == self.name:
			frappe.db.set_value("Participacao", self.participacao, "termo_responsabilidade", valor,
				update_modified=False)


def criar_do_processo(pd):
	"""Processo Disciplinar approved with decisão "Termo de Responsabilidade": a DRAFT
	termo for the Jurista to review, print, have signed and submit. Idempotent."""
	existente = frappe.db.get_value("Termo De Responsabilidade",
		{"processo_disciplinar": pd.name, "docstatus": ["<", 2]})
	if not existente:
		termo = frappe.get_doc({"doctype": "Termo De Responsabilidade", "processo_disciplinar": pd.name})
		termo.flags.ignore_permissions = True  # the approver (RH) may not create termos
		termo.insert()
		existente = termo.name
	pd.db_set("termo_responsabilidade_doc", existente, update_modified=False)
	return existente


def anular_do_processo(pd):
	"""Processo cancelled: the draft termo goes away, a submitted one is cancelled."""
	for t in frappe.get_all("Termo De Responsabilidade",
			filters={"processo_disciplinar": pd.name, "docstatus": ["<", 2]}, fields=["name", "docstatus"]):
		doc = frappe.get_doc("Termo De Responsabilidade", t.name)
		doc.flags.ignore_permissions = True
		if t.docstatus == 1:
			doc.cancel()
		else:
			frappe.delete_doc("Termo De Responsabilidade", t.name, ignore_permissions=True)
