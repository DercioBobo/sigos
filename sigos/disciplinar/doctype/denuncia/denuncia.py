import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_months, formatdate, getdate, today

MESES_PERIODO_EXPERIMENTAL = 3


def periodo_experimental(vigilante):
	"""(admissão, fim) of the guard's probation: the latest admission (Vigilante
	data_admissao, reset on readmission) or the Employee's date_of_joining; fim =
	admissão + 3 months (inclusive)."""
	adm, func = frappe.db.get_value("Vigilante", vigilante, ["data_admissao", "funcionario"]) or (None, None)
	if not adm and func:
		adm = frappe.db.get_value("Employee", func, "date_of_joining")
	if not adm:
		return None, None
	adm = getdate(adm)
	return adm, getdate(add_months(adm, MESES_PERIODO_EXPERIMENTAL))


@frappe.whitelist()
def elegibilidade(vigilante):
	"""UI: can this guard still be dismissed by Denúncia?"""
	frappe.has_permission("Vigilante", "read", doc=vigilante, throw=True)
	adm, fim = periodo_experimental(vigilante)
	return {"admissao": adm, "fim": fim, "elegivel": bool(fim and getdate(today()) <= fim)}


class Denuncia(Document):
	"""
	Denúncia — dismissal during the probation period (≤ 3 months after admission),
	without a Processo Disciplinar. The only decision is Demissão: submitting creates
	and submits the Demissão (motivo "Denúncia"). Created by the Jurista from a
	submitted Participação (an exclusive outcome, like the Termo — sigos.disciplinar.
	desfechos) or directly for the guard.
	"""

	def validate(self):
		self.decisao = "Demissão"
		if self.participacao:
			self._da_participacao()
		if not self.vigilante:
			frappe.throw(_("Indique o vigilante."))
		status = frappe.db.get_value("Vigilante", self.vigilante, "status")
		if status == "Demitido":
			frappe.throw(_("O vigilante já está <b>Demitido</b>."))
		outra = frappe.db.get_value("Denuncia",
			{"vigilante": self.vigilante, "docstatus": ["<", 2], "name": ["!=", self.name]})
		if outra:
			frappe.throw(_("Este vigilante já tem a Denúncia <b>{0}</b>.").format(outra))
		self.data_admissao, self.fim_periodo_experimental = periodo_experimental(self.vigilante)
		if not self.data_admissao:
			frappe.throw(_("O vigilante não tem <b>Data de Admissão</b> — não é possível verificar o período experimental."))
		if getdate(self.data) > getdate(today()):
			frappe.throw(_("A Data da Denúncia não pode ser no futuro."))
		self._exigir_periodo(self.data, _("A Data da Denúncia"))
		if getdate(self.data_de_demissao) < getdate(self.data):
			frappe.throw(_("A Data de Efeito não pode ser anterior à Data da Denúncia."))
		self.jurista = self.jurista or frappe.session.user

	def before_submit(self):
		# the act itself must happen within the probation, not only its stated date
		self._exigir_periodo(today(), _("A denúncia (hoje)"))
		existente = frappe.db.get_value("Demissao", {"vigilante": self.vigilante, "docstatus": 1})
		if existente:
			frappe.throw(_("Já existe a Demissão submetida <b>{0}</b> para este vigilante.").format(existente))

	def _exigir_periodo(self, data, o_que):
		if getdate(data) > self.fim_periodo_experimental:
			frappe.throw(
				_("{0} está fora do período experimental: admitido a {1}, terminou a {2} ({3} meses). "
				  "Siga pela Participação / Processo Disciplinar.").format(
					o_que, formatdate(self.data_admissao), formatdate(self.fim_periodo_experimental),
					MESES_PERIODO_EXPERIMENTAL),
				title=_("Fora do Período Experimental"))

	def _da_participacao(self):
		p = frappe.db.get_value("Participacao", self.participacao,
			["docstatus", "vigilante", "tipo_de_infracao"], as_dict=True)
		if not p or p.docstatus != 1:
			frappe.throw(_("A denúncia parte de uma <b>Participação submetida</b>."))
		from sigos.disciplinar.desfechos import exigir_livre
		exigir_livre(self.participacao, _("outra Denúncia"), excluir=self.name)
		pd = frappe.db.get_value("Processo Disciplinar",
			{"participacao_referente": self.participacao, "docstatus": ["<", 2]})
		if pd:
			frappe.throw(_("Esta participação já tem o Processo Disciplinar <b>{0}</b> — a decisão é tomada lá.")
				.format(pd), title=_("Participação com Processo"))
		self.vigilante = p.vigilante
		infr = frappe.get_all("Participacao Infracao",
			filters={"parent": self.participacao, "parenttype": "Participacao"},
			pluck="tipo_de_infracao", order_by="idx")
		self.infracoes = ", ".join(infr) or p.tipo_de_infracao

	def after_insert(self):
		self._ligar(self.name)  # a draft already closes the participação to other actions

	def on_trash(self):
		self._ligar(None)

	def on_submit(self):
		self._ligar(self.name)
		self._criar_demissao()
		from sigos.timeline import registar
		registar(self.vigilante, _("<b>Denúncia</b> no período experimental — Demissão <b>{0}</b>").format(
			self.demissao or "-"), self)

	def before_cancel(self):
		if self.demissao and frappe.db.get_value("Demissao", self.demissao, "docstatus") == 1:
			frappe.throw(_("Cancele primeiro a Demissão <b>{0}</b>.").format(self.demissao))

	def on_cancel(self):
		self._ligar(None)
		from sigos.timeline import registar
		registar(self.vigilante, _("Denúncia <b>cancelada</b> ({0})").format(self.name), self)

	def _ligar(self, valor):
		if not self.participacao:
			return
		atual = frappe.db.get_value("Participacao", self.participacao, "denuncia")
		if valor or atual == self.name:
			frappe.db.set_value("Participacao", self.participacao, "denuncia", valor, update_modified=False)

	def _criar_demissao(self):
		dem = frappe.get_doc({
			"doctype": "Demissao",
			"data_de_demissao": self.data_de_demissao,
			"vigilante": self.vigilante,
			"mecanografico": self.mecanografico,
			"delegacao": self.delegacao,
			"motivo": "Denúncia",
			"uniforme": self.uniforme,
			"observacoes": _("Denúncia {0} (período experimental).").format(self.name)
				+ (" " + self.observacoes if self.observacoes else ""),
		})
		if dem.meta.has_field("workflow_state"):
			dem.workflow_state = "Aprovado"  # decided by the Jurista's denúncia — no second approval
		dem.flags.ignore_permissions = True
		dem.insert()
		dem.submit()
		self.db_set("demissao", dem.name)
		frappe.msgprint(_("Demissão {0} criada.").format(
			frappe.utils.get_link_to_form("Demissao", dem.name)), alert=True)
