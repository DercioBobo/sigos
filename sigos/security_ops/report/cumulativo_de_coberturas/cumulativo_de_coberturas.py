"""
Cumulativo de Coberturas — how many times each guard was CALLED IN to cover someone
else's absence, month by month.

A cover is a submitted Ausencias row (Tabela Ausencia) whose proxima_accao names a
covering guard: Substituto / Dobra de Turno / Meia Dobra / Adiantamento de Turno /
Horas Extras — each action keeps the covering guard in its own Link field. One row =
one cover. Delegação / Vigilante filters apply to the COVERING guard.

Output: one line per covering guard, a column per month in the range, a total, and
the total split by acção.
"""
import frappe
from frappe import _
from frappe.utils import getdate, add_months, get_first_day, get_last_day, today


# proxima_accao -> (Tabela Ausencia field holding the covering guard, column fieldname)
ACCOES = {
	"Substituto":            ("vigilante_substituto",     "substituto"),
	"Dobra de Turno":        ("vigilante_a_dobrar",       "dobra"),
	"Meia Dobra":            ("vigilante_a_meia_dobra",   "meia_dobra"),
	"Adiantamento de Turno": ("vigilante_a_adiantar",     "adiantamento"),
	"Horas Extras":          ("vigilante_a_horas_extras", "horas_extras"),
}

_MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]


def execute(filters=None):
	filters = filters or {}
	de = getdate(filters.get("de_data") or get_first_day(today()))
	ate = getdate(filters.get("ate_data") or get_last_day(today()))
	if de > ate:
		frappe.throw(_("A data 'De' não pode ser posterior à data 'Até'."))

	meses = _meses(de, ate)
	rows = _coberturas(de, ate, filters)

	por_vig = {}
	for r in rows:
		linha = por_vig.setdefault(r.cobridor, {
			"vigilante": r.cobridor,
			"nome_do_vigilante": r.nome,
			"delegacao": r.delegacao,
			"categoria": r.categoria,
			"total": 0,
			**{m["fieldname"]: 0 for m in meses},
			**{col: 0 for _f, col in ACCOES.values()},
		})
		n = int(r.n)
		linha[f"m_{r.ym.replace('-', '_')}"] += n
		linha[ACCOES[r.accao][1]] += n
		linha["total"] += n

	data = sorted(por_vig.values(), key=lambda l: (-l["total"], l["nome_do_vigilante"] or ""))
	return _columns(meses), data, None, _chart(meses, data)


def _meses(de, ate):
	"""Month columns covering [de, ate]."""
	out, d = [], get_first_day(de)
	while d <= ate:
		out.append({
			"fieldname": f"m_{d.year:04d}_{d.month:02d}",
			"label": f"{_MESES[d.month - 1]} {str(d.year)[2:]}",
		})
		d = add_months(d, 1)
	return out


def _coberturas(de, ate, filters):
	accoes = [filters["accao"]] if filters.get("accao") in ACCOES else list(ACCOES)
	case = " ".join(f"WHEN '{a}' THEN ta.{ACCOES[a][0]}" for a in accoes)
	params = {"de": de, "ate": ate, "accoes": tuple(accoes)}

	cond = ""
	if filters.get("vigilante"):
		cond += " AND c.cobridor = %(vig)s"; params["vig"] = filters["vigilante"]
	if filters.get("delegacao"):
		cond += " AND v.delegacao = %(deleg)s"; params["deleg"] = filters["delegacao"]

	return frappe.db.sql(
		f"""
		SELECT c.cobridor, c.accao, c.ym, COUNT(*) AS n,
		       v.nome_completo AS nome, v.delegacao, v.categoria
		FROM (
			SELECT CASE ta.proxima_accao {case} END AS cobridor,
			       ta.proxima_accao AS accao,
			       DATE_FORMAT(a.data, '%%Y-%%m') AS ym
			FROM `tabTabela Ausencia` ta
			JOIN `tabAusencias` a ON a.name = ta.parent
			WHERE a.docstatus = 1
			  AND a.data BETWEEN %(de)s AND %(ate)s
			  AND ta.proxima_accao IN %(accoes)s
		) c
		JOIN `tabVigilante` v ON v.name = c.cobridor
		WHERE c.cobridor IS NOT NULL AND c.cobridor <> '' {cond}
		GROUP BY c.cobridor, c.accao, c.ym
		""",
		params,
		as_dict=True,
	)


def _columns(meses):
	cols = [
		{"label": _("Vigilante"), "fieldname": "vigilante", "fieldtype": "Link", "options": "Vigilante", "width": 120},
		{"label": _("Nome do Vigilante"), "fieldname": "nome_do_vigilante", "fieldtype": "Data", "width": 190},
		{"label": _("Delegação"), "fieldname": "delegacao", "fieldtype": "Link", "options": "Delegacao", "width": 120},
		{"label": _("Categoria"), "fieldname": "categoria", "fieldtype": "Data", "width": 130},
	]
	cols += [{"label": m["label"], "fieldname": m["fieldname"], "fieldtype": "Int", "width": 75} for m in meses]
	cols.append({"label": _("Total"), "fieldname": "total", "fieldtype": "Int", "width": 80})
	cols += [
		{"label": _(accao), "fieldname": col, "fieldtype": "Int", "width": 110}
		for accao, (_f, col) in ACCOES.items()
	]
	return cols


def _chart(meses, data):
	if not data:
		return None
	return {
		"data": {
			"labels": [m["label"] for m in meses],
			"datasets": [{"name": _("Coberturas"), "values": [sum(l[m["fieldname"]] for l in data) for m in meses]}],
		},
		"type": "bar",
		"colors": ["#4F46E5"],
	}
