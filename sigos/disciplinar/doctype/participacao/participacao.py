import re

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import formatdate

_ORDEM_GRAVIDADE = {"Baixa": 1, "Média": 2, "Alta": 3}


class Participacao(Document):
	"""
	Participação — follows the paper form (XSS_OP.FR.006): O Participante (who
	reports), O Infractor (the guard), Tipo de Infracção (a checklist — one or more,
	`infracoes`), Relatório (posto, horas, data, reportagem) and the witnesses.
	`tipo_de_infracao` is kept as the PRINCIPAL infracção (the first one marked) for
	lists, reports and the Processo Disciplinar. Drafts may be incomplete (e.g. one
	opened from an Ocorrência); the form's required parts are enforced on submit.
	"""

	def validate(self):
		if not self.registado_por:
			self.registado_por = frappe.session.user
		self._sincronizar_infracoes()
		self._preencher_participante()
		self._preencher_testemunhas()
		self._normalizar_horas()

	def before_submit(self):
		if not self.infracoes:
			frappe.throw(_("Marque pelo menos um <b>Tipo de Infracção</b>."), title=_("Participação Incompleta"))
		if not (self.participante_nome or "").strip():
			frappe.throw(_("Indique <b>O Participante</b> (quem faz a participação)."),
				title=_("Participação Incompleta"))
		pedem = [
			r.tipo_de_infracao for r in self.infracoes
			if frappe.db.get_value("Tipo De Infracao", r.tipo_de_infracao, "pede_descricao")
		]
		if pedem and not (self.outras_descricao or "").strip():
			frappe.throw(_("Descreva a infracção <b>{0}</b>.").format(", ".join(pedem)),
				title=_("Participação Incompleta"))

	# ─── Form normalisation ──────────────────────────────────────────────────────

	def _sincronizar_infracoes(self):
		"""Checklist ↔ principal: an old/API record with only tipo_de_infracao gets it
		as its first row; duplicates are dropped; the principal is the first row;
		an empty gravidade takes the most serious suggested one."""
		if not self.infracoes and self.tipo_de_infracao:
			self.append("infracoes", {"tipo_de_infracao": self.tipo_de_infracao})
		vistos, linhas = set(), []
		for r in self.infracoes or []:
			if r.tipo_de_infracao and r.tipo_de_infracao not in vistos:
				vistos.add(r.tipo_de_infracao)
				linhas.append(r)
		self.set("infracoes", linhas)
		self.tipo_de_infracao = linhas[0].tipo_de_infracao if linhas else None
		if not self.gravidade and linhas:
			sugeridas = [
				frappe.db.get_value("Tipo De Infracao", r.tipo_de_infracao, "gravidade_sugerida")
				for r in linhas
			]
			sugeridas = [g for g in sugeridas if g in _ORDEM_GRAVIDADE]
			if sugeridas:
				self.gravidade = max(sugeridas, key=_ORDEM_GRAVIDADE.get)

	def _preencher_participante(self):
		if self.participante and self.participante == self.vigilante:
			frappe.throw(_("O participante não pode ser o próprio infractor."), title=_("Participante"))
		if self.participante:
			v = frappe.db.get_value(
				"Vigilante", self.participante, ["mecanografico", "categoria", "nome_completo"], as_dict=True
			) or {}
			self.participante_numero = self.participante_numero or v.get("mecanografico")
			self.participante_categoria = self.participante_categoria or v.get("categoria")
			self.participante_nome = self.participante_nome or v.get("nome_completo")

	def _preencher_testemunhas(self):
		"""Fill a witness from their Vigilante, drop blank rows, never the infractor."""
		linhas = []
		for r in self.tabela_testemunhas or []:
			if r.vigilante:
				if r.vigilante == self.vigilante:
					frappe.throw(_("O infractor não pode ser testemunha da própria participação."),
						title=_("Testemunhas"))
				v = frappe.db.get_value(
					"Vigilante", r.vigilante, ["mecanografico", "categoria", "nome_completo"], as_dict=True
				) or {}
				r.numero = r.numero or v.get("mecanografico")
				r.categoria = r.categoria or v.get("categoria")
				r.nome = r.nome or v.get("nome_completo")
			if (r.nome or "").strip() or r.vigilante:
				linhas.append(r)
		for i, r in enumerate(linhas, start=1):
			r.idx = i
		self.set("tabela_testemunhas", linhas)

	def _normalizar_horas(self):
		"""'14h30' / '14.30' / '9:5' → 'HH:MM' (the form's time picker sends HH:MM:SS)."""
		m = re.match(r"^\s*(\d{1,2})\s*[hH:.]\s*(\d{1,2})", self.horas or "")
		if m and int(m.group(1)) < 24 and int(m.group(2)) < 60:
			self.horas = f"{int(m.group(1)):02d}:{int(m.group(2)):02d}"

	def on_submit(self):
		self._registar_timeline(_("registada"))
		self._verificar_acumulacao_pd()

	def on_cancel(self):
		self._registar_timeline(_("cancelada"))

	# ─── Disciplinary process ────────────────────────────────────────────────────

	@frappe.whitelist()
	def criar_processo_disciplinar(self):
		"""Open a draft Processo Disciplinar pre-filled from this participação.
		Returns the (existing or new) process name so the UI can route to it.

		Only this manual entry point is gated — _abrir_processo (the shared insert
		helper) is also called by the automatic 3-strikes accumulation from
		on_submit, which must keep working regardless of the submitting user's own
		Processo Disciplinar permissions (it's a system-driven consequence of
		submitting a Participação, not a user action on the PD itself)."""
		frappe.has_permission("Processo Disciplinar", "create", throw=True)
		if self.docstatus != 1:
			frappe.throw(_("Submeta a participação antes de abrir um Processo Disciplinar."))

		existente = frappe.db.exists(
			"Processo Disciplinar", {"participacao_referente": self.name}
		)
		if existente:
			frappe.msgprint(
				_("Já existe o Processo Disciplinar {0} para esta participação.").format(existente),
				alert=True,
			)
			return existente

		processo = self._abrir_processo(_("Participação {0}").format(self.name))
		frappe.msgprint(
			_("Processo Disciplinar {0} criado a partir desta participação.").format(processo),
			indicator="blue", alert=True,
		)
		return processo

	def _abrir_processo(self, razao):
		"""Insert a draft Processo Disciplinar from this participação. `razao` is
		stamped on `automatico` (the audit trail of why the process opened). The PD
		is keyed only on the vigilante; the Employee is derived downstream when needed."""
		processo = frappe.get_doc({
			"doctype": "Processo Disciplinar",
			"data": self.data,
			"delegacao": self.delegacao,
			"vigilante": self.vigilante,
			"gravidade": self.gravidade,
			"motivo": ", ".join(r.tipo_de_infracao for r in self.infracoes) or self.tipo_de_infracao,
			"detalhes": self.relato,
			"participacao_referente": self.name,
			"automatico": razao,
		})
		processo.insert(ignore_permissions=True)
		return processo.name

	def _verificar_acumulacao_pd(self):
		"""Three-strikes rule: enough submitted participações for this guard auto-opens
		a Processo Disciplinar. Same tiered thresholds as before (SIGOS Settings), now
		that the participação IS the official warning. Counts by `vigilante` (the ops
		side of the bridge — participação has no funcionario field of its own)."""
		if not self.vigilante:
			return

		# Opt-out: the whole count + auto-open behaviour is toggled in SIGOS Settings.
		# Off → PDs are created only manually (the "Abrir Processo Disciplinar" button).
		if not frappe.db.get_single_value("SIGOS Settings", "acumulacao_pd_activa"):
			return

		# Skip if a process already traces back to this very participação (manual button
		# or a prior run) so we never double-open for the same record.
		if frappe.db.exists("Processo Disciplinar", {"participacao_referente": self.name}):
			return

		# Reset point: opening any disciplinary process wipes the warning slate, so only
		# participações filed AFTER the guard's most recent PD count toward the next one.
		# A guard already over the limit therefore doesn't spawn a PD on every later
		# participação — the counter restarts each time a process opens.
		desde = frappe.db.get_value(
			"Processo Disciplinar",
			{"vigilante": self.vigilante},
			"creation",
			order_by="creation desc",
		)

		def _contar(gravidade):
			filtros = {"vigilante": self.vigilante, "gravidade": gravidade, "docstatus": 1}
			if desde:
				filtros["creation"] = [">", desde]
			return frappe.db.count("Participacao", filtros)

		part_baixa = _contar("Baixa")
		part_media = _contar("Média")
		part_alta = _contar("Alta")

		limite_baixa = frappe.db.get_single_value("SIGOS Settings", "reprimendas_baixa_pd") or 3
		limite_media = frappe.db.get_single_value("SIGOS Settings", "reprimendas_media_pd") or 2
		limite_alta = frappe.db.get_single_value("SIGOS Settings", "reprimendas_alta_pd") or 1

		razao = None
		if part_alta >= limite_alta:
			razao = _("Uma Participação Alta (total: {0})").format(part_alta)
		elif part_media >= limite_media:
			razao = _("{0} ou mais Participações Médias (total: {1})").format(limite_media, part_media)
		elif part_baixa >= limite_baixa:
			razao = _("{0} ou mais Participações Baixas (total: {1})").format(limite_baixa, part_baixa)

		if not razao:
			return

		try:
			processo = self._abrir_processo(razao)
			frappe.msgprint(
				_("Processo Disciplinar {0} criado automaticamente. Razão: {1}").format(processo, razao),
				indicator="orange", alert=True,
			)
		except Exception as e:
			# Deliberately NOT re-raised: the Participação being submitted right now
			# is the actual misconduct report and must go through regardless of
			# whether the accumulation trigger succeeds — failing the whole
			# submission over a secondary auto-open would lose the primary record
			# too. But this is the real accountability mechanism (a guard's 3rd
			# strike), so a log entry alone is not enough — it must be a loud,
			# hard-to-dismiss warning, not a quiet alert.
			frappe.log_error(
				f"Participacao {self.name}: erro ao criar Processo Disciplinar automático: {e}",
				"SIGOS Participacao",
			)
			frappe.msgprint(
				_("<b>Atenção:</b> esta participação atingiu o limite de acumulação ({0}), mas o "
				  "Processo Disciplinar automático <b>falhou</b> ao ser criado. Abra-o manualmente "
				  "com o botão \"Abrir Processo Disciplinar\".").format(razao),
				title=_("Processo Disciplinar Automático Falhou"),
				indicator="red",
			)

	def _registar_timeline(self, accao):
		"""Log the participação on the involved guard's timeline."""
		if not self.vigilante:
			return
		from sigos.timeline import registar
		infracoes = ", ".join(r.tipo_de_infracao for r in self.infracoes or []) or self.tipo_de_infracao
		texto = _("Participação {0} — <b>{1}</b> ({2})").format(
			accao, infracoes or _("(sem tipo)"), self.gravidade or "-"
		)
		if self.posto:
			texto += _(" · posto <b>{0}</b>").format(self.posto)
		if self.data:
			texto += _(" · {0}").format(formatdate(self.data))
		registar(self.vigilante, texto, self)


@frappe.whitelist()
def participante_padrao():
	"""The current user as the default participante: their Vigilante (via the
	Employee linked to the user) when there is one, else just their name."""
	user = frappe.session.user
	emp = frappe.db.get_value(
		"Employee", {"user_id": user, "status": "Active"},
		["name", "employee_name", "custom_vigilante", "designation"], as_dict=True,
	)
	if emp and emp.custom_vigilante:
		v = frappe.db.get_value(
			"Vigilante", emp.custom_vigilante, ["name", "mecanografico", "categoria", "nome_completo"],
			as_dict=True,
		)
		if v:
			return {"participante": v.name, "participante_numero": v.mecanografico,
				"participante_categoria": v.categoria, "participante_nome": v.nome_completo}
	if emp:
		return {"participante_numero": emp.name, "participante_categoria": emp.designation,
			"participante_nome": emp.employee_name}
	return {"participante_nome": frappe.db.get_value("User", user, "full_name")}

