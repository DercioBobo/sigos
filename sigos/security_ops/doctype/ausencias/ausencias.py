import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime
from sigos.utils import calcular_n_faltas_efetivo


class Ausencias(Document):

	def validate(self):
		self._validar_duplicados_na_tabela()
		self._validar_tipo_ausencia()
		self._validar_proxima_accao()
		self._validar_categoria_substitutos()
		self._calcular_n_faltas_todas_linhas()

	def before_save(self):
		self._validar_vigilante_em_outro_doc()
		self._verificar_hora_limite()

	def on_submit(self):
		# This absence may make the guard's NEXT working shift qualify for de-dup —
		# recompute its stored n_de_faltas if that shift is already recorded.
		self._recalcular_turno_seguinte()

	def on_cancel(self):
		# Cancelling removes this absence — the next shift may no longer de-dup.
		self._recalcular_turno_seguinte()

	# ─── Validation ────────────────────────────────────────────────────────────

	def _validar_duplicados_na_tabela(self):
		vistos = set()
		for row in self.tabela_ausencia or []:
			if row.vigilante in vistos:
				frappe.throw(
					_("O vigilante <b>{0}</b> aparece mais de uma vez neste documento.").format(
						row.vigilante
					)
				)
			vistos.add(row.vigilante)

	def _validar_tipo_ausencia(self):
		for i, row in enumerate(self.tabela_ausencia or [], start=1):
			if not row.tipo_de_ausencia:
				frappe.throw(
					_("Linha {0}: o campo <b>Tipo de Ausência</b> é obrigatório.").format(i)
				)

	def _validar_proxima_accao(self):
		accao_campo = {
			"Substituto":        "vigilante_substituto",
			"Dobra de Turno":    "vigilante_a_dobrar",
			"Adiantamento de Turno": "vigilante_a_adiantar",
		}
		for i, row in enumerate(self.tabela_ausencia or [], start=1):
			campo = accao_campo.get(row.proxima_accao)
			if campo and not getattr(row, campo, None):
				label_map = {
					"vigilante_substituto": "Vigilante Substituto",
					"vigilante_a_dobrar":   "Vigilante a Dobrar",
					"vigilante_a_adiantar": "Vigilante a Adiantar",
				}
				frappe.throw(
					_("Linha {0}: acção <b>{1}</b> selecionada mas <b>{2}</b> não foi preenchido.").format(
						i, row.proxima_accao, label_map[campo]
					)
				)

	def _validar_categoria_substitutos(self):
		"""Substitutos must have a Categoria Vigilante with pode_ser_substituto = 1."""
		cats_validas = frappe.get_all(
			"Categoria Vigilante",
			filters={"pode_ser_substituto": 1},
			pluck="name",
		)
		if not cats_validas:
			return  # No categorias configured — skip validation

		for i, row in enumerate(self.tabela_ausencia or [], start=1):
			if not row.vigilante_substituto:
				continue
			cat = frappe.db.get_value("Vigilante", row.vigilante_substituto, "categoria")
			if cat not in cats_validas:
				frappe.throw(
					_(
						"Linha {0}: o vigilante substituto <b>{1}</b> tem categoria "
						"<b>{2}</b> que não está autorizada para substituição. "
						"Categorias permitidas: <b>{3}</b>."
					).format(
						i,
						row.vigilante_substituto,
						cat or _("sem categoria"),
						", ".join(cats_validas),
					),
					title=_("Categoria de Substituto Inválida"),
				)

	def _validar_vigilante_em_outro_doc(self):
		if not (self.data and self.tabela_ausencia):
			return

		vigilantes = [r.vigilante for r in self.tabela_ausencia if r.vigilante]
		if not vigilantes:
			return

		outros = frappe.get_all(
			"Ausencias",
			filters={
				"data": self.data,
				"grupo_delegados": self.grupo_delegados,
				"periodo": self.periodo,
				"name": ["!=", self.name],
				"docstatus": 1,
			},
			fields=["name"],
		)
		if not outros:
			return

		nomes_outros = [d.name for d in outros]
		conflitos = frappe.get_all(
			"Tabela Ausencia",
			filters={
				"parent": ["in", nomes_outros],
				"vigilante": ["in", vigilantes],
			},
			fields=["vigilante"],
		)
		if conflitos:
			nomes = ", ".join({c.vigilante for c in conflitos})
			frappe.throw(
				_("Já existe ausência registada para: <b>{0}</b> nesta data e período "
				  "em outro documento submetido.").format(nomes)
			)

	def _verificar_hora_limite(self):
		"""
		Block save if submission is late and no motivo_atraso was provided.
		The JS guides the user to fill motivo_atraso; this is the server enforcer.
		"""
		if self.motivo_atraso:
			if not self.hora_submissao_tardia:
				self.hora_submissao_tardia = now_datetime().strftime("%H:%M:%S")
			return

		limites = {
			"Manhã": frappe.db.get_single_value("SIGOS Settings", "hora_limite_manha") or "09:30:00",
			"Noite": frappe.db.get_single_value("SIGOS Settings", "hora_limite_noite") or "18:30:00",
		}
		limite_str = limites.get(self.periodo)
		if not limite_str:
			return

		agora = now_datetime().strftime("%H:%M:%S")
		if agora > limite_str:
			frappe.throw(
				_("Submissão fora do horário (<b>{0}</b>). Limite: <b>{1}</b>. "
				  "Preencha o campo <b>Motivo do Atraso</b> para continuar.").format(
					agora, limite_str
				),
				title=_("Submissão Tardia"),
			)

	# ─── Computed fields ───────────────────────────────────────────────────────

	def _calcular_n_faltas_todas_linhas(self):
		"""
		Stamp the EFFECTIVE n_de_faltas per row: base (Regime Turno Item) with the
		escala-aware de-dup — if the guard's previous working shift was also a submitted
		absence, this one counts 1. Cross-document, so it reads the other absences.
		"""
		for row in self.tabela_ausencia or []:
			row.n_de_faltas = calcular_n_faltas_efetivo(
				row.vigilante, row.regime, row.turno, self.data
			)

	def _recalcular_turno_seguinte(self):
		"""
		Keep the chain consistent when absences are entered/cancelled out of order:
		for each guard here, find their NEXT working shift; if it already has a submitted
		absence, recompute its stored n_de_faltas (it may now de-dup to 1, or revert).
		"""
		from sigos.utils import (
			_turno_seguinte_de_trabalho, calcular_n_faltas_efetivo, _regime_deduz_consecutivas,
		)

		for row in self.tabela_ausencia or []:
			if not row.vigilante:
				continue
			# Only regimes that opt into the de-dup can affect their next shift's count.
			if not _regime_deduz_consecutivas(row.regime):
				continue
			prox = _turno_seguinte_de_trabalho(row.vigilante, row.regime, self.data)
			if not prox:
				continue
			seg = frappe.db.sql(
				"""
				SELECT ta.name, ta.regime, ta.turno, ta.n_de_faltas
				FROM `tabTabela Ausencia` ta
				JOIN `tabAusencias` a ON a.name = ta.parent
				WHERE a.docstatus = 1 AND ta.vigilante = %(v)s AND a.data = %(d)s
				LIMIT 1
				""",
				{"v": row.vigilante, "d": prox},
				as_dict=True,
			)
			if not seg:
				continue
			novo = calcular_n_faltas_efetivo(row.vigilante, seg[0].regime, seg[0].turno, prox)
			if novo != (seg[0].n_de_faltas or 0):
				frappe.db.set_value("Tabela Ausencia", seg[0].name, "n_de_faltas", novo, update_modified=False)
