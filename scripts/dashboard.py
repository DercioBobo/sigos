import frappe
from frappe.utils import getdate, nowdate
from datetime import datetime, timedelta


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _from(days=0, weeks=0, months=0):
    today = getdate(nowdate())
    return str(today - timedelta(days=days + weeks * 7 + months * 30))


def _fill_daily(rows, days):
    today   = getdate(nowdate())
    dmap    = {str(r["dt"]): r["total"] for r in rows}
    labels, values = [], []
    cur = today - timedelta(days=int(days))
    while cur <= today:
        labels.append(cur.strftime("%d/%m"))
        values.append(dmap.get(str(cur), 0))
        cur += timedelta(days=1)
    return {"labels": labels, "values": values}


def _fill_weekly(rows):
    labels, values = [], []
    for r in rows:
        ws = getdate(str(r["week_start"]))
        labels.append(f"Sem {ws.strftime('%d/%m')}")
        values.append(r["total"])
    return {"labels": labels, "values": values}


def _fill_monthly(rows):
    labels = [datetime.strptime(r["period"], "%Y-%m").strftime("%b %Y") for r in rows]
    return {"labels": labels, "values": [r["total"] for r in rows]}


def _pivot_client(rows):
    periods = sorted(set(r["period"] for r in rows))
    clients = list(dict.fromkeys(r["cliente"] for r in rows))[:10]
    dmap    = {(r["period"], r["cliente"]): r["total"] for r in rows}
    labels  = [datetime.strptime(p, "%Y-%m").strftime("%b %Y") for p in periods]
    series  = [{"name": c, "data": [dmap.get((p, c), 0) for p in periods]} for c in clients]
    return {"labels": labels, "series": series}


# ─── Cards ────────────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_cards_summary():
    def scalar(sql, params=None):
        return frappe.db.sql(sql, params or {})[0][0] or 0

    def by_categoria(cats):
        c = ", ".join(f"'{x}'" for x in cats)
        return scalar(f"""
            SELECT COUNT(*) FROM `tabVigilante` v
            INNER JOIN `tabCategoria Do Vigilante` cdv ON cdv.name = v.categoria
            WHERE v.status = 'Ativo' AND cdv.categoria IN ({c})
        """)

    def by_regime(abbrs):
        a = ", ".join(f"'{x}'" for x in abbrs)
        return scalar(f"""
            SELECT COUNT(*) FROM `tabVigilante` v
            INNER JOIN `tabRegime do Vigilante` r ON r.name = v.regime_do_vigilante
            WHERE v.status = 'Ativo' AND r.abreviatura IN ({a})
        """)

    return {
        "clientes":      scalar("SELECT COUNT(*) FROM `tabCustomer` WHERE disabled = 0"),
        "ativos":        scalar("SELECT COUNT(*) FROM `tabVigilante` WHERE status = 'Ativo'"),
        "mulheres":      scalar("SELECT COUNT(*) FROM `tabVigilante` WHERE status = 'Ativo' AND sexo = 'Feminino'"),
        "homens":        scalar("SELECT COUNT(*) FROM `tabVigilante` WHERE status = 'Ativo' AND sexo = 'Masculino'"),
        "armados":       by_categoria(["Vigilante Armado", "Reação Armada"]),
        "simples":       by_categoria(["Vigilante Normal"]),
        "reservas":      by_categoria(["Reserva"]),
        "administrativos": by_categoria(["Administrativo"]),
        "postos":        scalar("SELECT COUNT(*) FROM `tabPosto de Vigilancia`"),
        "postos_ativos": scalar("SELECT COUNT(*) FROM `tabPosto de Vigilancia` WHERE estado = 'Ativo'"),
        "tdu":           by_regime(["TDU", "TDU-MT"]),
        "h24":           by_regime(["H24", "H24 A", "24"]),
        "tdn":           by_regime(["TDN"]),
    }


# ─── Demissões ────────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_demissoes_diarias(days=30):
    rows = frappe.db.sql("""
        SELECT data_de_demissao AS dt, COUNT(*) AS total
        FROM `tabDemissao`
        WHERE docstatus < 2 AND data_de_demissao >= %(fd)s
        GROUP BY data_de_demissao ORDER BY data_de_demissao
    """, {"fd": _from(days=int(days))}, as_dict=True)
    return _fill_daily(rows, int(days))


@frappe.whitelist()
def get_demissoes_semanais(weeks=12):
    rows = frappe.db.sql("""
        SELECT YEARWEEK(data_de_demissao,1) AS yw,
               MIN(data_de_demissao)        AS week_start,
               COUNT(*)                     AS total
        FROM `tabDemissao`
        WHERE docstatus < 2 AND data_de_demissao >= %(fd)s
        GROUP BY yw ORDER BY yw
    """, {"fd": _from(weeks=int(weeks))}, as_dict=True)
    return _fill_weekly(rows)


# ─── Rotatividades ────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_rotatividades_diarias(days=30):
    rows = frappe.db.sql("""
        SELECT data AS dt, COUNT(*) AS total
        FROM `tabRotatividade`
        WHERE docstatus < 2 AND data >= %(fd)s
        GROUP BY data ORDER BY data
    """, {"fd": _from(days=int(days))}, as_dict=True)
    return _fill_daily(rows, int(days))


@frappe.whitelist()
def get_rotatividades_semanais(weeks=12):
    rows = frappe.db.sql("""
        SELECT YEARWEEK(data,1) AS yw, MIN(data) AS week_start, COUNT(*) AS total
        FROM `tabRotatividade`
        WHERE docstatus < 2 AND data >= %(fd)s
        GROUP BY yw ORDER BY yw
    """, {"fd": _from(weeks=int(weeks))}, as_dict=True)
    return _fill_weekly(rows)


@frappe.whitelist()
def get_rotatividades_mensais(months=12):
    rows = frappe.db.sql("""
        SELECT DATE_FORMAT(data,'%%Y-%%m') AS period, COUNT(*) AS total
        FROM `tabRotatividade`
        WHERE docstatus < 2 AND data >= %(fd)s
        GROUP BY period ORDER BY period
    """, {"fd": _from(months=int(months))}, as_dict=True)
    return _fill_monthly(rows)


@frappe.whitelist()
def get_rotatividades_por_cliente(months=6):
    """Top 10 clients stacked chart + total client count for badge."""
    rows = frappe.db.sql("""
        SELECT DATE_FORMAT(data,'%%Y-%%m')                        AS period,
               COALESCE(NULLIF(cliente_antigo_posto,''), 'N/D')   AS cliente,
               COUNT(*)                                           AS total
        FROM `tabRotatividade`
        WHERE docstatus < 2 AND data >= %(fd)s
        GROUP BY period, cliente_antigo_posto
        ORDER BY period, total DESC
    """, {"fd": _from(months=int(months))}, as_dict=True)
    result = _pivot_client(rows)
    total_clients = frappe.db.sql("""
        SELECT COUNT(DISTINCT COALESCE(cliente_antigo_posto,''))
        FROM `tabRotatividade`
        WHERE docstatus < 2 AND data >= %(fd)s
    """, {"fd": _from(months=int(months))})[0][0] or 0
    result["total_clients"] = total_clients
    return result


@frappe.whitelist()
def get_rot_por_cliente_table(months=6, limit=20, offset=0, search=""):
    """Paginated per-client totals for Option B expandable table."""
    like   = f"%{search}%" if search else "%"
    fd     = _from(months=int(months))
    params = {"fd": fd, "like": like, "limit": int(limit), "offset": int(offset)}

    rows = frappe.db.sql("""
        SELECT COALESCE(NULLIF(cliente_antigo_posto,''),'N/D') AS cliente,
               COUNT(*) AS total,
               MAX(data) AS ultima_data
        FROM `tabRotatividade`
        WHERE docstatus < 2 AND data >= %(fd)s
          AND COALESCE(cliente_antigo_posto,'') LIKE %(like)s
        GROUP BY cliente_antigo_posto
        ORDER BY total DESC
        LIMIT %(limit)s OFFSET %(offset)s
    """, params, as_dict=True)

    total = frappe.db.sql("""
        SELECT COUNT(DISTINCT COALESCE(cliente_antigo_posto,'N/D'))
        FROM `tabRotatividade`
        WHERE docstatus < 2 AND data >= %(fd)s
          AND COALESCE(cliente_antigo_posto,'') LIKE %(like)s
    """, {"fd": fd, "like": like})[0][0] or 0

    return {"rows": rows, "total": total,
            "has_more": int(offset) + int(limit) < total}


# ─── Ausências ────────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_ausencias_semanais(weeks=12):
    rows = frappe.db.sql("""
        SELECT YEARWEEK(a.data,1) AS yw, MIN(a.data) AS week_start,
               COUNT(ta.name)     AS total
        FROM `tabAusencias` a
        INNER JOIN `tabTabela Ausencia` ta ON ta.parent = a.name
        WHERE a.docstatus < 2 AND a.data >= %(fd)s
        GROUP BY yw ORDER BY yw
    """, {"fd": _from(weeks=int(weeks))}, as_dict=True)
    return _fill_weekly(rows)


@frappe.whitelist()
def get_ausencias_mensais(months=12):
    rows = frappe.db.sql("""
        SELECT DATE_FORMAT(a.data,'%%Y-%%m') AS period, COUNT(ta.name) AS total
        FROM `tabAusencias` a
        INNER JOIN `tabTabela Ausencia` ta ON ta.parent = a.name
        WHERE a.docstatus < 2 AND a.data >= %(fd)s
        GROUP BY period ORDER BY period
    """, {"fd": _from(months=int(months))}, as_dict=True)
    return _fill_monthly(rows)


# ─── Distribuição ─────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_vigilantes_por_cliente(status="Ativo"):
    """Top 10 for chart + total client count for badge."""
    sc = "AND status = %(status)s" if status != "Todos" else ""
    p  = {"status": status}
    rows = frappe.db.sql(f"""
        SELECT COALESCE(NULLIF(cliente,''), 'Sem Cliente') AS cliente,
               COUNT(*) AS total
        FROM `tabVigilante`
        WHERE 1=1 {sc}
        GROUP BY cliente ORDER BY total DESC LIMIT 10
    """, p, as_dict=True)
    total_clients = frappe.db.sql(f"""
        SELECT COUNT(DISTINCT COALESCE(cliente,''))
        FROM `tabVigilante` WHERE 1=1 {sc}
    """, p)[0][0] or 0
    return {
        "labels":        [r["cliente"] for r in rows],
        "values":        [r["total"]   for r in rows],
        "total_clients": total_clients,
    }


@frappe.whitelist()
def get_vigilantes_por_cliente_table(status="Ativo", limit=20, offset=0, search=""):
    """Paginated full list for Option B expandable table."""
    like = f"%{search}%" if search else "%"
    sc   = "AND status = %(status)s" if status != "Todos" else ""
    p    = {"like": like, "limit": int(limit), "offset": int(offset), "status": status}

    rows = frappe.db.sql(f"""
        SELECT COALESCE(NULLIF(cliente,''),'Sem Cliente') AS cliente,
               COUNT(*) AS total
        FROM `tabVigilante`
        WHERE 1=1 {sc} AND COALESCE(cliente,'') LIKE %(like)s
        GROUP BY cliente ORDER BY total DESC
        LIMIT %(limit)s OFFSET %(offset)s
    """, p, as_dict=True)

    total = frappe.db.sql(f"""
        SELECT COUNT(DISTINCT COALESCE(cliente,'Sem Cliente'))
        FROM `tabVigilante`
        WHERE 1=1 {sc} AND COALESCE(cliente,'') LIKE %(like)s
    """, p)[0][0] or 0

    grand = frappe.db.sql(f"""
        SELECT COUNT(*) FROM `tabVigilante` WHERE 1=1 {sc}
    """, p)[0][0] or 1

    for r in rows:
        r["pct"] = round(r["total"] / grand * 100, 1)

    return {"rows": rows, "total": total,
            "has_more": int(offset) + int(limit) < total}


@frappe.whitelist()
def get_armas_por_delegacao():
    rows = frappe.db.sql("""
        SELECT COALESCE(NULLIF(a.`delegação`,''), p.delegacao, 'Sem Delegação') AS delegacao,
               COUNT(*) AS total
        FROM `tabArma` a
        LEFT JOIN `tabPosto de Vigilancia` p ON p.name = a.posto
        GROUP BY delegacao ORDER BY total DESC
    """, as_dict=True)
    return {"labels": [r["delegacao"] for r in rows], "values": [r["total"] for r in rows]}


@frappe.whitelist()
def get_admitidos_demitidos(months=12):
    fd = _from(months=int(months))

    admitidos = frappe.db.sql("""
        SELECT DATE_FORMAT(data_admissao,'%%Y-%%m') AS period, COUNT(*) AS total
        FROM `tabVigilante`
        WHERE data_admissao >= %(fd)s
        GROUP BY period ORDER BY period
    """, {"fd": fd}, as_dict=True)

    demitidos = frappe.db.sql("""
        SELECT DATE_FORMAT(data_de_demissao,'%%Y-%%m') AS period, COUNT(*) AS total
        FROM `tabDemissao`
        WHERE docstatus < 2 AND data_de_demissao >= %(fd)s
        GROUP BY period ORDER BY period
    """, {"fd": fd}, as_dict=True)

    periods = sorted(set([r["period"] for r in admitidos] + [r["period"] for r in demitidos]))
    adm_map = {r["period"]: r["total"] for r in admitidos}
    dem_map = {r["period"]: r["total"] for r in demitidos}

    labels = [datetime.strptime(p, "%Y-%m").strftime("%b %Y") for p in periods]
    return {
        "labels":    labels,
        "admitidos": [adm_map.get(p, 0) for p in periods],
        "demitidos": [dem_map.get(p, 0) for p in periods],
    }


def _by_delegacao_cat(cat_name, status="Ativo"):
    sc = "AND v.status = %(status)s" if status != "Todos" else ""
    rows = frappe.db.sql(f"""
        SELECT COALESCE(NULLIF(v.delegacao,''), 'Sem Delegação') AS delegacao,
               COUNT(*) AS total
        FROM `tabVigilante` v
        INNER JOIN `tabCategoria Do Vigilante` c ON c.name = v.categoria
        WHERE c.categoria = %(cat)s {sc}
        GROUP BY v.delegacao ORDER BY total DESC
    """, {"cat": cat_name, "status": status}, as_dict=True)
    return {"labels": [r["delegacao"] for r in rows], "values": [r["total"] for r in rows]}


@frappe.whitelist()
def get_reservas_por_delegacao(status="Ativo"):
    return _by_delegacao_cat("Reserva", status)


@frappe.whitelist()
def get_feriadores_por_delegacao(status="Ativo"):
    return _by_delegacao_cat("Feriador", status)


@frappe.whitelist()
def get_supervisores_por_delegacao():
    rows = frappe.db.sql("""
        SELECT COALESCE(NULLIF(delegacao,''), 'Sem Delegação') AS delegacao,
               COUNT(*) AS total
        FROM `tabSupervisor`
        GROUP BY delegacao ORDER BY total DESC
    """, as_dict=True)
    return {"labels": [r["delegacao"] for r in rows], "values": [r["total"] for r in rows]}


# ─── Alertas ──────────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_vigilantes_muitas_faltas(min_faltas=8, status="Ativo", months=None):
    sc = "AND v.status = %(status)s" if status != "Todos" else ""
    pc = "AND a.data >= %(fd)s"      if months           else ""
    params = {"mf": int(min_faltas), "status": status}
    if months:
        params["fd"] = _from(months=int(months))
    return frappe.db.sql(f"""
        SELECT v.nome_completo,
               v.name           AS vigilante,
               v.delegacao,
               p.nome_do_posto  AS posto,
               SUM(ta.n_de_faltas) AS total_faltas
        FROM `tabVigilante` v
        INNER JOIN `tabTabela Ausencia` ta ON ta.vigilante = v.name
        INNER JOIN `tabAusencias`       a  ON a.name = ta.parent
        LEFT JOIN  `tabPosto de Vigilancia` p ON p.name = v.posto_de_vigilancia
        WHERE a.docstatus < 2 {sc} {pc}
        GROUP BY v.name
        HAVING SUM(ta.n_de_faltas) > %(mf)s
        ORDER BY total_faltas DESC
    """, params, as_dict=True)


@frappe.whitelist()
def get_users_ativos():
    return frappe.db.sql("""
        SELECT name AS user, full_name, last_active,
               CASE WHEN last_active IS NULL THEN NULL
                    ELSE DATEDIFF(NOW(), last_active) END AS dias_desde_acesso
        FROM `tabUser`
        WHERE enabled = 1 AND name NOT IN ('Guest','Administrator')
        ORDER BY last_active DESC
    """, as_dict=True)
