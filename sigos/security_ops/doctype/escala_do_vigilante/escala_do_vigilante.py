import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate, nowdate, add_days, add_months, get_first_day, get_last_day


class EscalaDoVigilante(Document):

	def validate(self):
		self._validar_um_por_posto()
		self._validar_um_por_delegacao()
		self._sincronizar_turno_por_equipa()
		self._validar_turnos()
		self._validar_capacidade_posto()
		self._auto_arquivar_se_vazia()   # before reconcile — skips generation when empty
		self.reconciliar_escala()

	# ─── Validation ────────────────────────────────────────────────────────────

	def _auto_arquivar_se_vazia(self):
		"""
		Auto-archive an active escala when its LAST guard leaves (guard list goes
		from non-empty to empty). Applies to every flow that removes guards
		(Troca De Regime, Demissão, Rotatividade, manual). A brand-new empty
		Rascunho is untouched — we only archive a transition to empty.
		"""
		if self.estado != "Activo":
			return
		if self.tab_vigilante_do_posto:
			return  # still has guards
		before = self.get_doc_before_save()
		if before and before.tab_vigilante_do_posto:
			self.estado = "Arquivado"
			frappe.msgprint(
				_("Escala <b>{0}</b> arquivada automaticamente — o último vigilante saiu.").format(
					self.name
				),
				indicator="orange",
				alert=True,
			)

	def _validar_um_por_posto(self):
		"""Only one Escala per (posto, regime)."""
		if not (self.posto_de_vigilancia and self.regime_do_vigilante):
			return
		existing = frappe.db.get_value(
			"Escala Do Vigilante",
			{
				"posto_de_vigilancia": self.posto_de_vigilancia,
				"regime_do_vigilante": self.regime_do_vigilante,
				"name": ["!=", self.name or ""],
			},
			"name",
		)
		if existing:
			frappe.throw(
				_("Já existe uma escala para o posto <b>{0}</b> no regime <b>{1}</b>: "
				  "<a href='/app/escala-do-vigilante/{2}'>{2}</a>. "
				  "Cada combinação posto + regime tem uma única escala.").format(
					self.posto_de_vigilancia, self.regime_do_vigilante, existing
				),
				title=_("Escala Duplicada"),
			)

	def _validar_um_por_delegacao(self):
		"""Only one Escala de Reserva per (delegação, regime) — the tipo_de_escala
		== "Reserva" counterpart of _validar_um_por_posto, keyed by delegação
		instead of posto since this escala has no posto at all."""
		if self.tipo_de_escala != "Reserva" or not (self.delegacao and self.regime_do_vigilante):
			return
		existing = frappe.db.get_value(
			"Escala Do Vigilante",
			{
				"tipo_de_escala": "Reserva",
				"delegacao": self.delegacao,
				"regime_do_vigilante": self.regime_do_vigilante,
				"name": ["!=", self.name or ""],
			},
			"name",
		)
		if existing:
			frappe.throw(
				_("Já existe uma escala de Reserva para a delegação <b>{0}</b> no regime <b>{1}</b>: "
				  "<a href='/app/escala-do-vigilante/{2}'>{2}</a>. "
				  "Cada combinação delegação + regime tem uma única escala de Reserva.").format(
					self.delegacao, self.regime_do_vigilante, existing
				),
				title=_("Escala de Reserva Duplicada"),
			)

	def _sincronizar_turno_por_equipa(self):
		"""
		Customer-specific team rostering (SIGOS Settings.turno_equipa_activo): guards
		sharing a turno_equipa (Equipa A/B/C...) must always share the same turno_inicial
		— editing one member's anchor via the native grid, the bulk dialog, the sync
		button, or the API all funnel through here, so it can't be bypassed. Rows without
		turno_equipa are untouched — non-team customers see no behaviour change.
		"""
		if not self.tab_vigilante_do_posto:
			return

		before = self.get_doc_before_save()
		antes_por_nome = {g.name: g.turno_inicial for g in before.tab_vigilante_do_posto} if before else {}

		grupos = {}
		for row in self.tab_vigilante_do_posto:
			if not row.turno_equipa:
				continue
			grupos.setdefault(row.turno_equipa, []).append(row)

		for rows in grupos.values():
			valores = {r.turno_inicial for r in rows if r.turno_inicial}
			if len(valores) <= 1:
				continue  # already consistent (or all empty)

			# Whichever row's turno_inicial actually changed this save is the guard the
			# user just edited — their choice wins for the whole team.
			canonico = next(
				(r.turno_inicial for r in rows
				 if r.turno_inicial and antes_por_nome.get(r.name) != r.turno_inicial),
				None,
			)
			if not canonico:
				canonico = next(r.turno_inicial for r in rows if r.turno_inicial)

			for r in rows:
				r.turno_inicial = canonico

	def _validar_turnos(self):
		if not self.regime_do_vigilante:
			return
		try:
			regime_doc = frappe.get_doc("Regime", self.regime_do_vigilante)
		except frappe.DoesNotExistError:
			frappe.throw(_("Regime '{0}' não encontrado.").format(self.regime_do_vigilante))
			return

		validos = {r.turno for r in regime_doc.turnos}
		for i, row in enumerate(self.tab_vigilante_do_posto or [], start=1):
			if row.turno_inicial and row.turno_inicial not in validos:
				frappe.throw(
					_("Linha {0}: turno inicial '<b>{1}</b>' não existe no Regime <b>{2}</b>. "
					  "Turnos válidos: {3}").format(
						i, row.turno_inicial, self.regime_do_vigilante, ", ".join(sorted(validos))
					)
				)

	def _validar_capacidade_posto(self):
		if not self.posto_de_vigilancia:
			return
		max_vagas = frappe.db.get_value(
			"Posto De Vigilancia", self.posto_de_vigilancia, "numero_de_vagas"
		) or 0
		if not max_vagas:
			return
		nomes = {r.vigilante for r in self.tab_vigilante_do_posto if r.vigilante}
		if not nomes:
			return
		# Active Cobridor shadows co-locate with the colleague they're covering —
		# not a real second headcount (see escala_do_vigilante.deployar_cobridor).
		# Query-based (not a one-time flag) so it stays correct on every future
		# save of this escala, not just the deployment moment.
		sombras = set(frappe.get_all(
			"Vigilante",
			filters={"name": ["in", list(nomes)], "cobertura_de_posto_activa": ["is", "set"]},
			pluck="name",
		))
		n = len(nomes - sombras)
		if n > max_vagas:
			frappe.throw(
				_("A escala inclui <b>{0}</b> vigilante(s), mas o posto <b>{1}</b> tem "
				  "capacidade máxima de <b>{2}</b>.").format(n, self.posto_de_vigilancia, max_vagas),
				title=_("Capacidade do Posto Excedida"),
			)

	# ─── Generation engine ─────────────────────────────────────────────────────

	def reconciliar_escala(self):
		"""
		Roll the schedule window forward (idempotent, future-only, override-safe):
		  - drop future days for guards no longer listed
		  - drop future non-override days for guards whose turno_inicial changed
		  - generate missing days for every guard up to the horizon
		  - trim days older than the keep-buffer
		Runs when estado is Rascunho or Activo (not Arquivado).
		The daily job only rolls Activo escalas; drafts generate when edited.
		"""
		if self.estado == "Arquivado":
			return
		if not (self.regime_do_vigilante and self.data_de_inicio):
			return

		hoje = getdate(nowdate())
		horizonte = frappe.db.get_single_value("SIGOS Settings", "meses_horizonte_escala") or 2
		janela_fim = get_last_day(add_months(hoje, horizonte))
		gerar_de = max(getdate(self.data_de_inicio), hoje)

		regime_doc = frappe.get_doc("Regime", self.regime_do_vigilante)
		sequence = [
			{"turno": r.turno, "periodo": r.periodo, "e_folga": r.e_folga}
			for r in sorted(regime_doc.turnos, key=lambda x: x.idx)
		]
		if not sequence:
			return
		working = [s for s in sequence if not s["e_folga"]]

		guards = {
			g.vigilante: g.turno_inicial
			for g in self.tab_vigilante_do_posto if g.vigilante
		}
		# Turno da Equipa (customer-specific, SIGOS Settings.turno_equipa_activo): a
		# label/grouping only — carried onto generated rows below, never affects which
		# turno/periodo a guard is assigned.
		equipas = {
			g.vigilante: g.turno_equipa
			for g in self.tab_vigilante_do_posto if g.vigilante
		}

		# Detect turno_inicial / turno_equipa changes
		forcar = set()
		before = self.get_doc_before_save()
		if before:
			antes = {g.vigilante: (g.turno_inicial, g.turno_equipa) for g in before.tab_vigilante_do_posto}
			for v, t in guards.items():
				if antes.get(v) != (t, equipas.get(v)):
					forcar.add(v)

		# Prune future rows that must be dropped
		mantidas = []
		for r in self.tabela_de_escala:
			rdata = getdate(r.data)
			if r.vigilante not in guards and rdata >= hoje:
				continue  # removed guard's future
			if r.vigilante in forcar and rdata >= hoje and not r.override:
				continue  # turno changed → regenerate
			mantidas.append(r)
		self.set("tabela_de_escala", mantidas)

		existing = {(r.vigilante, str(getdate(r.data))) for r in self.tabela_de_escala}
		anchor_date = getdate(self.data_de_inicio)

		# Generate forward
		for vig, turno_ini in guards.items():
			if not turno_ini:
				continue
			d = gerar_de
			while d <= janela_fim:
				if (vig, str(d)) not in existing:
					item = _turno_para_data(regime_doc, sequence, working, anchor_date, turno_ini, d)
					if item:
						self.append("tabela_de_escala", {
							"vigilante": vig,
							"posto": self.posto_de_vigilancia,
							"data": str(d),
							"turno": item["turno"],
							"turno_equipa": equipas.get(vig),
							"periodo": item["periodo"],
							"regime": self.regime_do_vigilante,
							"override": 0,
						})
				d = add_days(d, 1)

		self._trim_passado(hoje)
		self.gerado_ate = janela_fim

	def _trim_passado(self, hoje):
		manter = frappe.db.get_single_value("SIGOS Settings", "manter_meses_passados") or 1
		limite = get_first_day(add_months(hoje, -manter))
		mantidas = [r for r in self.tabela_de_escala if getdate(r.data) >= limite]
		self.set("tabela_de_escala", mantidas)

	def limpar_futuro(self):
		"""Remove all future, non-override rows (manual reset)."""
		hoje = getdate(nowdate())
		mantidas = [
			r for r in self.tabela_de_escala
			if getdate(r.data) < hoje or r.override
		]
		self.set("tabela_de_escala", mantidas)


# ─── Pure date-math turno resolver ───────────────────────────────────────────

def _weekdays_between(a, b):
	"""Count weekday dates d with a <= d < b (a is index 0)."""
	if b <= a:
		return 0
	total = (b - a).days
	cnt = (total // 7) * 5
	wd = a.weekday()
	for i in range(total % 7):
		if (wd + i) % 7 < 5:
			cnt += 1
	return cnt


def _turno_para_data(regime_doc, sequence, working, anchor_date, anchor_turno, target):
	"""Return the turno dict scheduled on `target`, or None (off day)."""
	tipo = regime_doc.tipo_ciclo

	if tipo == "Rotativo":
		L = len(sequence)
		ai = next((i for i, s in enumerate(sequence) if s["turno"] == anchor_turno), 0)
		idx = (ai + (target - anchor_date).days) % L
		return sequence[idx]

	if tipo == "Dias Úteis":
		if target.weekday() >= 5 or not working:
			return None
		return working[0]

	if tipo == "Dias Úteis Alternado":
		if target.weekday() >= 5 or not working:
			return None
		dpg = regime_doc.dias_por_grupo or 5
		start = next((i for i, s in enumerate(working) if s["turno"] == anchor_turno), 0)
		wd = _weekdays_between(anchor_date, target)
		grp = (start + (wd // dpg)) % len(working)
		return working[grp]

	return None


# ─── Shared helper (used by wizard / Rotatividade / Demissao) ─────────────────

def get_escalas_com_vigilante(vigilante: str) -> list:
	"""Return active Escalas that currently have FUTURE rows for the given vigilante."""
	if not vigilante:
		return []
	hoje = nowdate()
	return frappe.db.sql(
		"""
		SELECT DISTINCT e.name, e.posto_de_vigilancia, e.regime_do_vigilante,
		       e.data_de_inicio, e.gerado_ate
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent
		WHERE te.vigilante = %(vig)s
		  AND e.estado = 'Activo'
		  AND te.data >= %(hoje)s
		ORDER BY e.posto_de_vigilancia
		""",
		{"vig": vigilante, "hoje": hoje},
		as_dict=True,
	)


# ─── KEYSTONE: escala follows the guard ───────────────────────────────────────
# A single engine that moves a guard between (posto, regime) escalas. Triggered by
# the Vigilante controller whenever posto OR regime changes — so Rotatividade,
# Troca De Regime, Atribuir Vigilantes and manual edits all migrate the escala the
# same correct way. The escala doesn't care WHY the guard moved, only the pair.

def _escala_do_par(posto, regime):
	"""Active/Rascunho escala for a (posto, regime) pair, or None."""
	if not (posto and regime):
		return None
	return frappe.db.get_value(
		"Escala Do Vigilante",
		{"posto_de_vigilancia": posto, "regime_do_vigilante": regime, "estado": ["!=", "Arquivado"]},
		"name",
	)


def _turno_inicial_livre(esc, regime):
	"""Pick a free working turno to preserve coverage; fall back to the first working turno."""
	from sigos.utils import get_regime_turno_sequence
	seq = get_regime_turno_sequence(regime)
	working = [t["turno"] for t in seq if not t.get("e_folga")]
	if not working:
		return None
	usados = {g.turno_inicial for g in esc.tab_vigilante_do_posto if g.turno_inicial}
	livres = [t for t in working if t not in usados]
	return livres[0] if livres else working[0]


def _remover_vigilante_da_escala(vigilante, posto, regime):
	nome = _escala_do_par(posto, regime)
	if not nome:
		return None
	esc = frappe.get_doc("Escala Do Vigilante", nome)
	antes = len(esc.tab_vigilante_do_posto)
	esc.set("tab_vigilante_do_posto", [
		g for g in esc.tab_vigilante_do_posto if g.vigilante != vigilante
	])
	if len(esc.tab_vigilante_do_posto) == antes:
		return None  # guard wasn't in it
	esc.save(ignore_permissions=True)  # reconcile drops their future rows; auto-archives if empty
	return nome


def obter_turno_inicial_actual(vigilante, posto, regime):
	"""
	Current turno_inicial (rotation slot) of a guard on the (posto, regime) escala,
	or None if they're not on it / no such escala exists. Callers capture this
	BEFORE removing the guard (e.g. Rotatividade, before vig.save() cascades their
	removal) so it can be carried forward to whoever replaces them — see
	migrar_escala_vigilante's turno_inicial param.
	"""
	nome = _escala_do_par(posto, regime)
	if not nome:
		return None
	return frappe.db.get_value(
		"Tab Vigilante Do Posto", {"parent": nome, "vigilante": vigilante}, "turno_inicial"
	)


def _adicionar_vigilante_a_escala(vigilante, posto, regime, turno_inicial=None, evitar_colisao=True):
	nome = _escala_do_par(posto, regime)
	criada = False
	if nome:
		esc = frappe.get_doc("Escala Do Vigilante", nome)
	else:
		esc = frappe.new_doc("Escala Do Vigilante")
		esc.posto_de_vigilancia = posto
		esc.regime_do_vigilante = regime
		esc.data_de_inicio = nowdate()
		esc.estado = "Activo"
		cliente = frappe.db.get_value("Posto De Vigilancia", posto, "cliente")
		if cliente:
			esc.cliente = cliente
		criada = True

	turno_ocupado = None
	if not any(g.vigilante == vigilante for g in esc.tab_vigilante_do_posto):
		if turno_inicial:
			# Explicit slot (typically a vacated one carried forward from whoever this
			# guard is replacing) — trusted as-is, NOT restricted to non-folga turnos
			# like _turno_inicial_livre: a guard can legitimately inherit a folga slot.
			turno = turno_inicial
			# evitar_colisao=False (Cobridor): the guard already holding this turno_inicial
			# is NOT displaced — they're still nominally on the roster (just away/absent),
			# and the whole point is the Cobridor SHARING their exact slot, not bumping them.
			if evitar_colisao:
				colidente = next(
					(g for g in esc.tab_vigilante_do_posto if g.turno_inicial == turno), None
				)
				if colidente:
					colidente.turno_inicial = _turno_inicial_livre(esc, regime)
		else:
			turno = _turno_inicial_livre(esc, regime)
		esc.append("tab_vigilante_do_posto", {
			"vigilante": vigilante,
			"turno_inicial": turno,
		})
		turno_ocupado = turno
	esc.save(ignore_permissions=True)  # reconcile generates their rows

	if turno_ocupado and evitar_colisao:
		# Whoever lands on a posto+regime+turno slot auto-closes any open Vaga De
		# Posto for it — universal hook (Rotatividade substituto, Atribuir, manual
		# edits all funnel through here via the keystone). Skipped for a Cobridor
		# co-locating with a still-present guard: nothing was ever vacated, so
		# there's no Vaga to close.
		from sigos.security_ops.doctype.vaga_de_posto.vaga_de_posto import fechar_vaga
		fechar_vaga(posto, regime, turno_ocupado, vigilante)

	return esc.name, criada


def migrar_escala_vigilante(vigilante, old_posto, old_regime, new_posto, new_regime, turno_inicial=None,
                             evitar_colisao=True):
	"""
	Move a guard from the (old_posto, old_regime) escala to the (new_posto, new_regime)
	escala. Pass new_posto/new_regime as None to only remove (e.g. demissão / inactive).
	turno_inicial (optional): a specific rotation slot to give them on arrival — e.g. the
	slot vacated by whoever they're replacing (see obter_turno_inicial_actual) — instead
	of the generic "first free working turno" pick.
	evitar_colisao=False only for a Cobridor deployment (see deployar_cobridor) — they
	intentionally co-locate with a still-present guard instead of displacing them.
	Returns {removido_de, adicionado_a, criada} or None when nothing changed.
	"""
	if (old_posto, old_regime) == (new_posto, new_regime):
		return None

	removido = _remover_vigilante_da_escala(vigilante, old_posto, old_regime)
	adicionado, criada = (None, False)
	if new_posto and new_regime:
		adicionado, criada = _adicionar_vigilante_a_escala(
			vigilante, new_posto, new_regime, turno_inicial=turno_inicial, evitar_colisao=evitar_colisao,
		)

	if not (removido or adicionado):
		return None
	return {"removido_de": removido, "adicionado_a": adicionado, "criada": criada}


# ─── Escala de Reserva (delegação-scoped, no posto) ────────────────────────────
# The Reserva counterpart of the keystone above — same "escala follows the
# guard" idea, but keyed by delegação instead of (posto, regime), and never
# auto-created: unlike a real posto (where posto+regime fully determine the
# escala), there's no safe default posto-less escala to conjure up, so this is
# opt-in infrastructure HR sets up deliberately (Escala Do Vigilante,
# tipo_de_escala == "Reserva"). Triggered from Vigilante._migrar_escala_reserva_se_mudou.

def _escalas_reserva_da_delegacao(delegacao):
	"""Every non-arquivada Reserva-tipo escala for a delegação."""
	if not delegacao:
		return []
	return frappe.get_all(
		"Escala Do Vigilante",
		filters={"tipo_de_escala": "Reserva", "delegacao": delegacao, "estado": ["!=", "Arquivado"]},
		pluck="name",
	)


def remover_vigilante_da_escala_reserva(vigilante, delegacao):
	"""Remove a guard from whatever Reserva escala(s) they're on for `delegacao`
	— used when a guard leaves Reserva, or moves to a different delegação while
	still in Reserva. Silent no-op if none found or they weren't in it."""
	removido = None
	for nome in _escalas_reserva_da_delegacao(delegacao):
		esc = frappe.get_doc("Escala Do Vigilante", nome)
		antes = len(esc.tab_vigilante_do_posto)
		esc.set("tab_vigilante_do_posto", [
			g for g in esc.tab_vigilante_do_posto if g.vigilante != vigilante
		])
		if len(esc.tab_vigilante_do_posto) != antes:
			esc.save(ignore_permissions=True)
			removido = nome
	return removido


def adicionar_vigilante_a_escala_reserva(vigilante, delegacao, turno_inicial=None):
	"""
	Add a guard to their delegação's Reserva-tipo escala, if EXACTLY one exists.
	Never auto-creates one (see module note above). turno_inicial (optional): the
	guard's just-vacated real turno (obter_turno_inicial_actual) — reused as-is
	ONLY if that exact Turno also exists in the Reserva escala's own Regime
	sequence (continuity); otherwise falls back to the generic "first free
	working turno" pick, same collision-avoidance as the real-posto engine.

	Returns (nome_da_escala_ou_None, aviso_ou_None) — `aviso` is a user-facing
	message for the ambiguous case (more than one Reserva escala for this
	delegação); the caller (Vigilante) surfaces it via msgprint. No escala at
	all is NOT a warning — most delegações won't have one set up, and that's
	fine, the guard just enters Reserva without turno-weighted faltas tracking.
	"""
	nomes = _escalas_reserva_da_delegacao(delegacao)
	if len(nomes) > 1:
		return None, _(
			"Existem <b>{0}</b> Escalas de Reserva para a delegação <b>{1}</b> — "
			"não é possível escolher automaticamente. Adicione o vigilante "
			"manualmente à escala correcta."
		).format(len(nomes), delegacao)
	if not nomes:
		return None, None

	esc = frappe.get_doc("Escala Do Vigilante", nomes[0])
	if any(g.vigilante == vigilante for g in esc.tab_vigilante_do_posto):
		return esc.name, None  # already on it

	turno = None
	if turno_inicial:
		validos = {r.turno for r in frappe.get_cached_doc("Regime", esc.regime_do_vigilante).turnos}
		if turno_inicial in validos:
			turno = turno_inicial

	if not turno:
		turno = _turno_inicial_livre(esc, esc.regime_do_vigilante)
	elif any(g.turno_inicial == turno for g in esc.tab_vigilante_do_posto):
		# Carried-over slot collides with someone already on it — bump THEM to a
		# free slot instead of silently overlapping two guards on the same turno,
		# same rule _adicionar_vigilante_a_escala applies for real postos.
		colidente = next(g for g in esc.tab_vigilante_do_posto if g.turno_inicial == turno)
		colidente.turno_inicial = _turno_inicial_livre(esc, esc.regime_do_vigilante)

	esc.append("tab_vigilante_do_posto", {"vigilante": vigilante, "turno_inicial": turno})
	esc.save(ignore_permissions=True)
	return esc.name, None


# ─── Cobridor (temporary named-cover deployment) ───────────────────────────────
# A Cobridor is a Reserva guard deployed onto ONE specific colleague's exact
# posto+regime+turno for the duration of the colleague's absence — Licença,
# Suspensão/Investigação, or any other reason (Cobertura De Posto.tipo_cobertura)
# — the covered guard's own row is never touched by the trigger flow (Pedido De
# Licença/Processo Disciplinar never save the Vigilante doc), so both rows
# coexist sharing one turno_inicial. See Cobertura De Posto for the record that
# drives this, including the "Efectivar" outcome where the Cobridor becomes the
# permanent holder instead of reverting.

def deployar_cobridor(vigilante_cobridor, cobertura, posto, regime, turno_inicial):
	"""
	Deploy a Reserva guard as a Cobridor onto (posto, regime, turno_inicial) —
	the exact slot of the colleague they're covering — WITHOUT displacing them.
	Mirrors Rotatividade's substituto deployment, plus the two markers that make
	the "Activo but shadow" distinction survive across requests: status flips to
	Activo (so pool-exclusion queries filtering status='Reserva' exclude them for
	free), and cobertura_de_posto_activa records why (read by
	EscalaDoVigilante._validar_capacidade_posto, Vigilante._validar_capacidade_posto,
	atualizar_ocupacao_posto and Faturacao Mensal's billing query, so none of them
	double-count this guard against the real posto headcount — until Cobertura De
	Posto.efectivar() clears it, at which point they become a real headcount).
	"""
	sub = frappe.get_doc("Vigilante", vigilante_cobridor)
	sub.posto_de_vigilancia = posto
	if sub.regime_do_vigilante != regime:
		sub.regime_do_vigilante = regime
		sub.flags.via_troca_regime = True  # deployment, not an arbitrary regime change
	sub.status = "Activo"
	sub.cobertura_de_posto_activa = cobertura
	sub.flags.turno_inicial_preferido = turno_inicial
	sub.flags.via_cobridor = True  # read by Vigilante._migrar_escala_se_mudou / _validar_capacidade_posto
	sub.save(ignore_permissions=True)


def reverter_cobridor(vigilante_cobridor):
	"""Send a deployed Cobridor back to Reserva, carrying their vacated turno
	into the delegação's Reserva escala when one exists — same continuity
	Vigilante._mudar_estado_operacional gives a guard sent to Reserva normally.
	The covered guard's own row/future rows are untouched (removal below is
	keyed by vigilante name, not turno_inicial). NOT called when a Cobertura is
	Efectivada instead of Concluída/Cancelada — the Cobridor stays deployed."""
	sub = frappe.get_doc("Vigilante", vigilante_cobridor)
	if sub.status != "Activo" or not (sub.posto_de_vigilancia and sub.regime_do_vigilante):
		return

	turno_vago = obter_turno_inicial_actual(
		vigilante_cobridor, sub.posto_de_vigilancia, sub.regime_do_vigilante
	)
	if turno_vago:
		sub.flags.turno_inicial_preferido = turno_vago

	from sigos.security_ops.doctype.vigilante.vigilante import limpar_campos_operacionais
	sub.status = "Reserva"
	limpar_campos_operacionais(sub)
	sub.cobertura_de_posto_activa = None
	sub.save(ignore_permissions=True)
