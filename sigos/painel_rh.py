"""
SIGOS - Painel Estatistico (Recursos Humanos).

Statistical / management dashboard for the security workforce: headcount
composition (categoria, regime, sexo, delegacao), 12-month movement (admissoes,
demissoes, rotatividades, ausencias), armamento and client portfolio, plus the
absence alert list. All read-only aggregate queries, cheap and indexed.

The page (`painel-estatistico`) calls these on load / period change / refresh.
"""
import frappe
from frappe.utils import getdate, nowdate, add_months

from sigos.utils import calcular_faltas_detalhado


_MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
          "Jul", "Ago", "Set", "Out", "Nov", "Dez"]


# ───────────────────────────────────────────────────────────── month helpers

def _month_buckets(months):
    """Return (start_date, ['2026-01', ...], ['Jan', ...]) for the last `months`."""
    months = max(1, min(int(months or 12), 36))
    today = getdate(nowdate())
    cur = getdate(f"{today.year}-{today.month:02d}-01")
    start = add_months(cur, -(months - 1))
    keys, labels, d = [], [], start
    for _ in range(months):
        keys.append(f"{d.year:04d}-{d.month:02d}")
        labels.append(f"{_MESES[d.month - 1]} {str(d.year)[2:]}")
        d = add_months(d, 1)
    return start, keys, labels


def _series(rows, keys, k="ym", v="n"):
    """Align grouped SQL rows (keyed 'YYYY-MM') onto the bucket order, zero-filled."""
    idx = {r[k]: int(r[v] or 0) for r in rows}
    return [idx.get(key, 0) for key in keys]


# ─────────────────────────────────────────────────────────────────── cards

@frappe.whitelist()
def get_cards():
    """Headline KPIs + the secondary ledger strip."""
    v = frappe.db.sql(
        """
        SELECT
          SUM(status = 'Activo')                                       AS activos,
          SUM(status = 'Reserva')                                      AS reservas,
          SUM(status = 'Activo' AND sexo = 'Feminino')                 AS mulheres,
          SUM(status = 'Activo' AND sexo = 'Masculino')                AS homens,
          SUM(status = 'Activo' AND categoria = 'Vigilante Armado')    AS armados,
          SUM(status = 'Activo' AND tipo_de_vigilante = 'Supervisor')  AS supervisores,
          SUM(status = 'Activo' AND categoria = 'Administrativo')       AS administrativos,
          COUNT(DISTINCT CASE WHEN status = 'Activo' THEN cliente END) AS clientes
        FROM `tabVigilante`
        """,
        as_dict=True,
    )[0]

    postos = frappe.db.sql(
        """SELECT COUNT(*) AS total, SUM(estado = 'Activo') AS activos
           FROM `tabPosto De Vigilancia`""",
        as_dict=True,
    )[0]

    # Movement deltas vs the previous full month (admissoes / demissoes this month)
    today = getdate(nowdate())
    ini_mes = getdate(f"{today.year}-{today.month:02d}-01")
    admit_mes = frappe.db.count("Vigilante", {"data_admissao": [">=", ini_mes]})
    demit_mes = frappe.db.count("Demissao", {"docstatus": 1, "data_de_demissao": [">=", ini_mes]})

    return {
        "activos":         int(v.activos or 0),
        "reservas":        int(v.reservas or 0),
        "armados":         int(v.armados or 0),
        "mulheres":        int(v.mulheres or 0),
        "homens":          int(v.homens or 0),
        "supervisores":    int(v.supervisores or 0),
        "administrativos": int(v.administrativos or 0),
        "clientes":        int(v.clientes or 0),
        "postos_total":    int(postos.total or 0),
        "postos_activos":  int(postos.activos or 0),
        "delegacoes":      frappe.db.count("Delegacao"),
        "armas":           frappe.db.count("Arma"),
        "admitidos_mes":   admit_mes,
        "demitidos_mes":   demit_mes,
    }


# ───────────────────────────────────────────────────────────── composicao

@frappe.whitelist()
def get_composicao(status="Activo"):
    """Distribution of the active workforce by categoria, regime, sexo, delegacao."""
    base = "status = %(st)s" if status and status != "Todos" else "1 = 1"
    p = {"st": status}

    def grp(col, label_null):
        return frappe.db.sql(
            f"""SELECT COALESCE(NULLIF({col}, ''), %(nul)s) AS k, COUNT(*) AS n
                FROM `tabVigilante` WHERE {base}
                GROUP BY k ORDER BY n DESC""",
            dict(p, nul=label_null), as_dict=True,
        )

    return {
        "categoria":  grp("categoria",          "Sem categoria"),
        "regime":     grp("regime_do_vigilante", "Sem regime"),
        "delegacao":  grp("delegacao",           "Sem delegacao"),
        "sexo":       grp("sexo",                "N/D"),
        "clientes":   frappe.db.sql(
            f"""SELECT COALESCE(NULLIF(MAX(nome_do_projecto), ''), cliente) AS k, COUNT(*) AS n
                FROM `tabVigilante` WHERE {base} AND cliente IS NOT NULL AND cliente <> ''
                GROUP BY cliente ORDER BY n DESC LIMIT 8""",
            p, as_dict=True,
        ),
    }


# ────────────────────────────────────────────────────────────── movimento

@frappe.whitelist()
def get_movimento(months=12):
    """12-month (default) movement: admissoes vs demissoes, rotatividades, ausencias."""
    start, keys, labels = _month_buckets(months)
    p = {"start": start}

    admit = frappe.db.sql(
        """SELECT DATE_FORMAT(data_admissao, '%%Y-%%m') AS ym, COUNT(*) AS n
           FROM `tabVigilante` WHERE data_admissao >= %(start)s GROUP BY ym""",
        p, as_dict=True,
    )
    demit = frappe.db.sql(
        """SELECT DATE_FORMAT(data_de_demissao, '%%Y-%%m') AS ym, COUNT(*) AS n
           FROM `tabDemissao` WHERE docstatus = 1 AND data_de_demissao >= %(start)s GROUP BY ym""",
        p, as_dict=True,
    )
    rot = frappe.db.sql(
        """SELECT DATE_FORMAT(data, '%%Y-%%m') AS ym, COUNT(*) AS n
           FROM `tabRotatividade` WHERE docstatus = 1 AND data >= %(start)s GROUP BY ym""",
        p, as_dict=True,
    )
    aus = frappe.db.sql(
        """SELECT DATE_FORMAT(a.data, '%%Y-%%m') AS ym, COUNT(*) AS n
           FROM `tabTabela Ausencia` ta JOIN `tabAusencias` a ON a.name = ta.parent
           WHERE a.docstatus = 1 AND a.data >= %(start)s GROUP BY ym""",
        p, as_dict=True,
    )
    rot_tipo = frappe.db.sql(
        """SELECT COALESCE(NULLIF(o.operacao, ''), r.abreviatura_op) AS k, COUNT(*) AS n
           FROM `tabRotatividade` r
           LEFT JOIN `tabOperacao De Rotatividade` o ON o.name = r.abreviatura_op
           WHERE r.docstatus = 1 AND r.data >= %(start)s
           GROUP BY r.abreviatura_op ORDER BY n DESC""",
        p, as_dict=True,
    )

    return {
        "labels":      labels,
        "admitidos":   _series(admit, keys),
        "demitidos":   _series(demit, keys),
        "rotatividades": _series(rot, keys),
        "ausencias":   _series(aus, keys),
        "rot_por_tipo": [{"k": r.k, "n": int(r.n)} for r in rot_tipo],
    }


# ────────────────────────────────────────────────────────────── armamento

@frappe.whitelist()
def get_armas():
    """Weapons by delegacao (total + deployed)."""
    por_deleg = frappe.db.sql(
        """SELECT COALESCE(NULLIF(delegacao, ''), 'Sem delegacao') AS k,
                  COUNT(*) AS n,
                  SUM(estado = 'Operacional' AND posto IS NOT NULL AND posto <> '') AS alocadas
           FROM `tabArma` GROUP BY delegacao ORDER BY n DESC""",
        as_dict=True,
    )
    return {"por_delegacao": [
        {"k": r.k, "n": int(r.n), "alocadas": int(r.alocadas or 0)} for r in por_deleg
    ]}


# ───────────────────────────────────────────────────────────────── faltas

@frappe.whitelist()
def get_faltas(min_faltas=8, months=6):
    """
    Guards over `min_faltas` absences in the window. Reuses the Cumulativo de Faltas
    approach: only compute for guards who actually have a submitted absence in-window.
    """
    min_faltas = int(min_faltas or 8)
    start, _keys, _labels = _month_buckets(months)
    ate = getdate(nowdate())

    vigs = frappe.db.sql(
        """SELECT DISTINCT ta.vigilante
           FROM `tabTabela Ausencia` ta JOIN `tabAusencias` a ON a.name = ta.parent
           WHERE a.docstatus = 1 AND a.data BETWEEN %(de)s AND %(ate)s""",
        {"de": start, "ate": ate}, as_dict=True,
    )

    out = []
    for v in vigs:
        total = sum(r["n_de_faltas"] for r in calcular_faltas_detalhado(v.vigilante, start, ate))
        if total >= min_faltas:
            info = frappe.db.get_value(
                "Vigilante", v.vigilante,
                ["nome_completo", "posto_de_vigilancia", "delegacao", "status"],
                as_dict=True,
            ) or {}
            out.append({
                "vigilante":      v.vigilante,
                "nome_completo":  info.get("nome_completo"),
                "posto":          info.get("posto_de_vigilancia"),
                "delegacao":      info.get("delegacao"),
                "status":         info.get("status"),
                "total_faltas":   total,
            })

    out.sort(key=lambda r: r["total_faltas"], reverse=True)
    return out
