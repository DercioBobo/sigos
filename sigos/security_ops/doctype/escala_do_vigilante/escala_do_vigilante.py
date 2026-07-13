import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate, nowdate, add_days, add_months, get_first_day, get_last_day


class EscalaDoVigilante(Document):

	def validate(self):
		self._validar_um_por_posto()
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
		n = len({r.vigilante for r in self.tab_vigilante_do_posto if r.vigilante})
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


def _adicionar_vigilante_a_escala(vigilante, posto, regime):
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

	if not any(g.vigilante == vigilante for g in esc.tab_vigilante_do_posto):
		esc.append("tab_vigilante_do_posto", {
			"vigilante": vigilante,
			"turno_inicial": _turno_inicial_livre(esc, regime),
		})
	esc.save(ignore_permissions=True)  # reconcile generates their rows
	return esc.name, criada


def migrar_escala_vigilante(vigilante, old_posto, old_regime, new_posto, new_regime):
	"""
	Move a guard from the (old_posto, old_regime) escala to the (new_posto, new_regime)
	escala. Pass new_posto/new_regime as None to only remove (e.g. demissão / inactive).
	Returns {removido_de, adicionado_a, criada} or None when nothing changed.
	"""
	if (old_posto, old_regime) == (new_posto, new_regime):
		return None

	removido = _remover_vigilante_da_escala(vigilante, old_posto, old_regime)
	adicionado, criada = (None, False)
	if new_posto and new_regime:
		adicionado, criada = _adicionar_vigilante_a_escala(vigilante, new_posto, new_regime)

	if not (removido or adicionado):
		return None
	return {"removido_de": removido, "adicionado_a": adicionado, "criada": criada}
