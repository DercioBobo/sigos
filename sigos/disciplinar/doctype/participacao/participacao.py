import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import formatdate


class Participacao(Document):

	def validate(self):
		if not self.registado_por:
			self.registado_por = frappe.session.user

	def on_submit(self):
		self._registar_timeline(_("registada"))
		self._verificar_acumulacao_pd()

	def on_cancel(self):
		self._registar_timeline(_("cancelada"))

	# ─── Disciplinary process ────────────────────────────────────────────────────

	@frappe.whitelist()
	def criar_processo_disciplinar(self):
		"""Open a draft Processo Disciplinar pre-filled from this participação.
		Returns the (existing or new) process name so the UI can route to it."""
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
			"motivo": self.tipo_de_infracao,
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
			frappe.log_error(
				f"Participacao {self.name}: erro ao criar Processo Disciplinar automático: {e}",
				"SIGOS Participacao",
			)

	def _registar_timeline(self, accao):
		"""Log the participação on the involved guard's timeline."""
		if not self.vigilante:
			return
		from sigos.timeline import registar
		texto = _("Participação {0} — <b>{1}</b> ({2})").format(
			accao, self.tipo_de_infracao or _("(sem tipo)"), self.gravidade or "-"
		)
		if self.posto:
			texto += _(" · posto <b>{0}</b>").format(self.posto)
		if self.data:
			texto += _(" · {0}").format(formatdate(self.data))
		registar(self.vigilante, texto, self)
