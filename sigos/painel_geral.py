"""
SIGOS - Painel Geral (General Dashboard).

Port of the old SIXS "Central de Operacoes" page onto the SIGOS data model:
headline KPIs, demissoes / rotatividades / ausencias time series (daily, weekly,
monthly), distribution by cliente / delegacao, the +N faltas alert list and the
system-users activity table. All read-only aggregates.

Time series are fetched as one GROUP BY day query per source and bucketed in
Python (days / ISO weeks starting Monday / calendar months), so every
granularity shares the same zero-filled logic.

The page (`painel-geral`) calls these on load / filter change / refresh.
"""
import frappe
from frappe.utils import getdate, nowdate, add_days, add_months, date_diff, get_datetime, now_datetime

from sigos.utils import calcular_faltas_detalhado


_MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
          "Jul", "Ago", "Set", "Out", "Nov", "Dez"]

# Each source = (FROM ... WHERE fragment, date column). docstatus=1 = submitted/approved.
_FONTES = {
	"demissoes": ("`tabDemissao` WHERE docstatus = 1", "data_de_demissao"),
	"rotatividades": ("`tabRotatividade` WHERE docstatus = 1", "data"),
	"ausencias": (
		"`tabTabela Ausencia` ta JOIN `tabAusencias` a ON a.name = ta.parent WHERE a.docstatus = 1",
		"a.data",
	),
	"admissoes": ("`tabVigilante` WHERE 1 = 1", "data_admissao"),
}


# SIGOS categorias (Categoria Vigilante fixtures) + supervisor = tipo OR categoria.
_CAT_ARMADOS = ("Vigilante Armado",)
_CAT_NORMAIS = ("Vigilante Normal",)
_SUPERVISOR = "(tipo_de_vigilante = 'Supervisor' OR categoria = 'Supervisor')"


def _guard():
	from sigos.api import PAPEIS_INTERNOS
	frappe.only_for(PAPEIS_INTERNOS)


def _int(v, default, lo, hi):
	try:
		v = int(v)
	except (TypeError, ValueError):
		v = default
	return max(lo, min(v, hi))


def _status_cond(status, alias=""):
	"""SQL fragment + params for the Activos / Inactivos / Todos pill."""
	col = f"{alias}status"
	if status in ("Activo", "Inactivo", "Reserva"):
		return f"{col} = %(status)s", {"status": status}
	return "1 = 1", {}


# ─────────────────────────────────────────────────────────── time series

def _por_dia(fonte, desde):
	"""{date: n} for one source since `desde` (inclusive)."""
	tabela, col = _FONTES[fonte]
	rows = frappe.db.sql(
		f"""SELECT DATE({col}) AS d, COUNT(*) AS n FROM {tabela}
		    AND {col} >= %(desde)s AND {col} <= %(ate)s GROUP BY d""",
		{"desde": desde, "ate": getdate(nowdate())}, as_dict=True,
	)
	return {getdate(r.d): int(r.n) for r in rows if r.d}


def _serie_diaria(fonte, days):
	days = _int(days, 90, 7, 366)
	hoje = getdate(nowdate())
	inicio = add_days(hoje, -(days - 1))
	idx = _por_dia(fonte, inicio)
	labels, values = [], []
	for i in range(days):
		d = add_days(inicio, i)
		labels.append(d.strftime("%d/%m"))
		values.append(idx.get(d, 0))
	return {"labels": labels, "values": values}


def _serie_semanal(fonte, weeks):
	weeks = _int(weeks, 12, 4, 104)
	hoje = getdate(nowdate())
	seg = add_days(hoje, -hoje.weekday())             # Monday of the current week
	inicio = add_days(seg, -7 * (weeks - 1))
	idx = _por_dia(fonte, inicio)
	values = [0] * weeks
	for d, n in idx.items():
		i = date_diff(d, inicio) // 7
		if 0 <= i < weeks:
			values[i] += n
	labels = ["Sem " + add_days(inicio, 7 * i).strftime("%d/%m") for i in range(weeks)]
	return {"labels": labels, "values": values}


def _meses(months):
	"""(first_day, ['YYYY-MM'...], ['Jan 26'...]) for the last `months` incl. current."""
	months = _int(months, 12, 1, 36)
	hoje = getdate(nowdate())
	inicio = add_months(getdate(f"{hoje.year}-{hoje.month:02d}-01"), -(months - 1))
	keys, labels, d = [], [], inicio
	for _ in range(months):
		keys.append(f"{d.year:04d}-{d.month:02d}")
		labels.append(f"{_MESES[d.month - 1]} {str(d.year)[2:]}")
		d = add_months(d, 1)
	return inicio, keys, labels


def _serie_mensal(fonte, months):
	inicio, keys, labels = _meses(months)
	acc = dict.fromkeys(keys, 0)
	for d, n in _por_dia(fonte, inicio).items():
		k = f"{d.year:04d}-{d.month:02d}"
		if k in acc:
			acc[k] += n
	return {"labels": labels, "values": [acc[k] for k in keys]}


@frappe.whitelist()
def get_serie(fonte, granularidade="mensal", n=None):
	"""Generic time series: fonte in demissoes/rotatividades/ausencias/admissoes,
	granularidade in diaria (n=days) / semanal (n=weeks) / mensal (n=months)."""
	_guard()
	if fonte not in _FONTES:
		frappe.throw(f"Fonte desconhecida: {fonte}")
	if granularidade == "diaria":
		return _serie_diaria(fonte, n or 90)
	if granularidade == "semanal":
		return _serie_semanal(fonte, n or 12)
	return _serie_mensal(fonte, n or 12)


@frappe.whitelist()
def get_admitidos_demitidos(months=12):
	_guard()
	adm = _serie_mensal("admissoes", months)
	dem = _serie_mensal("demissoes", months)
	return {"labels": adm["labels"], "admitidos": adm["values"], "demitidos": dem["values"]}


# ─────────────────────────────────────────────────────────────── cards

@frappe.whitelist()
def get_cards_summary():
	_guard()
	v = frappe.db.sql(
		"""
		SELECT
		  SUM(status = 'Activo')                                        AS activos,
		  SUM(status = 'Reserva')                                       AS reservas,
		  SUM(status = 'Activo' AND sexo = 'Feminino')                  AS mulheres,
		  SUM(status = 'Activo' AND sexo = 'Masculino')                 AS homens,
		  SUM(status = 'Activo' AND categoria IN %(armados)s)           AS armados,
		  SUM(status = 'Activo' AND categoria IN %(normais)s)           AS simples,
		  SUM(status = 'Activo' AND {sup})                              AS supervisores,
		  COUNT(DISTINCT CASE WHEN status = 'Activo' AND COALESCE(cliente, '') <> '' THEN cliente END) AS clientes
		FROM `tabVigilante`
		""".format(sup=_SUPERVISOR),
		{"armados": _CAT_ARMADOS, "normais": _CAT_NORMAIS},
		as_dict=True,
	)[0]
	postos = frappe.db.sql(
		"""SELECT COUNT(*) AS total, SUM(estado = 'Activo') AS activos
		   FROM `tabPosto De Vigilancia`""",
		as_dict=True,
	)[0]
	# Administrativos are pure Employees (ADM-.##): active Employees with no Vigilante.
	administrativos = frappe.db.count(
		"Employee", {"status": "Active", "custom_vigilante": ["is", "not set"]}
	)
	# One KPI per Regime actually in use (Regime is a configurable master).
	regimes = frappe.db.sql(
		"""SELECT regime_do_vigilante AS k, COUNT(*) AS n FROM `tabVigilante`
		   WHERE status = 'Activo' AND COALESCE(regime_do_vigilante, '') <> ''
		   GROUP BY regime_do_vigilante ORDER BY n DESC""",
		as_dict=True,
	)
	out = {k: int(v.get(k) or 0) for k in
	       ("activos", "reservas", "mulheres", "homens", "armados", "simples", "supervisores", "clientes")}
	out.update({
		"administrativos": int(administrativos or 0),
		"postos": int(postos.total or 0),
		"postos_activos": int(postos.activos or 0),
		"regimes": [{"k": r.k, "n": int(r.n)} for r in regimes],
	})
	return out


# ──────────────────────────────────────────────────────── por cliente

def _nome_cliente_sql(col):
	return f"COALESCE(NULLIF(c.customer_name, ''), {col})"


@frappe.whitelist()
def get_vigilantes_por_cliente(status="Activo", limit=10, offset=0, search=""):
	"""Vigilantes grouped by cliente. Top-N for the chart + paginated/searchable table."""
	_guard()
	limit = _int(limit, 10, 1, 200)
	offset = _int(offset, 0, 0, 100000)
	cond, p = _status_cond(status, "v.")
	p["q"] = f"%{search.strip()}%" if search and search.strip() else None
	busca = f"AND {_nome_cliente_sql('v.cliente')} LIKE %(q)s" if p["q"] else ""

	base = f"""FROM `tabVigilante` v LEFT JOIN `tabCustomer` c ON c.name = v.cliente
	           WHERE {cond} AND COALESCE(v.cliente, '') <> '' {busca}"""
	total_vig = frappe.db.sql(
		f"""SELECT COUNT(*) FROM `tabVigilante` v WHERE {cond} AND COALESCE(v.cliente, '') <> ''""", p
	)[0][0] or 0
	total_clients = frappe.db.sql(f"SELECT COUNT(DISTINCT v.cliente) {base}", p)[0][0] or 0
	rows = frappe.db.sql(
		f"""SELECT v.cliente, {_nome_cliente_sql('v.cliente')} AS nome, COUNT(*) AS total
		    {base} GROUP BY v.cliente ORDER BY total DESC, nome
		    LIMIT {limit} OFFSET {offset}""",
		p, as_dict=True,
	)
	return {
		"total_clients": int(total_clients),
		"total": int(total_clients),
		"rows": [{
			"cliente": r.cliente, "nome": r.nome, "total": int(r.total),
			"pct": round(100.0 * r.total / total_vig, 1) if total_vig else 0,
		} for r in rows],
	}


def _rot_base(months, search):
	inicio, keys, labels = _meses(months)
	p = {"inicio": inicio, "q": f"%{search.strip()}%" if search and search.strip() else None}
	# Client of the guard's original posto: fetched copy on the doc, else via the posto.
	cli = "COALESCE(NULLIF(r.cliente_antigo_posto, ''), pv.cliente)"
	frm = f"""FROM `tabRotatividade` r
	          LEFT JOIN `tabPosto De Vigilancia` pv ON pv.name = r.antigo_posto
	          LEFT JOIN `tabCustomer` c ON c.name = {cli}
	          WHERE r.docstatus = 1 AND r.data >= %(inicio)s AND {cli} IS NOT NULL AND {cli} <> ''"""
	if p["q"]:
		frm += f" AND {_nome_cliente_sql(cli)} LIKE %(q)s"
	return cli, frm, p, keys, labels


@frappe.whitelist()
def get_rotatividades_por_cliente(months=6, top=10):
	"""Stacked monthly rotatividades for the top-N clientes of the window."""
	_guard()
	top = _int(top, 10, 1, 20)
	cli, frm, p, keys, labels = _rot_base(months, "")
	total_clients = frappe.db.sql(f"SELECT COUNT(DISTINCT {cli}) {frm}", p)[0][0] or 0
	tops = frappe.db.sql(
		f"""SELECT {cli} AS cli_key, {_nome_cliente_sql(cli)} AS nome, COUNT(*) AS n
		    {frm} GROUP BY cli_key ORDER BY n DESC LIMIT {top}""",
		p, as_dict=True,
	)
	if not tops:
		return {"labels": labels, "series": [], "total_clients": int(total_clients)}
	p["clientes"] = tuple(t.cli_key for t in tops)
	rows = frappe.db.sql(
		f"""SELECT {cli} AS cli_key, DATE_FORMAT(r.data, '%%Y-%%m') AS ym, COUNT(*) AS n
		    {frm} AND {cli} IN %(clientes)s GROUP BY cli_key, ym""",
		p, as_dict=True,
	)
	grid = {(r.cli_key, r.ym): int(r.n) for r in rows}
	return {
		"labels": labels,
		"series": [{"name": t.nome, "data": [grid.get((t.cli_key, k), 0) for k in keys]} for t in tops],
		"total_clients": int(total_clients),
	}


@frappe.whitelist()
def get_rot_por_cliente_table(months=6, limit=20, offset=0, search=""):
	_guard()
	limit = _int(limit, 20, 1, 200)
	offset = _int(offset, 0, 0, 100000)
	cli, frm, p, _k, _l = _rot_base(months, search)
	total = frappe.db.sql(f"SELECT COUNT(DISTINCT {cli}) {frm}", p)[0][0] or 0
	rows = frappe.db.sql(
		f"""SELECT {cli} AS cli_key, {_nome_cliente_sql(cli)} AS nome,
		           COUNT(*) AS total, MAX(r.data) AS ultima_data
		    {frm} GROUP BY cli_key ORDER BY total DESC, nome
		    LIMIT {limit} OFFSET {offset}""",
		p, as_dict=True,
	)
	return {"total": int(total), "rows": [
		{"cliente": r.cli_key, "nome": r.nome, "total": int(r.total), "ultima_data": r.ultima_data}
		for r in rows
	]}


# ─────────────────────────────────────────────────────── por delegacao

def _hbar(rows):
	return {"labels": [r.k for r in rows], "values": [int(r.n or 0) for r in rows]}


@frappe.whitelist()
def get_armas_por_delegacao():
	_guard()
	return _hbar(frappe.db.sql(
		"""SELECT COALESCE(NULLIF(a.delegacao, ''), NULLIF(p.delegacao, ''), 'Sem delegacao') AS k,
		          COUNT(*) AS n
		   FROM `tabArma` a LEFT JOIN `tabPosto De Vigilancia` p ON p.name = a.posto
		   GROUP BY k ORDER BY n DESC""",
		as_dict=True,
	))


@frappe.whitelist()
def get_reservas_por_delegacao():
	_guard()
	return _hbar(frappe.db.sql(
		"""SELECT COALESCE(NULLIF(delegacao, ''), 'Sem delegacao') AS k, COUNT(*) AS n
		   FROM `tabVigilante` WHERE status = 'Reserva' GROUP BY k ORDER BY n DESC""",
		as_dict=True,
	))


@frappe.whitelist()
def get_supervisores_por_delegacao(status="Activo"):
	_guard()
	cond, p = _status_cond(status)
	return _hbar(frappe.db.sql(
		f"""SELECT COALESCE(NULLIF(delegacao, ''), 'Sem delegacao') AS k, COUNT(*) AS n
		    FROM `tabVigilante` WHERE {_SUPERVISOR} AND {cond}
		    GROUP BY k ORDER BY n DESC""",
		p, as_dict=True,
	))


@frappe.whitelist()
def get_feriadores_por_delegacao():
	"""Guards on an APPROVED leave (any Leave Type) covering today, by delegacao —
	same rule as the live board's _ferias_do_dia."""
	_guard()
	return _hbar(frappe.db.sql(
		"""SELECT COALESCE(NULLIF(v.delegacao, ''), 'Sem delegacao') AS k,
		          COUNT(DISTINCT v.name) AS n
		   FROM `tabLeave Application` la
		   JOIN `tabVigilante` v ON v.funcionario = la.employee
		   WHERE la.status = 'Approved' AND la.docstatus = 1
		     AND la.from_date <= %(hoje)s AND la.to_date >= %(hoje)s
		   GROUP BY k ORDER BY n DESC""",
		{"hoje": getdate(nowdate())}, as_dict=True,
	))


# ─────────────────────────────────────────────────────────────── faltas

@frappe.whitelist()
def get_vigilantes_muitas_faltas(min_faltas=8, months=6, status="Activo"):
	"""Guards with MORE THAN min_faltas effective faltas in the window (same counting as the
	Cumulativo de Faltas report). Only guards with an absence in-window are computed."""
	_guard()
	min_faltas = _int(min_faltas, 8, 1, 365)
	months = _int(months, 6, 1, 24)
	ate = getdate(nowdate())
	de = add_months(ate, -months)
	cond, p = _status_cond(status, "v.")
	p.update({"de": de, "ate": ate})

	vigs = frappe.db.sql(
		f"""SELECT DISTINCT v.name, v.nome_completo, v.posto_de_vigilancia AS posto,
		           pv.nome_do_posto AS posto_nome, v.delegacao, v.status
		    FROM `tabTabela Ausencia` ta
		    JOIN `tabAusencias` a ON a.name = ta.parent
		    JOIN `tabVigilante` v ON v.name = ta.vigilante
		    LEFT JOIN `tabPosto De Vigilancia` pv ON pv.name = v.posto_de_vigilancia
		    WHERE a.docstatus = 1 AND a.data BETWEEN %(de)s AND %(ate)s AND {cond}""",
		p, as_dict=True,
	)
	out = []
	for v in vigs:
		total = sum(r["n_de_faltas"] for r in calcular_faltas_detalhado(v.name, de, ate))
		if total > min_faltas:
			out.append({
				"vigilante": v.name, "nome_completo": v.nome_completo, "posto": v.posto, "posto_nome": v.posto_nome,
				"delegacao": v.delegacao, "status": v.status, "total_faltas": total,
			})
	out.sort(key=lambda r: r["total_faltas"], reverse=True)
	return out


# ──────────────────────────────────────────────────────────────── users

@frappe.whitelist()
def get_users_ativos():
	"""Enabled desk users + days since last activity. Managers only (it exposes
	other people's access history); everyone else gets allowed=False."""
	_guard()
	roles = set(frappe.get_roles())
	if not roles & {"System Manager", "SIGOS Manager"}:
		return {"allowed": False, "rows": []}
	agora = now_datetime()
	rows = frappe.db.sql(
		"""SELECT name AS user, full_name, last_active FROM `tabUser`
		   WHERE enabled = 1 AND user_type = 'System User'
		     AND name NOT IN ('Administrator', 'Guest')
		   ORDER BY last_active IS NULL, last_active DESC""",
		as_dict=True,
	)
	for r in rows:
		r["dias_desde_acesso"] = (
			(agora.date() - get_datetime(r.last_active).date()).days if r.last_active else None
		)
	return {"allowed": True, "rows": rows}
