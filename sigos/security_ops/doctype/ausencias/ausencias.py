import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime
from sigos.utils import calcular_n_faltas_efetivo


class Ausencias(Document):

	def autoname(self):
		# One sheet per shift per grupo: "Noite-2026-06-10-Sofala-Chimoio-Tete".
		# The unique name blocks a duplicate sheet at insert; _validar_unicidade is
		# the friendlier belt-and-suspenders. (Amended docs are named by Frappe as
		# <original>-1 before this runs.)
		if not (self.data and self.periodo and self.grupo_delegados):
			frappe.throw(
				_("Defina <b>Data</b>, <b>Período</b> e <b>Grupo De Delegados</b> antes de gravar.")
			)
		self.name = f"{self.periodo}-{self.data}-{self.grupo_delegados}"

	def validate(self):
		self._validar_campos_imutaveis()
		self._validar_unicidade()
		self._validar_grupo_delegacao()
		self._validar_duplicados_na_tabela()
		self._validar_tipo_ausencia()
		self._validar_proxima_accao()
		self._validar_estado_substitutos()
		self._validar_conflitos_de_substituicao()
		self._calcular_n_faltas_todas_linhas()

	def before_save(self):
		self._validar_vigilante_em_outro_doc()
		self._verificar_hora_limite()

	def on_submit(self):
		# This absence may make the guard's NEXT working shift qualify for de-dup —
		# recompute its stored n_de_faltas if that shift is already recorded.
		self._recalcular_turno_seguinte()
		self._registar_timeline(cancelada=False)

	def on_cancel(self):
		# Cancelling removes this absence — the next shift may no longer de-dup.
		self._recalcular_turno_seguinte()
		self._registar_timeline(cancelada=True)

	def _registar_timeline(self, cancelada: bool):
		"""Vigilante timeline: one entry per absent guard, one per covering guard."""
		from sigos.timeline import registar
		from frappe.utils import formatdate

		quando = f"{self.periodo or ''} · {formatdate(self.data)}".strip(" ·")
		campo_accao = {
			"Substituto": "vigilante_substituto",
			"Dobra de Turno": "vigilante_a_dobrar",
			"Adiantamento de Turno": "vigilante_a_adiantar",
		}
		for row in self.tabela_ausencia or []:
			if not row.vigilante:
				continue
			if cancelada:
				registar(row.vigilante, _("Ausência <b>cancelada</b> — {0}").format(quando), self)
			else:
				texto = _("Falta registada — {0} · conta <b>{1}</b> falta(s)").format(
					quando, row.n_de_faltas or 1)
				if row.tipo_justificacao:
					texto += _(" · justificação: <b>{0}</b>").format(row.tipo_justificacao)
				registar(row.vigilante, texto, self)

			cobre = row.get(campo_accao.get(row.proxima_accao) or "")
			if cobre:
				if cancelada:
					registar(cobre, _("Cobertura de ausência <b>cancelada</b> — {0}").format(quando), self)
				else:
					registar(cobre, _("Cobriu a ausência de <b>{0}</b> ({1}) — {2}").format(
						row.nome_do_vigilante or row.vigilante, row.proxima_accao, quando), self)

	# ─── Validation ────────────────────────────────────────────────────────────

	def _validar_campos_imutaveis(self):
		"""data/periodo/grupo are the doc's identity (they ARE the name) — locked after
		creation. A wrong sheet is cancelled and redone, never re-dated."""
		if self.is_new():
			return
		antes = self.get_doc_before_save()
		if not antes:
			return
		for campo, label in (
			("data", "Data"), ("periodo", "Período"), ("grupo_delegados", "Grupo De Delegados"),
		):
			valor_antes = str(antes.get(campo) or "")
			# fill-once: legacy drafts may have the field empty — allow setting it
			if valor_antes and str(self.get(campo) or "") != valor_antes:
				frappe.throw(
					_("O campo <b>{0}</b> não pode ser alterado depois da criação — "
					  "cancele esta folha e crie uma nova.").format(label),
					title=_("Campo Bloqueado"),
				)

	def _validar_unicidade(self):
		existe = frappe.db.exists("Ausencias", {
			"data": self.data,
			"periodo": self.periodo,
			"grupo_delegados": self.grupo_delegados,
			"docstatus": ["<", 2],
			"name": ["!=", self.name],
		})
		if existe:
			frappe.throw(
				_("Já existe a folha <b>{0}</b> para este dia, período e grupo.").format(existe),
				title=_("Folha Duplicada"),
			)

	def _validar_grupo_delegacao(self):
		"""Every guard on the sheet must belong to a delegação of the doc's grupo —
		hard server-side fence so one grupo can never register another grupo's guards
		(the deck roster is already scoped, this closes the API/manual path)."""
		if not self.grupo_delegados:
			return
		delegacoes = set(frappe.get_all(
			"Grupo Delegados Item",
			filters={"parent": self.grupo_delegados},
			pluck="delegacao",
		))
		if not delegacoes:
			return  # grupo not configured yet — don't lock everyone out
		for i, row in enumerate(self.tabela_ausencia or [], start=1):
			if not row.vigilante:
				continue
			deleg = frappe.db.get_value("Vigilante", row.vigilante, "delegacao")
			if deleg not in delegacoes:
				frappe.throw(
					_("Linha {0}: o vigilante <b>{1}</b> pertence à delegação <b>{2}</b>, "
					  "que não faz parte do grupo <b>{3}</b>.").format(
						i, row.nome_do_vigilante or row.vigilante,
						deleg or _("sem delegação"), self.grupo_delegados,
					),
					title=_("Vigilante Fora do Grupo"),
				)

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

	def _validar_estado_substitutos(self):
		"""Substitutos must be benched reserve guards (status = Reserva). Reserva is an
		ESTADO — an available guard, not a categoria."""
		for i, row in enumerate(self.tabela_ausencia or [], start=1):
			if not row.vigilante_substituto:
				continue
			estado = frappe.db.get_value("Vigilante", row.vigilante_substituto, "status")
			if estado != "Reserva":
				frappe.throw(
					_(
						"Linha {0}: o vigilante substituto <b>{1}</b> não está em "
						"<b>Reserva</b> (estado actual: <b>{2}</b>). Apenas vigilantes "
						"em Reserva podem cobrir ausências."
					).format(
						i,
						row.vigilante_substituto,
						estado or _("sem estado"),
					),
					title=_("Substituto Indisponível"),
				)

	def _validar_conflitos_de_substituicao(self):
		"""A guard cannot be absent AND covering an absence on the same day.
		Checks both directions: within this doc, and against SUBMITTED docs of the
		same date (the pickers filter most of this out, this is the hard fence)."""
		campos = ("vigilante_substituto", "vigilante_a_dobrar", "vigilante_a_adiantar")
		rows = self.tabela_ausencia or []
		ausentes = {r.vigilante for r in rows if r.vigilante}
		cobrem = {r.get(c) for r in rows for c in campos if r.get(c)}

		# 1) same document, both directions at once
		conflito = ausentes & cobrem
		if conflito:
			frappe.throw(
				_("O vigilante <b>{0}</b> está simultaneamente marcado como ausente e "
				  "escolhido para cobrir uma ausência neste documento.").format(
					", ".join(sorted(conflito))
				),
				title=_("Conflito de Substituição"),
			)

		if not self.data:
			return

		# 2) replacements chosen here must not be absent (submitted) on this date
		if cobrem:
			ocupados = frappe.db.sql(
				"""
				SELECT DISTINCT ta.vigilante, a.name AS doc
				FROM `tabTabela Ausencia` ta
				JOIN `tabAusencias` a ON a.name = ta.parent
				WHERE a.docstatus = 1 AND a.data = %(d)s AND a.name != %(eu)s
				  AND ta.vigilante IN %(cobrem)s
				""",
				{"d": self.data, "eu": self.name or "", "cobrem": tuple(cobrem)},
				as_dict=True,
			)
			if ocupados:
				frappe.throw(
					_("Não podem cobrir ausências — já estão marcados como AUSENTES neste dia: {0}.").format(
						", ".join(f"<b>{o.vigilante}</b> ({o.doc})" for o in ocupados)
					),
					title=_("Conflito de Substituição"),
				)

		# 3) guards marked absent here must not be covering an absence elsewhere
		if ausentes:
			cobrindo = frappe.db.sql(
				f"""
				SELECT a.name AS doc,
				       ta.vigilante_substituto, ta.vigilante_a_dobrar, ta.vigilante_a_adiantar
				FROM `tabTabela Ausencia` ta
				JOIN `tabAusencias` a ON a.name = ta.parent
				WHERE a.docstatus = 1 AND a.data = %(d)s AND a.name != %(eu)s
				  AND (ta.vigilante_substituto IN %(aus)s
				       OR ta.vigilante_a_dobrar IN %(aus)s
				       OR ta.vigilante_a_adiantar IN %(aus)s)
				""",
				{"d": self.data, "eu": self.name or "", "aus": tuple(ausentes)},
				as_dict=True,
			)
			if cobrindo:
				pares = []
				for c in cobrindo:
					for campo in campos:
						if c.get(campo) in ausentes:
							pares.append(f"<b>{c.get(campo)}</b> ({c.doc})")
				frappe.throw(
					_("Não podem ser marcados como ausentes — já estão a COBRIR uma ausência "
					  "neste dia: {0}.").format(", ".join(sorted(set(pares)))),
					title=_("Conflito de Substituição"),
				)

	def _validar_vigilante_em_outro_doc(self):
		if not (self.data and self.tabela_ausencia):
			return

		vigilantes = [r.vigilante for r in self.tabela_ausencia if r.vigilante]
		if not vigilantes:
			return

		# NOTE: deliberately NOT filtered by grupo_delegados — an absence is an absence,
		# regardless of which grupo's sheet recorded it (same guard, same data+periodo).
		outros = frappe.get_all(
			"Ausencias",
			filters={
				"data": self.data,
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

		limite_str = self._hora_limite()
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

	def _hora_limite(self):
		"""Cutoff for this periodo as an HH:MM:SS string. Time fields come back from
		the DB as datetime.timedelta — normalize so the string comparison works."""
		import datetime

		campo = {"Manhã": "hora_limite_manha", "Noite": "hora_limite_noite"}.get(self.periodo)
		if not campo:
			return None
		padrao = {"Manhã": "09:30:00", "Noite": "18:30:00"}[self.periodo]
		val = frappe.db.get_single_value("SIGOS Settings", campo) or padrao
		if isinstance(val, datetime.timedelta):
			total = int(val.total_seconds())
			return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"
		# strings may come without leading zero ("9:30:00") — re-pad for lexicographic compare
		partes = str(val).split(":")
		if len(partes) >= 2:
			h, m = int(partes[0]), int(partes[1])
			s = int(float(partes[2])) if len(partes) > 2 else 0
			return f"{h:02d}:{m:02d}:{s:02d}"
		return str(val)

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
