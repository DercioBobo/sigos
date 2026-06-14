import json

import frappe
from frappe import _
from frappe.model.document import Document


class AlocacaoDeMaterial(Document):

	def validate(self):
		self._validar_alvo()
		self._validar_linhas()
		self._recalcular_estado()

	def on_submit(self):
		self._registar_timeline("alocado")

	def on_cancel(self):
		self._registar_timeline("cancelado")

	# ─── Target (Posto / Vigilante) ──────────────────────────────────────────────

	def _validar_alvo(self):
		"""
		The allocation goes to either a posto (shared kit) or a vigilante (personal
		kit). Keep only the relevant target, derive/validate the delegação from it.
		"""
		if self.alocar_a == "Posto":
			self.vigilante = None
			if not self.posto:
				frappe.throw(_("Indique o <b>Posto</b> de destino."), title=_("Posto Obrigatório"))
			alvo_deleg = frappe.db.get_value("Posto De Vigilancia", self.posto, "delegacao")
			rotulo = self.posto
		elif self.alocar_a == "Vigilante":
			self.posto = None
			if not self.vigilante:
				frappe.throw(_("Indique o <b>Vigilante</b> de destino."), title=_("Vigilante Obrigatório"))
			alvo_deleg = frappe.db.get_value("Vigilante", self.vigilante, "delegacao")
			rotulo = self.vigilante
		else:
			frappe.throw(_("Escolha se aloca a um <b>Posto</b> ou a um <b>Vigilante</b>."))

		if not alvo_deleg:
			return
		if not self.delegacao:
			self.delegacao = alvo_deleg
		elif self.delegacao != alvo_deleg:
			frappe.throw(
				_("<b>{0}</b> pertence à delegação <b>{1}</b>, mas a alocação está na "
				  "delegação <b>{2}</b>. Escolha um destino da mesma delegação.").format(
					rotulo, alvo_deleg, self.delegacao
				),
				title=_("Destino de Outra Delegação"),
			)

	# ─── Lines ───────────────────────────────────────────────────────────────────

	def _validar_linhas(self):
		if not self.material_a_alocar:
			frappe.throw(_("Adicione pelo menos um material a alocar."), title=_("Sem Material"))

		tipo_esperado = "Do Vigilante" if self.alocar_a == "Vigilante" else "Do Posto"
		for ln in self.material_a_alocar:
			if not ln.quantidade or ln.quantidade <= 0:
				frappe.throw(
					_("A quantidade do material <b>{0}</b> deve ser maior que zero.").format(
						ln.material or "-"
					),
					title=_("Quantidade Inválida"),
				)
			if (ln.qtd_devolvida or 0) > ln.quantidade:
				frappe.throw(
					_("Não se pode devolver mais do que o alocado em <b>{0}</b>.").format(ln.material),
					title=_("Devolução Inválida"),
				)
			# Material must match the chosen target (Do Posto vs Do Vigilante).
			if ln.material:
				tipo, retornavel = frappe.get_cached_value(
					"Material", ln.material, ["tipo_de_material", "retornavel"]
				)
				if tipo != tipo_esperado:
					frappe.throw(
						_("O material <b>{0}</b> é <b>{1}</b>, mas está a alocar a um <b>{2}</b>. "
						  "Escolha materiais compatíveis com o destino.").format(
							ln.material, tipo or _("(sem tipo)"),
							_("Vigilante") if self.alocar_a == "Vigilante" else _("Posto"),
						),
						title=_("Material Incompatível com o Destino"),
					)
				# Keep the line's returnable flag in sync with the catalog.
				ln.retornavel = 1 if retornavel else 0

	def _recalcular_estado(self):
		# Only returnable lines drive the return lifecycle. Consumables are issued and
		# gone, so an allocation with nothing returnable is simply "Entregue".
		total = sum((ln.quantidade or 0) for ln in self.material_a_alocar if ln.retornavel)
		devolvido = sum((ln.qtd_devolvida or 0) for ln in self.material_a_alocar if ln.retornavel)
		if total <= 0:
			self.estado = "Entregue"
		elif devolvido <= 0:
			self.estado = "Alocado"
		elif devolvido >= total:
			self.estado = "Devolvido"
		else:
			self.estado = "Devolvido Parcial"

	# ─── Returns ─────────────────────────────────────────────────────────────────

	@frappe.whitelist()
	def registar_devolucao(self, devolucoes):
		"""Record returned quantities per line, recompute the estado, and (for a
		vigilante allocation) log the return on the guard's timeline."""
		if self.docstatus != 1:
			frappe.throw(_("Só é possível devolver material de uma alocação submetida."))

		if isinstance(devolucoes, str):
			devolucoes = json.loads(devolucoes)
		mapa = {d.get("linha"): int(d.get("qtd") or 0) for d in devolucoes}

		algum = False
		devolvidos = []
		for ln in self.material_a_alocar:
			qtd = mapa.get(ln.name) or 0
			if qtd <= 0:
				continue
			if not ln.retornavel:
				frappe.throw(
					_("O material <b>{0}</b> não é retornável (consumível).").format(ln.material),
					title=_("Material Não Retornável"),
				)
			resta = (ln.quantidade or 0) - (ln.qtd_devolvida or 0)
			if qtd > resta:
				frappe.throw(
					_("Não pode devolver {0} de <b>{1}</b> — apenas {2} em posse.").format(
						qtd, ln.material, resta
					),
					title=_("Devolução Excede o Saldo"),
				)
			ln.qtd_devolvida = (ln.qtd_devolvida or 0) + qtd
			algum = True
			devolvidos.append((ln.material, qtd))

		if not algum:
			frappe.throw(_("Indique as quantidades a devolver."))

		self._recalcular_estado()
		self.save()

		if self.alocar_a == "Vigilante" and self.vigilante:
			from sigos.timeline import registar
			for material, qtd in devolvidos:
				registar(
					self.vigilante,
					_("Devolveu material — <b>{0}</b> x{1}").format(material, qtd),
					self,
				)
		self.add_comment("Info", _("Devolução de material registada — estado: {0}.").format(self.estado))
		return self.estado

	# ─── Timeline ────────────────────────────────────────────────────────────────

	def _registar_timeline(self, accao):
		"""Log issue/cancel on the recipient guard's timeline (vigilante allocations only)."""
		if self.alocar_a != "Vigilante" or not self.vigilante:
			return

		from sigos.timeline import registar
		for ln in self.material_a_alocar:
			if accao == "alocado":
				texto = _("Recebeu material — <b>{0}</b> x{1}").format(ln.material, ln.quantidade or 0)
			else:
				texto = _("Alocação de material cancelada — <b>{0}</b>").format(ln.material)
			registar(self.vigilante, texto, self)
