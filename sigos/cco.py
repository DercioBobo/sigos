"""
SIGOS — Painel CCO (estatístico).

Analytical companion to the live Painel Operacional: trends, distributions and
rankings over a period for the Centro de Controlo Operacional. Operational-control
focus — cobertura/efectivo, ocorrências, ausências/reserva and armamento. RH-flavoured
metrics (rotatividade, passivo de férias, disciplinar) live on the RH dashboard.

One whitelisted entrypoint (`cco_dashboard`) fans out into a handful of set-based
aggregate queries scoped by período + delegação/cliente/posto. Read-only and cheap;
the page refreshes on load / filter / manual refresh (no realtime push needed here).
"""
import frappe
from frappe.utils import getdate, nowdate, add_days, date_diff, flt


# Absence types that leave the posto unmanned (a real coverage gap).
_AUSENCIA_GAP = ("Suspensão", "Licença", "Outro")
# Actions on a Falta that keep the posto manned (the absence was covered).
_ACCAO_COBERTA = ("Substituto", "Dobra de Turno", "Adiantamento de Turno")
# Coverage SLA target (%) — the line the board measures every delegação against.
_META_COBERTURA = 95.0


@frappe.whitelist()
def cco_dashboard(de=None, ate=None, delegacao=None, cliente=None, posto=None):
	"""Full CCO statistical snapshot for a period, optionally scoped."""
	ate_d = getdate(ate or nowdate())
	de_d = getdate(de) if de else getdate(add_days(ate_d, -29))
	if de_d > ate_d:
		de_d, ate_d = ate_d, de_d
	dias = date_diff(ate_d, de_d) + 1

	# Previous comparable window (immediately before), for deltas.
	pate = getdate(add_days(de_d, -1))
	pde = getdate(add_days(pate, -(dias - 1)))

	scope = {"delegacao": delegacao or None, "cliente": cliente or None, "posto": posto or None}

	cob = _cobertura(de_d, ate_d, scope)
	cob_prev = _cobertura(pde, pate, scope, trend=False)
	ocor = _ocorrencias(de_d, ate_d, scope)
	ocor_prev = _ocorrencias(pde, pate, scope, resumo=True)
	aus = _ausencias(de_d, ate_d, scope)
	aus_prev = _ausencias(pde, pate, scope, resumo=True)
	efe = _efectivo(scope)
	arm = _armamento(scope)
	reserva = _reserva(scope)
	scorecard = _scorecard(de_d, ate_d, scope, cob.get("por_delegacao", []),
	                       efe["delegacao"], reserva["por_delegacao"])

	return {
		"periodo": {"de": de_d.isoformat(), "ate": ate_d.isoformat(), "dias": dias},
		"kpis": {
			"cobertura_media": cob["media"], "cobertura_media_prev": cob_prev["media"],
			"meta_cobertura": _META_COBERTURA,
			"gap_slots": cob["gap_slots"], "gap_slots_prev": cob_prev["gap_slots"],
			"ocorrencias": ocor["total"], "ocorrencias_prev": ocor_prev["total"],
			"ocorrencias_graves": ocor["graves"], "ocorrencias_graves_prev": ocor_prev["graves"],
			"taxa_substituicao": aus["taxa_substituicao"], "taxa_substituicao_prev": aus_prev["taxa_substituicao"],
			"reserva": reserva["total"],
		},
		"cobertura": dict(cob, efectivo_delegacao=efe["delegacao"], efectivo_categoria=efe["categoria"]),
		"scorecard": scorecard,
		"ocorrencias": ocor,
		"ausencias": dict(aus, reserva=reserva),
		"armamento": arm,
		"gerado_em": frappe.utils.now(),
	}


# ───────────────────────────────────────────────────────────── scope helpers

def _cond(scope, col_deleg=None, col_posto=None, col_cli=None, prefix="s"):
	"""Build (conditions[], params{}) for the given scope against named columns."""
	cond, p = [], {}
	if scope.get("delegacao") and col_deleg:
		cond.append(f"{col_deleg} = %({prefix}_deleg)s"); p[f"{prefix}_deleg"] = scope["delegacao"]
	if scope.get("posto") and col_posto:
		cond.append(f"{col_posto} = %({prefix}_posto)s"); p[f"{prefix}_posto"] = scope["posto"]
	if scope.get("cliente") and col_cli:
		cond.append(f"{col_cli} = %({prefix}_cli)s"); p[f"{prefix}_cli"] = scope["cliente"]
	return cond, p


# ──────────────────────────────────────────────────────────────── cobertura

def _cobertura(de_d, ate_d, scope, trend=True):
	"""
	Per-(day, posto) escalados vs gaps from the published Escala, overlaying
	uncovered Faltas / Suspensão / Licença / Outro and any approved leave (Férias,
	sickness, unpaid, ...). Aggregated in Python into a daily trend and a per-posto
	lacuna ranking.
	"""
	sc, sp = _cond(scope, "po.delegacao", "e.posto_de_vigilancia", "e.cliente")
	rows = frappe.db.sql(
		f"""
		SELECT te.data AS d, e.posto_de_vigilancia AS posto, po.nome_do_posto AS nome,
		       COALESCE(NULLIF(po.delegacao, ''), 'Sem delegação') AS deleg,
		       COUNT(*) AS escalados,
		       SUM(CASE WHEN g.vigilante IS NOT NULL OR EXISTS (
		             SELECT 1 FROM `tabLeave Application` f
		             WHERE f.employee = vv.funcionario AND f.status = 'Approved'
		               AND f.docstatus = 1
		               AND f.from_date <= te.data AND f.to_date >= te.data
		           ) THEN 1 ELSE 0 END) AS gaps
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent AND e.estado = 'Activo'
		JOIN `tabPosto De Vigilancia` po ON po.name = e.posto_de_vigilancia
		JOIN `tabVigilante` vv ON vv.name = te.vigilante
		LEFT JOIN `tabTurno` t ON t.name = te.turno
		LEFT JOIN (
			SELECT a.data AS d, ta.vigilante
			FROM `tabTabela Ausencia` ta
			JOIN `tabAusencias` a ON a.name = ta.parent
			WHERE a.docstatus = 1
			  AND ( (ta.tipo_de_ausencia = 'Falta'
			         AND (ta.proxima_accao IS NULL OR ta.proxima_accao IN ('', 'Sem Acção')))
			        OR ta.tipo_de_ausencia IN ('Suspensão', 'Licença', 'Outro') )
			GROUP BY a.data, ta.vigilante
		) g ON g.vigilante = te.vigilante AND g.d = te.data
		WHERE te.data BETWEEN %(de)s AND %(ate)s
		  AND (t.e_folga IS NULL OR t.e_folga = 0)
		  {('AND ' + ' AND '.join(sc)) if sc else ''}
		GROUP BY te.data, e.posto_de_vigilancia
		""",
		dict(sp, de=de_d, ate=ate_d),
		as_dict=True,
	)

	por_dia, por_posto, por_deleg = {}, {}, {}
	tot_esc = tot_gap = 0
	for r in rows:
		esc, gap = int(r["escalados"]), int(r["gaps"])
		tot_esc += esc; tot_gap += gap
		dd = por_dia.setdefault(str(r["d"]), {"escalados": 0, "gaps": 0})
		dd["escalados"] += esc; dd["gaps"] += gap
		pp = por_posto.setdefault(r["posto"], {"posto": r["posto"], "nome": r["nome"], "escalados": 0, "gaps": 0})
		pp["escalados"] += esc; pp["gaps"] += gap
		pdl = por_deleg.setdefault(r["deleg"], {"k": r["deleg"], "escalados": 0, "gaps": 0})
		pdl["escalados"] += esc; pdl["gaps"] += gap

	media = round((tot_esc - tot_gap) / tot_esc * 100, 1) if tot_esc else 100.0
	out = {"media": media, "gap_slots": tot_gap, "escalados": tot_esc}
	if not trend:
		return out

	dias = []
	d = de_d
	while d <= ate_d:
		v = por_dia.get(str(d), {"escalados": 0, "gaps": 0})
		esc = v["escalados"]
		dias.append({
			"data": d.isoformat(),
			"escalados": esc, "gaps": v["gaps"],
			"pct": round((esc - v["gaps"]) / esc * 100, 1) if esc else None,
		})
		d = getdate(add_days(d, 1))

	top = sorted(por_posto.values(), key=lambda x: (-x["gaps"], -x["escalados"]))
	top = [x for x in top if x["gaps"] > 0][:12]

	deleg = [
		dict(k=v["k"], escalados=v["escalados"], gaps=v["gaps"],
		     pct=round((v["escalados"] - v["gaps"]) / v["escalados"] * 100, 1) if v["escalados"] else None)
		for v in por_deleg.values()
	]

	# Best / worst staffed day in the window (insight callouts).
	validos = [x for x in dias if x["pct"] is not None]
	melhor = max(validos, key=lambda x: x["pct"]) if validos else None
	pior = min(validos, key=lambda x: x["pct"]) if validos else None

	out["trend"] = dias
	out["top_lacunas"] = top
	out["por_delegacao"] = deleg
	out["meta"] = _META_COBERTURA
	out["melhor_dia"] = melhor
	out["pior_dia"] = pior
	return out


def _scorecard(de_d, ate_d, scope, cob_deleg, efe_deleg, reserva_deleg):
	"""
	Per-delegação roll-up — the single regional view a controller scans first:
	cobertura %, efectivo, faltas, ocorrências (+ graves) and reserva, side by side.
	Merges the coverage breakdown with three light grouped queries.
	"""
	sc, sp = _cond(scope, "ta.delegacao", "ta.posto")
	where = "a.docstatus = 1 AND a.data BETWEEN %(de)s AND %(ate)s" + (" AND " + " AND ".join(sc) if sc else "")
	faltas = frappe.db.sql(
		f"""SELECT COALESCE(NULLIF(ta.delegacao, ''), 'Sem delegação') AS k, COUNT(*) AS n
		    FROM `tabTabela Ausencia` ta JOIN `tabAusencias` a ON a.name = ta.parent
		    WHERE {where} AND ta.tipo_de_ausencia = 'Falta' GROUP BY k""",
		dict(sp, de=de_d, ate=ate_d), as_dict=True,
	)
	sc2, sp2 = _cond(scope, "delegacao", "posto", "cliente")
	where2 = "data BETWEEN %(de)s AND %(ate)s" + (" AND " + " AND ".join(sc2) if sc2 else "")
	ocor = frappe.db.sql(
		f"""SELECT COALESCE(NULLIF(delegacao, ''), 'Sem delegação') AS k, COUNT(*) AS n,
		           SUM(gravidade IN ('Alta', 'Crítica')) AS graves
		    FROM `tabOcorrencia` WHERE {where2} GROUP BY k""",
		dict(sp2, de=de_d, ate=ate_d), as_dict=True,
	)

	rows = {}

	def slot(k):
		return rows.setdefault(k, {
			"delegacao": k, "efectivo": 0, "escalados": 0, "cobertura": None,
			"faltas": 0, "ocorrencias": 0, "graves": 0, "reserva": 0,
		})

	for r in cob_deleg:
		s = slot(r["k"]); s["cobertura"] = r["pct"]; s["escalados"] = r["escalados"]
	for r in efe_deleg:
		slot(r["k"])["efectivo"] = int(r["n"])
	for r in faltas:
		slot(r["k"])["faltas"] = int(r["n"])
	for r in ocor:
		s = slot(r["k"]); s["ocorrencias"] = int(r["n"]); s["graves"] = int(r["graves"] or 0)
	for r in reserva_deleg:
		slot(r["k"])["reserva"] = int(r["n"])

	out = list(rows.values())
	# Worst coverage first (None = no escala → last), then by efectivo desc.
	out.sort(key=lambda r: (r["cobertura"] if r["cobertura"] is not None else 999, -r["efectivo"]))
	return out


def _efectivo(scope):
	sc, sp = _cond(scope, "delegacao", "posto_de_vigilancia", "cliente")
	base = "status = 'Activo'" + (" AND " + " AND ".join(sc) if sc else "")
	deleg = frappe.db.sql(
		f"""SELECT COALESCE(delegacao, 'Sem delegação') AS k, COUNT(*) AS n
		    FROM `tabVigilante` WHERE {base} GROUP BY delegacao ORDER BY n DESC""",
		sp, as_dict=True,
	)
	cat = frappe.db.sql(
		f"""SELECT COALESCE(categoria, 'Sem categoria') AS k, COUNT(*) AS n
		    FROM `tabVigilante` WHERE {base} GROUP BY categoria ORDER BY n DESC""",
		sp, as_dict=True,
	)
	return {"delegacao": deleg, "categoria": cat}


# ──────────────────────────────────────────────────────────────── ocorrências

def _ocorrencias(de_d, ate_d, scope, resumo=False):
	sc, sp = _cond(scope, "delegacao", "posto", "cliente")
	where = "data BETWEEN %(de)s AND %(ate)s" + (" AND " + " AND ".join(sc) if sc else "")
	params = dict(sp, de=de_d, ate=ate_d)

	total = frappe.db.sql(f"SELECT COUNT(*) FROM `tabOcorrencia` WHERE {where}", params)[0][0]
	graves = frappe.db.sql(
		f"SELECT COUNT(*) FROM `tabOcorrencia` WHERE {where} AND gravidade IN ('Alta', 'Crítica')", params
	)[0][0]
	if resumo:
		return {"total": total, "graves": graves}

	trend = frappe.db.sql(
		f"SELECT data AS d, COUNT(*) AS n FROM `tabOcorrencia` WHERE {where} GROUP BY data ORDER BY data",
		params, as_dict=True,
	)
	por_grav = frappe.db.sql(
		f"SELECT gravidade AS k, COUNT(*) AS n FROM `tabOcorrencia` WHERE {where} GROUP BY gravidade", params, as_dict=True
	)
	por_tipo = frappe.db.sql(
		f"""SELECT COALESCE(NULLIF(tipo, ''), 'Outro') AS k, COUNT(*) AS n
		    FROM `tabOcorrencia` WHERE {where} GROUP BY tipo ORDER BY n DESC""", params, as_dict=True
	)
	por_estado = frappe.db.sql(
		f"SELECT estado AS k, COUNT(*) AS n FROM `tabOcorrencia` WHERE {where} GROUP BY estado", params, as_dict=True
	)
	resol = frappe.db.sql(
		f"""SELECT AVG(DATEDIFF(data_resolucao, data)) AS d, COUNT(*) AS n
		    FROM `tabOcorrencia` WHERE {where} AND data_resolucao IS NOT NULL""", params, as_dict=True
	)[0]
	top_postos = frappe.db.sql(
		f"""SELECT posto AS posto, COALESCE(posto_nome, posto) AS nome, COUNT(*) AS n
		    FROM `tabOcorrencia` WHERE {where} AND posto IS NOT NULL AND posto <> ''
		    GROUP BY posto ORDER BY n DESC LIMIT 10""", params, as_dict=True
	)
	top_vig = frappe.db.sql(
		f"""SELECT o.vigilante AS vigilante, COALESCE(v.nome_completo, o.vigilante) AS nome, COUNT(*) AS n
		    FROM `tabOcorrencia` o LEFT JOIN `tabVigilante` v ON v.name = o.vigilante
		    WHERE {where.replace('data', 'o.data')} AND o.vigilante IS NOT NULL AND o.vigilante <> ''
		    GROUP BY o.vigilante ORDER BY n DESC LIMIT 10""", params, as_dict=True
	)

	return {
		"total": total, "graves": graves,
		"trend": trend, "por_gravidade": por_grav, "por_tipo": por_tipo, "por_estado": por_estado,
		"tempo_resolucao": round(flt(resol.get("d")), 1) if resol.get("n") else None,
		"resolvidas": int(resol.get("n") or 0),
		"top_postos": top_postos, "top_vigilantes": top_vig,
	}


# ──────────────────────────────────────────────────────────────── ausências

def _ausencias(de_d, ate_d, scope, resumo=False):
	sc, sp = _cond(scope, "ta.delegacao", "ta.posto")
	join = "JOIN `tabAusencias` a ON a.name = ta.parent"
	where = "a.docstatus = 1 AND a.data BETWEEN %(de)s AND %(ate)s" + (" AND " + " AND ".join(sc) if sc else "")
	params = dict(sp, de=de_d, ate=ate_d)

	faltas = frappe.db.sql(
		f"""SELECT COUNT(*) FROM `tabTabela Ausencia` ta {join}
		    WHERE {where} AND ta.tipo_de_ausencia = 'Falta'""", params
	)[0][0]
	subst = frappe.db.sql(
		f"""SELECT COUNT(*) FROM `tabTabela Ausencia` ta {join}
		    WHERE {where} AND ta.tipo_de_ausencia = 'Falta' AND ta.proxima_accao IN %(accoes)s""",
		dict(params, accoes=_ACCAO_COBERTA),
	)[0][0]
	taxa = round(subst / faltas * 100, 1) if faltas else 0.0
	if resumo:
		return {"taxa_substituicao": taxa, "faltas": faltas}

	trend = frappe.db.sql(
		f"""SELECT a.data AS d, COUNT(*) AS n FROM `tabTabela Ausencia` ta {join}
		    WHERE {where} AND ta.tipo_de_ausencia = 'Falta' GROUP BY a.data ORDER BY a.data""",
		params, as_dict=True,
	)
	por_tipo = frappe.db.sql(
		f"""SELECT COALESCE(NULLIF(ta.tipo_de_ausencia, ''), 'Outro') AS k, COUNT(*) AS n
		    FROM `tabTabela Ausencia` ta {join} WHERE {where} GROUP BY ta.tipo_de_ausencia ORDER BY n DESC""",
		params, as_dict=True,
	)
	top_vig = frappe.db.sql(
		f"""SELECT ta.vigilante AS vigilante, COALESCE(ta.nome_do_vigilante, ta.vigilante) AS nome,
		           ta.delegacao AS delegacao, COUNT(*) AS n
		    FROM `tabTabela Ausencia` ta {join}
		    WHERE {where} AND ta.tipo_de_ausencia = 'Falta' AND ta.vigilante IS NOT NULL AND ta.vigilante <> ''
		    GROUP BY ta.vigilante ORDER BY n DESC LIMIT 12""",
		params, as_dict=True,
	)
	return {
		"taxa_substituicao": taxa, "faltas": faltas, "substituidas": subst,
		"trend": trend, "por_tipo": por_tipo, "top_vigilantes": top_vig,
	}


def _reserva(scope):
	sc, sp = _cond(scope, "delegacao", "posto_de_vigilancia", "cliente")
	base = "status = 'Reserva'" + (" AND " + " AND ".join(sc) if sc else "")
	total = frappe.db.sql(f"SELECT COUNT(*) FROM `tabVigilante` WHERE {base}", sp)[0][0]
	por_deleg = frappe.db.sql(
		f"""SELECT COALESCE(delegacao, 'Sem delegação') AS k, COUNT(*) AS n
		    FROM `tabVigilante` WHERE {base} GROUP BY delegacao ORDER BY n DESC""",
		sp, as_dict=True,
	)
	return {"total": total, "por_delegacao": por_deleg}


# ──────────────────────────────────────────────────────────────── armamento

def _armamento(scope):
	sc, sp = _cond(scope, "delegacao", "posto")
	base = (" WHERE " + " AND ".join(sc)) if sc else ""
	tot = frappe.db.sql(
		f"""SELECT
		      COUNT(*) AS total,
		      SUM(estado = 'Operacional') AS operacionais,
		      SUM(estado = 'Em Manutenção') AS manutencao,
		      SUM(estado = 'Abatida') AS abatidas,
		      SUM(estado = 'Operacional' AND posto IS NOT NULL AND posto <> '') AS alocadas
		    FROM `tabArma`{base}""",
		sp, as_dict=True,
	)[0]
	total = int(tot.get("total") or 0)
	operac = int(tot.get("operacionais") or 0)
	alocadas = int(tot.get("alocadas") or 0)
	por_deleg = frappe.db.sql(
		f"""SELECT COALESCE(delegacao, 'Sem delegação') AS k,
		           COUNT(*) AS total,
		           SUM(estado = 'Operacional' AND posto IS NOT NULL AND posto <> '') AS alocadas
		    FROM `tabArma`{base} GROUP BY delegacao ORDER BY total DESC""",
		sp, as_dict=True,
	)
	por_tipo = frappe.db.sql(
		f"""SELECT COALESCE(NULLIF(tipo, ''), 'Outro') AS k, COUNT(*) AS n
		    FROM `tabArma`{base} GROUP BY tipo ORDER BY n DESC""",
		sp, as_dict=True,
	)
	return {
		"total": total, "operacionais": operac, "manutencao": int(tot.get("manutencao") or 0),
		"abatidas": int(tot.get("abatidas") or 0),
		"alocadas": alocadas, "disponiveis": operac - alocadas,
		"por_delegacao": [dict(r, alocadas=int(r["alocadas"] or 0), total=int(r["total"])) for r in por_deleg],
		"por_tipo": por_tipo,
	}
