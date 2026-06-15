"""
SIGOS — Painel Operacional CCO.

Live operational board for the Centro de Controlo Operacional: for a given day it
reads the published Escala (the source of truth for who should be at each posto),
overlays submitted Ausencias, approved Férias and today's Ocorrências, and reports
per-posto coverage plus the deployable Reserva pool.

Read-only and cheap: a handful of indexed queries merged in Python. The page calls
`painel_operacional` on load / filter / refresh; doc events publish a realtime nudge
(`notificar_mudanca`) so an open board re-fetches when the ground truth changes.
"""
import frappe
from frappe.utils import getdate, nowdate


# Absence types that still leave the posto manned (guard showed up, partially).
_AUSENCIA_PARCIAL = ("Atraso", "Saída Antecipada")


@frappe.whitelist()
def painel_operacional(data=None, delegacao=None, cliente=None, posto=None, busca=None):
	"""Snapshot of the operation for `data` (default today), optionally scoped."""
	d = getdate(data or nowdate())
	leave_type = frappe.db.get_single_value("SIGOS Settings", "leave_type_ferias") or "Ferias"

	postos = _postos_activos(delegacao, cliente, posto)
	nomes_posto = [p["name"] for p in postos]

	escala = _escala_do_dia(d, nomes_posto)
	ausencias = _ausencias_do_dia(d)
	ferias = _ferias_do_dia(d, leave_type)
	reserva = _reserva_disponivel(delegacao)
	ocorrencias = _ocorrencias(d, delegacao, posto)
	ocorr_abertas = _contar_ocorrencias_abertas(delegacao)

	# Index escala rows by posto
	por_posto = {}
	for r in escala:
		por_posto.setdefault(r["posto"], []).append(r)

	cards = []
	agg = {
		"escalados": 0, "presentes": 0, "faltas": 0, "ferias": 0,
		"substituidos": 0, "atrasos": 0, "lacunas_slots": 0,
	}

	for p in postos:
		linhas = por_posto.get(p["name"], [])
		guardas = []
		gaps = 0
		for r in linhas:
			estado, cobertura, cobre_nome = _estado_guarda(r, ausencias, ferias)
			agg["escalados"] += 1
			agg[_AGG_KEY[estado]] += 1
			if not cobertura:
				gaps += 1
			guardas.append({
				"vigilante": r["vigilante"],
				"nome": r["nome_completo"],
				"mecanografico": r.get("mecanografico"),
				"turno": r.get("turno"),
				"periodo": r.get("periodo") or "—",
				"estado": estado,
				"coberto": cobertura,
				"cobre_nome": cobre_nome,
			})

		slots = len(guardas)
		agg["lacunas_slots"] += gaps
		if slots == 0:
			cobertura_posto = "sem_escala"
		elif gaps == 0:
			cobertura_posto = "coberto"
		elif gaps < slots:
			cobertura_posto = "lacuna"
		else:
			cobertura_posto = "descoberto"

		# Order guards by period (Manhã, Tarde, Noite) then name
		guardas.sort(key=lambda g: (_ORD_PERIODO.get(g["periodo"], 9), g["nome"] or ""))

		cards.append({
			"posto": p["name"],
			"nome": p["nome_do_posto"],
			"delegacao": p.get("delegacao"),
			"cliente": p.get("cliente"),
			"tipo": p.get("tipo_de_posto"),
			"vagas": p.get("numero_de_vagas"),
			"slots": slots,
			"gaps": gaps,
			"cobertura": cobertura_posto,
			"guardas": guardas,
		})

	if busca:
		cards = _filtrar_busca(cards, busca)

	# Posto-level coverage tallies (after busca)
	postos_cob = sum(1 for c in cards if c["cobertura"] == "coberto")
	postos_lac = sum(1 for c in cards if c["cobertura"] == "lacuna")
	postos_desc = sum(1 for c in cards if c["cobertura"] in ("descoberto", "sem_escala"))

	cobertos_slots = agg["escalados"] - agg["lacunas_slots"]
	taxa = round(cobertos_slots / agg["escalados"] * 100) if agg["escalados"] else 100

	# Sort cards: trouble first (descoberto, lacuna), then by delegação/nome
	cards.sort(key=lambda c: (_ORD_COBERTURA.get(c["cobertura"], 9), c.get("delegacao") or "", c["nome"] or ""))

	return {
		"data": d.isoformat(),
		"kpis": {
			"postos_total": len(cards),
			"postos_cobertos": postos_cob,
			"postos_com_lacuna": postos_lac,
			"postos_descobertos": postos_desc,
			"escalados": agg["escalados"],
			"presentes": agg["presentes"],
			"faltas": agg["faltas"],
			"ferias": agg["ferias"],
			"substituidos": agg["substituidos"],
			"atrasos": agg["atrasos"],
			"reserva_disponivel": len(reserva),
			"ocorrencias_hoje": len(ocorrencias),
			"ocorrencias_abertas": ocorr_abertas,
			"taxa_cobertura": taxa,
		},
		"postos": cards,
		"reserva": reserva[:300],
		"ocorrencias": ocorrencias,
		"gerado_em": frappe.utils.now(),
	}


# Map guard estado -> aggregate counter key
_AGG_KEY = {
	"presente": "presentes",
	"falta": "faltas",
	"ferias": "ferias",
	"substituido": "substituidos",
	"atraso": "atrasos",
}
_ORD_PERIODO = {"Manhã": 0, "Tarde": 1, "Noite": 2}
_ORD_COBERTURA = {"descoberto": 0, "sem_escala": 1, "lacuna": 2, "coberto": 3}


def _estado_guarda(row, ausencias, ferias):
	"""Resolve a scheduled guard's live state. Returns (estado, coberto, cobre_nome)."""
	vig = row["vigilante"]
	aus = ausencias.get(vig)
	if aus:
		cobre = aus.get("substituto") or aus.get("dobra") or aus.get("adiantar")
		if aus["tipo"] == "Falta":
			if cobre or aus.get("accao") in ("Substituto", "Dobra de Turno", "Adiantamento de Turno"):
				return ("substituido", True, aus.get("cobre_nome"))
			return ("falta", False, None)
		if aus["tipo"] in _AUSENCIA_PARCIAL:
			return ("atraso", True, None)
		# Licença / Suspensão / Outro — guard not on post, treat as gap
		return ("falta", False, None)
	if vig in ferias:
		return ("ferias", False, None)
	return ("presente", True, None)


def _postos_activos(delegacao, cliente, posto):
	cond = ["estado = 'Activo'"]
	params = {}
	if delegacao:
		cond.append("delegacao = %(delegacao)s"); params["delegacao"] = delegacao
	if cliente:
		cond.append("cliente = %(cliente)s"); params["cliente"] = cliente
	if posto:
		cond.append("name = %(posto)s"); params["posto"] = posto
	return frappe.db.sql(
		f"""
		SELECT name, nome_do_posto, delegacao, cliente, tipo_de_posto, numero_de_vagas
		FROM `tabPosto De Vigilancia`
		WHERE {' AND '.join(cond)}
		ORDER BY delegacao, nome_do_posto
		""",
		params,
		as_dict=True,
	)


def _escala_do_dia(d, nomes_posto):
	"""Working (non-folga) scheduled rows for the date, scoped to the given postos."""
	if not nomes_posto:
		return []
	return frappe.db.sql(
		"""
		SELECT e.posto_de_vigilancia AS posto,
		       te.vigilante, v.nome_completo, v.mecanografico,
		       te.turno, COALESCE(NULLIF(te.periodo, ''), t.periodo) AS periodo, te.regime
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent AND e.estado = 'Activo'
		JOIN `tabVigilante` v ON v.name = te.vigilante
		LEFT JOIN `tabTurno` t ON t.name = te.turno
		WHERE te.data = %(data)s
		  AND (t.e_folga IS NULL OR t.e_folga = 0)
		  AND e.posto_de_vigilancia IN %(postos)s
		""",
		{"data": d, "postos": tuple(nomes_posto)},
		as_dict=True,
	)


def _ausencias_do_dia(d):
	"""vigilante -> absence info, from SUBMITTED Ausencias of the date (latest wins)."""
	rows = frappe.db.sql(
		"""
		SELECT ta.vigilante, ta.tipo_de_ausencia AS tipo, ta.proxima_accao AS accao,
		       ta.vigilante_substituto AS substituto, ta.vigilante_a_dobrar AS dobra,
		       ta.vigilante_a_adiantar AS adiantar,
		       COALESCE(sub.nome_completo, dob.nome_completo, adi.nome_completo) AS cobre_nome
		FROM `tabTabela Ausencia` ta
		JOIN `tabAusencias` a ON a.name = ta.parent
		LEFT JOIN `tabVigilante` sub ON sub.name = ta.vigilante_substituto
		LEFT JOIN `tabVigilante` dob ON dob.name = ta.vigilante_a_dobrar
		LEFT JOIN `tabVigilante` adi ON adi.name = ta.vigilante_a_adiantar
		WHERE a.docstatus = 1 AND a.data = %(data)s
		""",
		{"data": d},
		as_dict=True,
	)
	out = {}
	for r in rows:
		out[r["vigilante"]] = r
	return out


def _ferias_do_dia(d, leave_type):
	"""Set of vigilantes on APPROVED férias covering the date."""
	rows = frappe.db.sql(
		"""
		SELECT v.name AS vigilante
		FROM `tabLeave Application` la
		JOIN `tabVigilante` v ON v.funcionario = la.employee
		WHERE la.status = 'Approved' AND la.docstatus = 1
		  AND la.leave_type = %(lt)s
		  AND la.from_date <= %(data)s AND la.to_date >= %(data)s
		""",
		{"lt": leave_type, "data": d},
		as_dict=True,
	)
	return {r["vigilante"] for r in rows}


def _reserva_disponivel(delegacao):
	filters = {"status": "Reserva"}
	if delegacao:
		filters["delegacao"] = delegacao
	return frappe.get_all(
		"Vigilante",
		filters=filters,
		fields=["name", "nome_completo", "delegacao", "categoria"],
		order_by="nome_completo",
		limit_page_length=1000,
	)


_ORD_GRAVIDADE = {"Crítica": 0, "Alta": 1, "Média": 2, "Baixa": 3}


def _ocorrencias(d, delegacao, posto):
	filters = {"data": d}
	if delegacao:
		filters["delegacao"] = delegacao
	if posto:
		filters["posto"] = posto
	rows = frappe.get_all(
		"Ocorrencia",
		filters=filters,
		fields=["name", "assunto", "tipo", "gravidade", "estado", "posto",
		        "posto_nome", "hora", "vigilante", "delegacao"],
		order_by="hora desc",
		limit_page_length=200,
	)
	# Severity ranking via SQL field() is rejected by get_all's order_by guard, so rank here.
	# Stable sort keeps the query's `hora desc` order within each gravidade.
	rows.sort(key=lambda o: _ORD_GRAVIDADE.get(o.get("gravidade"), 9))
	return rows


def _contar_ocorrencias_abertas(delegacao):
	filters = {"estado": ["in", ["Aberta", "Em Investigação"]]}
	if delegacao:
		filters["delegacao"] = delegacao
	return frappe.db.count("Ocorrencia", filters)


def _filtrar_busca(cards, busca):
	"""Keep postos whose code/name matches, or that hold a guard matching the term."""
	t = (busca or "").strip().lower()
	if not t:
		return cards
	out = []
	for c in cards:
		if t in (c["posto"] or "").lower() or t in (c["nome"] or "").lower():
			out.append(c)
			continue
		match = [g for g in c["guardas"]
		         if t in (g["nome"] or "").lower()
		         or t in (g["vigilante"] or "").lower()
		         or t in (g.get("mecanografico") or "").lower()]
		if match:
			c = dict(c, guardas=match)
			out.append(c)
	return out


def notificar_mudanca(doc, method=None):
	"""
	Realtime nudge so EVERY open Painel Operacional re-fetches — broadcast to the whole
	site room (a CCO controller watching the board must hear changes made by others).
	Best-effort: never breaks the operation that triggered it (the board also polls).
	"""
	msg = {"doctype": getattr(doc, "doctype", None), "name": getattr(doc, "name", None)}
	try:
		from frappe.realtime import get_site_room
		frappe.publish_realtime("sigos_painel_operacional", msg, room=get_site_room(), after_commit=True)
	except Exception:
		try:
			frappe.publish_realtime("sigos_painel_operacional", msg, after_commit=True)
		except Exception:
			pass
