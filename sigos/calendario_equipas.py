"""
Calendário de Equipas — the company-wide team rotation of a (Rotativo) regime.

Management sets, per regime, a reference date and which turno each team
(Turno Da Equipa: "Equipa 1", "Turno A", "1º Turno"…) does on that day. From then
on every team advances one step of the regime's sequence per day, forever, at every
posto. So the team in an escala row fully determines the guard's turno on any date.

How the escala uses it (EscalaDoVigilante._aplicar_calendario): on an escala of a
regime with an active calendar, every guard row belongs to a team and its
`turno_inicial` is the team's turno ON THE CALENDAR'S REFERENCE DATE (shifted by the
escala's `ajuste_local_dias`), generated from that same reference date. Hence a
team has the SAME turno_inicial on every non-adjusted escala of the regime, and all
the existing "carry the vacated slot" flows (Rotatividade substitute, Vaga, return
from Doença/Suspensão, Cobridor, Reserva) carry the team for free.
"""

import frappe
from frappe import _
from frappe.utils import add_days, getdate, nowdate


def activo():
	"""Master switch (SIGOS Settings.calendario_equipas_activo). Off → every calendar
	path is inert and escalas/vagas/teams behave exactly as before the calendar."""
	return bool(frappe.db.get_single_value("SIGOS Settings", "calendario_equipas_activo"))


def calendario(regime):
	"""Active calendar of a regime as a dict, or None (always None when switched off).
	{name, regime, data_referencia, sequencia:[{turno, periodo, e_folga}], equipas:{equipa: indice}}"""
	if not regime or not activo():
		return None
	cache = getattr(frappe.local, "sigos_cal_equipas", None)
	if cache is None:
		cache = frappe.local.sigos_cal_equipas = {}
	if regime not in cache:
		nome = frappe.db.get_value("Calendario De Equipas", {"regime": regime, "activo": 1}, "name")
		cache[regime] = carregar(nome) if nome else None
	return cache[regime]


def carregar(nome):
	"""Calendar `nome` as a dict regardless of the switch / its activo flag, or None."""
	if not nome or not frappe.db.exists("Calendario De Equipas", nome):
		return None
	cal = frappe.get_cached_doc("Calendario De Equipas", nome)
	reg = frappe.get_cached_doc("Regime", cal.regime)
	seq = [{"turno": r.turno, "periodo": r.periodo, "e_folga": r.e_folga}
		for r in sorted(reg.turnos, key=lambda x: x.idx)]
	if reg.tipo_ciclo != "Rotativo" or not seq or not cal.data_referencia:
		return None
	idx = {}
	for linha in cal.equipas or []:
		i = next((k for k, s in enumerate(seq) if s["turno"] == linha.turno), None)
		if linha.turno_equipa and i is not None:
			idx[linha.turno_equipa] = i
	if not idx:
		return None
	return frappe._dict(name=nome, regime=cal.regime, data_referencia=getdate(cal.data_referencia),
		sequencia=seq, equipas=idx)


def limpar_cache():
	frappe.local.sigos_cal_equipas = {}


def indice(cal, equipa, data, ajuste=0):
	"""Position in the regime sequence of `equipa` on `data`."""
	L = len(cal.sequencia)
	return (cal.equipas[equipa] + int(ajuste or 0) + (getdate(data) - cal.data_referencia).days) % L


def turno_em(cal, equipa, data, ajuste=0):
	"""{turno, periodo, e_folga} of `equipa` on `data`."""
	return cal.sequencia[indice(cal, equipa, data, ajuste)]


def turno_inicial(cal, equipa, ajuste=0):
	"""The team's turno_inicial on a calendar escala (its turno on the reference date, shifted)."""
	return turno_em(cal, equipa, cal.data_referencia, ajuste)["turno"]


def equipa_do_turno_inicial(cal, turno, ajuste=0):
	"""Team whose turno_inicial is `turno`. When none matches exactly (the guard's
	escala was out of step), the team AT OR JUST BEHIND that position — a
	rectification: a guard wrongly on 2a Manhã goes to the team on 1a Manhã
	(user rule, 2026-11-23). None if the turno isn't in the regime."""
	seq = [s["turno"] for s in cal.sequencia]
	if turno not in seq:
		return None
	alvo, L = seq.index(turno), len(seq)
	return min(sorted(cal.equipas),
		key=lambda eq: (alvo - (cal.equipas[eq] + int(ajuste or 0))) % L)


def equipa_pela_fase(cal, turno_hoje, data, ajuste=0):
	"""Team doing `turno_hoje` on `data` (else the team just behind — see above)."""
	seq = [s["turno"] for s in cal.sequencia]
	if turno_hoje not in seq:
		return None
	desloc = (getdate(data) - cal.data_referencia).days
	# turno on data = seq[(i0 + ajuste + desloc) % L]  →  turno_inicial = seq[(alvo - desloc) % L]
	L = len(seq)
	return equipa_do_turno_inicial(cal, seq[(seq.index(turno_hoje) - desloc) % L], ajuste)


# ─── Read API (Vigilantes de Hoje strip, Escala dialog) ─────────────────────────

@frappe.whitelist()
def equipas_do_dia(data=None, regime=None):
	"""Every active calendar's teams and their turno on `data` — the "Hoje" strip."""
	from sigos.api import PAPEIS_INTERNOS
	frappe.only_for(PAPEIS_INTERNOS)
	if not activo():
		return []
	d = getdate(data or nowdate())
	filtros = {"activo": 1}
	if regime:
		filtros["regime"] = regime
	out = []
	for reg in frappe.get_all("Calendario De Equipas", filters=filtros, pluck="regime", order_by="regime"):
		cal = calendario(reg)
		if not cal:
			continue
		linhas = []
		for eq in sorted(cal.equipas, key=lambda e: cal.equipas[e]):
			t = turno_em(cal, eq, d)
			linhas.append({"equipa": eq, "turno": t["turno"], "periodo": t["periodo"], "e_folga": t["e_folga"]})
		out.append({"regime": reg, "calendario": cal.name, "equipas": linhas})
	return out


@frappe.whitelist()
def turnos_das_equipas(regime, ajuste=0, data=None):
	"""Escala dialog: per team, its turno_inicial (calendar escala) and its turno today."""
	from sigos.api import PAPEIS_INTERNOS
	frappe.only_for(PAPEIS_INTERNOS)
	cal = calendario(regime)
	if not cal:
		return None
	d = getdate(data or nowdate())
	return {
		"calendario": cal.name,
		"equipas": [
			{"equipa": eq, "turno_inicial": turno_inicial(cal, eq, ajuste),
			 "hoje": turno_em(cal, eq, d, ajuste)["turno"]}
			for eq in sorted(cal.equipas, key=lambda e: cal.equipas[e])
		],
	}


# ─── Rest check (warning only) ─────────────────────────────────────────────────

def aviso_descanso(vigilante, data, periodo_novo, turno_novo=None):
	"""Warning text when the guard did a Noite the day before a new Manhã — no rest
	between them — else None. Reads yesterday from any escala's generated rows."""
	if periodo_novo != "Manhã":
		return None
	ontem = frappe.db.sql("""
		SELECT te.turno, COALESCE(NULLIF(te.periodo, ''), t.periodo) AS periodo, e.name AS escala
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent
		LEFT JOIN `tabTurno` t ON t.name = te.turno
		WHERE te.vigilante = %(v)s AND te.data = DATE_SUB(%(d)s, INTERVAL 1 DAY)
		  AND COALESCE(t.e_folga, 0) = 0
		LIMIT 1""", {"v": vigilante, "d": getdate(data)}, as_dict=True)
	if ontem and ontem[0].periodo == "Noite":
		nome = frappe.db.get_value("Vigilante", vigilante, "nome_completo") or vigilante
		return _("<b>{0}</b>: fez <b>{1}</b> ontem e entra em <b>{2}</b> hoje — sem descanso entre turnos.").format(
			nome, ontem[0].turno, turno_novo or periodo_novo)
	return None


# ─── Team assignment of an escala (shared by the escala itself and the preview) ──

def _turno_no_dia(esc, vigilante, dia):
	"""Guard's turno on `dia` in the escala's CURRENT rows (before regeneration)."""
	for r in esc.tabela_de_escala or []:
		if r.vigilante == vigilante and getdate(r.data) == dia:
			return r.turno
	return None


def _fase_real_hoje(esc, cal, vigilante, hoje, desde=None):
	"""What the guard is REALLY doing today by their own rhythm: their row on `desde`
	(e.g. yesterday, untouched by any regeneration) advanced to today; else today's row."""
	seq = [x["turno"] for x in cal.sequencia]
	if desde:
		t = _turno_no_dia(esc, vigilante, desde)
		if t in seq:
			return seq[(seq.index(t) + (hoje - desde).days) % len(seq)]
		return None
	t = _turno_no_dia(esc, vigilante, hoje)
	if t:
		return t
	ontem = getdate(add_days(hoje, -1))
	t = _turno_no_dia(esc, vigilante, ontem)
	return seq[(seq.index(t) + 1) % len(seq)] if t in seq else None


def planear(esc, cal, rectificar_desde=None):
	"""Team + turno_inicial for every guard row of `esc` under calendar `cal`.
	  · escala JOINING the calendar, or a rectification (`rectificar_desde` = a past
	    date whose rows show the guards' real rhythm): the team doing the guard's REAL
	    turno today, else the team just behind it (2a Manhã → the 1a Manhã team).
	    Old per-posto team labels are ignored — they were never company-aligned.
	  · escala already on the calendar: keep a valid team; a carried turno_inicial
	    (substitute, Vaga, return…) → the team owning that slot.
	  · otherwise the team with fewest guards here.
	Returns [{row, vigilante, equipa, turno_inicial, turno_antes, turno_depois}]."""
	hoje = getdate(nowdate())
	ajuste = int(esc.get("ajuste_local_dias") or 0)
	pela_fase = bool(rectificar_desde) or not esc.get("usa_calendario")
	desde = getdate(rectificar_desde) if rectificar_desde else None
	contagem = {eq: 0 for eq in cal.equipas}
	plano = []
	for g in esc.tab_vigilante_do_posto or []:
		if not g.vigilante:
			continue
		antes = _turno_no_dia(esc, g.vigilante, hoje)
		eq = None
		if pela_fase:
			real = _fase_real_hoje(esc, cal, g.vigilante, hoje, desde)
			if real:
				eq = equipa_pela_fase(cal, real, hoje, ajuste)
		if not eq and g.turno_equipa in cal.equipas:
			eq = g.turno_equipa
		if not eq and not pela_fase and g.turno_inicial:
			eq = equipa_do_turno_inicial(cal, g.turno_inicial, ajuste)
		if not eq:
			eq = min(sorted(contagem), key=lambda k: (contagem[k], cal.equipas[k]))
		contagem[eq] += 1
		plano.append({"row": g, "vigilante": g.vigilante, "nome": g.get("nome_completo"), "equipa": eq,
			"equipa_antes": g.turno_equipa, "turno_inicial": turno_inicial(cal, eq, ajuste),
			"turno_antes": antes, "turno_depois": turno_em(cal, eq, hoje, ajuste)["turno"]})
	return plano
