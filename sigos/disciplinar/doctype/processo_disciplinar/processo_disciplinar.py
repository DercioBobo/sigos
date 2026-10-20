import frappe
from frappe import _
from frappe.model.document import Document


class ProcessoDisciplinar(Document):

	def validate(self):
		self._preencher_da_origem()
		self._validar_prazo()
		if self.docstatus == 0:
			from sigos.disciplinar.tramitacao import actualizar_estado
			actualizar_estado(self)

	def before_submit(self):
		from sigos.disciplinar.tramitacao import D_MULTA, validar_decisao

		validar_decisao(self)
		if self.decisao == D_MULTA:
			# Outras Deduções (on_update) take the multa as the amount to deduct
			self.valor_a_pagar = self.multa_valor
			self.meses_a_pagar = self.meses_a_pagar or 1
		self.fase = "Concluído"

	# ─── Tramitação (sigos.disciplinar.tramitacao) ──────────────────────────────

	@frappe.whitelist()
	def registar_defesa(self, texto=None, anexo=None, data=None):
		from sigos.disciplinar.tramitacao import registar_defesa
		registar_defesa(self, texto, anexo, data)
		return self.fase

	@frappe.whitelist()
	def pedir_diligencias(self, descricao=None, data=None):
		from sigos.disciplinar.tramitacao import pedir_diligencias
		pedir_diligencias(self, descricao, data)
		return self.fase

	@frappe.whitelist()
	def concluir_diligencias(self, resultado=None, data=None):
		from sigos.disciplinar.tramitacao import concluir_diligencias
		concluir_diligencias(self, resultado, data)
		return self.fase

	def _validar_prazo(self):
		"""A process from a Participação (directly or through a Repreensão) must be
		opened within the deadline counted from the Data de Conhecimento da Infracção
		(sigos.disciplinar.prazos). Checked when it's opened — or when an existing
		draft is first linked to a participação. The Presunção de Abandono has none."""
		from sigos.disciplinar.prazos import exigir, prazo_processo

		if not self.participacao_referente:
			return
		antes = self.get_doc_before_save()
		if not (self.is_new() or (antes and antes.participacao_referente != self.participacao_referente)):
			return
		conhecimento = frappe.db.get_value(
			"Participacao", self.participacao_referente, "data_conhecimento_infracao")
		e = exigir(self, conhecimento, prazo_processo(), _("o Processo Disciplinar tem de ser aberto"))
		if e:
			self.prazo_processo_ate = e["limite"]

	def _preencher_da_origem(self):
		"""Snapshot everything relevant from the document(s) that originated the
		process — so the Jurista never has to go back to them. Only EMPTY fields are
		filled: whatever the Jurista corrected stays."""
		def por(campo, valor):
			if valor not in (None, "") and not self.get(campo):
				self.set(campo, valor)

		if self.repreensao_referente and not self.participacao_referente:
			self.participacao_referente = frappe.db.get_value(
				"Repreensao", self.repreensao_referente, "participacao")
		por("origem", "Repreensão" if self.repreensao_referente
			else "Participação" if self.participacao_referente
			else "Presunção de Abandono" if self.presuncao_referente else "Manual")

		if self.participacao_referente:
			p = frappe.get_doc("Participacao", self.participacao_referente)
			infr = ", ".join(r.tipo_de_infracao for r in p.infracoes or []) or p.tipo_de_infracao
			por("data_ocorrencia", p.data)
			por("hora_ocorrencia", p.horas)
			por("data_conhecimento_infracao", p.data_conhecimento_infracao)
			por("posto_ocorrencia", p.posto)
			por("participante", " · ".join(x for x in (
				p.participante_nome, p.participante_numero and _("Nº {0}").format(p.participante_numero),
				p.participante_categoria) if x))
			por("infracoes", infr)
			por("outras_descricao", p.outras_descricao)
			por("testemunhas", "\n".join(
				" · ".join(x for x in (t.nome, t.numero and _("Nº {0}").format(t.numero), t.categoria) if x)
				for t in p.tabela_testemunhas or []) or p.testemunhas)
			por("motivo", infr)
			por("detalhes", p.relato)
			por("gravidade", p.gravidade)
		elif self.presuncao_referente:
			pr = frappe.get_doc("Presuncao De Abandono", self.presuncao_referente)
			por("data_ocorrencia", pr.primeira_falta)
			por("data_conhecimento_infracao", pr.data_conhecimento_infracao)
			por("posto_ocorrencia", pr.posto_de_vigilancia)
			por("infracoes", _("Abandono de Posto — ausente desde {0}: {1} dia(s) com falta, {2} falta(s)").format(
				frappe.utils.formatdate(pr.primeira_falta), pr.total_dias or 0, pr.total_faltas or 0))
			por("motivo", _("Abandono de Posto"))
			por("gravidade", "Alta")

	def after_insert(self):
		# Fires the moment an investigation opens (draft, before any decisão is
		# known) — the posto needs covering immediately, not only once the
		# process is eventually submitted/approved.
		self._criar_cobertura_se_necessario()
		self._ligar_participacao(self.name)

	def on_cancel(self):
		self._cancelar_cobertura_se_existir()
		self._ligar_participacao(None)

	def on_trash(self):
		self._ligar_participacao(None)

	def _ligar_participacao(self, valor):
		"""Participação.processo_disciplinar mirrors the live (non-cancelled) process
		opened from it — what the Jurista filters on ("Sem Processo")."""
		if not self.participacao_referente:
			return
		atual = frappe.db.get_value("Participacao", self.participacao_referente, "processo_disciplinar")
		if valor or atual == self.name:
			frappe.db.set_value("Participacao", self.participacao_referente, "processo_disciplinar", valor,
				update_modified=False)

	def on_update(self):
		# docstatus == 1 (not just workflow_state) is the real gate: on_update fires
		# on EVERY save, including drafts. Without this, a site where the Workflow
		# isn't provisioned yet (workflow_state missing → falls back to "Aprovado")
		# would create and submit a real payroll deduction from a mere draft save.
		if self.docstatus != 1:
			return
		if (self.get("workflow_state") or "Aprovado") != "Aprovado":
			return

		if self.decisao in ("Multa", "Dedução"):  # "Dedução" = pre-2026-10 records
			self._criar_deducao()

	def on_submit(self):
		decisao = (self.decisao or "").strip()

		if decisao == "Retenção De Salário":  # pre-2026-10 records only
			self._aplicar_retencao_salario()

		elif decisao in ("Despedimento", "Demissão"):
			self._criar_demissao()

		elif decisao == "Despromoção":
			if (self.get("workflow_state") or "Aprovado") == "Aprovado":
				from sigos.disciplinar.tramitacao import aplicar_despromocao
				aplicar_despromocao(self)  # today, or by the daily job on the start day

		from sigos.timeline import registar
		registar(self.vigilante, _("Processo Disciplinar <b>{0}</b> decidido: <b>{1}</b>").format(
			self.name, decisao or "-"), self)

	# ─── Private helpers ──────────────────────────────────────────────────────

	def _criar_cobertura_se_necessario(self):
		"""Auto-create a Cobertura De Posto in 'Por Atribuir' so ops just has to
		pick a Cobridor — skipped when the guard has no real posto/regime to
		cover, or a Cobertura already exists for this process (idempotent)."""
		if frappe.db.exists("Cobertura De Posto", {"processo_disciplinar": self.name}):
			return

		posto, regime = frappe.db.get_value(
			"Vigilante", self.vigilante, ["posto_de_vigilancia", "regime_do_vigilante"]
		) or (None, None)
		if not (posto and regime):
			return

		cob = frappe.get_doc({
			"doctype": "Cobertura De Posto",
			"vigilante_coberto": self.vigilante,
			"tipo_cobertura": "Suspensão/Investigação",
			"processo_disciplinar": self.name,
			"data_inicio_prevista": self.data,
			"estado": "Por Atribuir",
		})
		cob.insert(ignore_permissions=True)
		frappe.msgprint(
			_("Cobertura de Posto <b>{0}</b> criada — atribua um Cobridor quando tiver um "
			  "disponível.").format(cob.name),
			indicator="blue", alert=True,
		)

	def _cancelar_cobertura_se_existir(self):
		"""If cancelling this Processo Disciplinar after a Cobertura (possibly
		already Activa, with a Cobridor deployed) was created for it, cancel/
		revert it too — otherwise a cancelled process leaves a Cobridor
		permanently mis-deployed with no linked case."""
		nome = frappe.db.exists("Cobertura De Posto", {"processo_disciplinar": self.name})
		if not nome:
			return
		cob = frappe.get_doc("Cobertura De Posto", nome)
		if cob.estado in ("Concluída", "Cancelada", "Efectivada"):
			return
		cob.cancelar(motivo=_("Processo Disciplinar de origem foi cancelado."))

	def _criar_deducao(self):
		"""Create an Outras Deducoes record linked to this Processo Disciplinar."""
		# Avoid duplicates
		existing = frappe.db.exists(
			"Outras Deducoes",
			{"processo_disciplinar": self.name}
		)
		if existing:
			return

		try:
			componente = frappe.db.get_single_value(
				"SIGOS Settings", "componente_processo_disciplinar"
			) or "Processo Disciplinar"
			# Outras Deducoes is keyed on the Employee — derive it from the vigilante.
			funcionario = frappe.db.get_value("Vigilante", self.vigilante, "funcionario")
			deducao = frappe.get_doc({
				"doctype": "Outras Deducoes",
				"tipo": componente,
				"estado": "Activo",
				"funcionario": funcionario,
				"valor_a_pagar": self.valor_a_pagar,
				"meses_a_pagar": self.meses_a_pagar,
				"mes_referencia": self.mes_referencia,
				"data_de_inicio": self.data_de_inicio,
				"descricao": self.descricao,
				"termo_de_responsabilidade": self.termo_de_responsabilidade,
				"processo_disciplinar": self.name
			})
			deducao.insert(ignore_permissions=True)
			deducao.submit()
			frappe.msgprint(
				_("Dedução {0} criada automaticamente.").format(deducao.name),
				alert=True
			)
		except Exception as e:
			frappe.log_error(
				f"ProcessoDisciplinar {self.name}: erro ao criar Outras Deducoes: {e}",
				"SIGOS Processo Disciplinar"
			)
			raise

	def _aplicar_retencao_salario(self):
		"""Suspend Employee and deactivate Vigilante."""
		try:
			if self.vigilante:
				vig = frappe.get_doc("Vigilante", self.vigilante)
				vig.status = "Inactivo"
				vig.save(ignore_permissions=True)

				# Employee is derived from the vigilante (no funcionario field on the PD).
				if vig.funcionario:
					emp = frappe.get_doc("Employee", vig.funcionario)
					emp.status = "Suspended"
					emp.save(ignore_permissions=True)
		except Exception as e:
			frappe.log_error(
				f"ProcessoDisciplinar {self.name}: erro ao aplicar Retenção de Salário: {e}",
				"SIGOS Processo Disciplinar"
			)
			raise

	def _criar_demissao(self):
		"""Create and submit a Demissao document."""
		try:
			existing = frappe.db.exists(
				"Demissao",
				{"vigilante": self.vigilante, "docstatus": 1}
			)
			if existing:
				frappe.msgprint(
					_("Já existe uma Demissão submetida para o vigilante {0}.").format(self.vigilante),
					alert=True
				)
				return

			demissao_doc = frappe.get_doc({
				"doctype": "Demissao",
				# the decision day (this process is being submitted now) — not the day it
				# was opened nor the day of the infraction
				"data_de_demissao": frappe.utils.today(),
				"vigilante": self.vigilante,
				"mecanografico": self.mecanografico,
				"delegacao": self.delegacao,
				"motivo": "Disciplinar",
				"uniforme": self.uniforme
			})
			demissao_doc.insert(ignore_permissions=True)
			demissao_doc.submit()
			frappe.msgprint(
				_("Demissão {0} criada automaticamente para {1}.").format(
					demissao_doc.name, self.vigilante
				),
				alert=True
			)
		except Exception as e:
			frappe.log_error(
				f"ProcessoDisciplinar {self.name}: erro ao criar Demissao: {e}",
				"SIGOS Processo Disciplinar"
			)
			raise
