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
from frappe.utils import getdate, nowdate


def calendario(regime):
	"""Active calendar of a regime as a dict, or None.
	{name, regime, data_referencia, sequencia:[{turno, periodo, e_folga}], equipas:{equipa: indice}}"""
	if not regime:
		return None
	cache = frappe.local.__dict__.setdefault("_sigos_cal_equipas", {})
	if regime in cache:
		return cache[regime]
	nome = frappe.db.get_value("Calendario De Equipas", {"regime": regime, "activo": 1}, "name")
	out = None
	if nome:
		cal = frappe.get_cached_doc("Calendario De Equipas", nome)
		reg = frappe.get_cached_doc("Regime", regime)
		seq = [{"turno": r.turno, "periodo": r.periodo, "e_folga": r.e_folga}
			for r in sorted(reg.turnos, key=lambda x: x.idx)]
		if reg.tipo_ciclo == "Rotativo" and seq and cal.data_referencia:
			idx = {}
			for linha in cal.equipas or []:
				i = next((k for k, s in enumerate(seq) if s["turno"] == linha.turno), None)
				if linha.turno_equipa and i is not None:
					idx[linha.turno_equipa] = i
			if idx:
				out = frappe._dict(name=nome, regime=regime, data_referencia=getdate(cal.data_referencia),
					sequencia=seq, equipas=idx)
	cache[regime] = out
	return out


def limpar_cache():
	frappe.local.__dict__.pop("_sigos_cal_equipas", None)


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
	"""Team whose turno_inicial is `turno` — exact, else the nearest phase (None if no teams)."""
	seq = [s["turno"] for s in cal.sequencia]
	if turno not in seq:
		return None
	alvo, L = seq.index(turno), len(seq)
	melhor, dist = None, None
	for eq in sorted(cal.equipas):
		pos = (cal.equipas[eq] + int(ajuste or 0)) % L
		d = min((alvo - pos) % L, (pos - alvo) % L)
		if dist is None or d < dist:
			melhor, dist = eq, d
	return melhor


def equipa_pela_fase(cal, turno_hoje, data, ajuste=0):
	"""Team doing `turno_hoje` on `data` (nearest phase when none matches exactly)."""
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

def _turno_de_hoje_antigo(esc, vigilante, hoje):
	"""Guard's turno today under the escala's CURRENT rows / old anchor (before the calendar)."""
	for r in esc.tabela_de_escala or []:
		if r.vigilante == vigilante and getdate(r.data) == hoje:
			return r.turno
	return None


def planear(esc, cal):
	"""Team + turno_inicial for every guard row of `esc` under calendar `cal`, in order:
	  1. a valid team already on the row is kept;
	  2. escala already on the calendar + a carried turno_inicial (substitute, Vaga,
	     return…) → the team owning that slot (turno_inicial is the same at every posto);
	  3. escala moving onto the calendar → the team doing the guard's current turno today
	     (nearest phase when none matches — that guard's rhythm shifts);
	  4. otherwise the team with fewest guards here.
	Returns [{row, vigilante, equipa, turno_inicial, turno_antes, turno_depois}]."""
	hoje = getdate(nowdate())
	ajuste = int(esc.get("ajuste_local_dias") or 0)
	ja_no_calendario = bool(esc.get("usa_calendario"))
	contagem = {eq: 0 for eq in cal.equipas}
	for g in esc.tab_vigilante_do_posto or []:
		if g.turno_equipa in contagem:
			contagem[g.turno_equipa] += 1
	plano = []
	for g in esc.tab_vigilante_do_posto or []:
		if not g.vigilante:
			continue
		antes = _turno_de_hoje_antigo(esc, g.vigilante, hoje)
		eq = g.turno_equipa if g.turno_equipa in cal.equipas else None
		if not eq and ja_no_calendario and g.turno_inicial:
			eq = equipa_do_turno_inicial(cal, g.turno_inicial, ajuste)
		if not eq and not ja_no_calendario and antes:
			eq = equipa_pela_fase(cal, antes, hoje, ajuste)
		if not eq:
			eq = min(sorted(contagem), key=lambda k: (contagem[k], cal.equipas[k]))
		if g.turno_equipa not in cal.equipas:
			contagem[eq] += 1
		plano.append({"row": g, "vigilante": g.vigilante, "nome": g.get("nome_completo"), "equipa": eq,
			"equipa_antes": g.turno_equipa, "turno_inicial": turno_inicial(cal, eq, ajuste),
			"turno_antes": antes, "turno_depois": turno_em(cal, eq, hoje, ajuste)["turno"]})
	return plano
