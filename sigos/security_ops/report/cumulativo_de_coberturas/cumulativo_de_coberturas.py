"""
Cumulativo de Coberturas — what RH owes each guard for the extra shifts they were
called in to cover in one payroll month.

A cover is a submitted Ausencias row (Tabela Ausencia) whose proxima_accao names a
covering guard: Dobra de Turno / Meia Dobra / Horas Extras. Substituto (a Reserva
guard filling a post) and Adiantamento de Turno are excluded — neither is paid extra.

The period is the payroll period of the chosen Mês/Ano (utils.resolver_periodo_folha,
honours dia_corte_folha). Pricing is always proportional to each guard's own base
(latest submitted Salary Structure Assignment): every covered day = base / days in
the period, Meia Dobra = half. SIGOS Settings gates/métodos/fixed values are
deliberately NOT applied here yet (a Settings-driven variant is planned).
"""
import frappe
from frappe import _
from frappe.utils import getdate, date_diff, flt, nowdate, formatdate

from sigos.utils import resolver_periodo_folha


# proxima_accao -> Tabela Ausencia field holding the covering guard
ACCOES = {
	"Dobra de Turno":        "vigilante_a_dobrar",
	"Meia Dobra":            "vigilante_a_meia_dobra",
	"Horas Extras":          "vigilante_a_horas_extras",
}
_COL = {
	"Dobra de Turno": "dobras",
	"Meia Dobra": "meias_dobras",
	"Horas Extras": "horas_extras",
}
MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
         "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"]


def execute(filters=None):
	filters = filters or {}
	hoje = getdate(nowdate())
	mes = MESES.index(filters["mes"]) + 1 if filters.get("mes") in MESES else hoje.month
	ano = int(filters.get("ano") or hoje.year)
	de, ate = resolver_periodo_folha(mes, ano)

	dias = date_diff(ate, de) + 1

	linhas = {}
	for r in _coberturas(de, ate, filters):
		l = linhas.setdefault(r.cobridor, {
			"vigilante": r.cobridor, "nome_do_vigilante": r.nome,
			"delegacao": r.delegacao, "categoria": r.categoria, "funcionario": r.funcionario,
			"dobras": 0, "meias_dobras": 0, "horas_extras": 0,
		})
		l[_COL[r.accao]] += int(r.n)

	bases = _bases(filter(None, (l["funcionario"] for l in linhas.values())), ate)
	for l in linhas.values():
		base = flt(bases.get(l["funcionario"]))
		diario = base / dias if dias else 0
		l["total_dias"] = l["dobras"] + l["meias_dobras"] + l["horas_extras"]
		l["salario_base"] = base
		# Every cover = one day's pay (base / days in the period); Meia Dobra = half.
		dias_pagos = l["dobras"] + l["horas_extras"] + 0.5 * l["meias_dobras"]
		l["valor_extra"] = round(diario * dias_pagos, 2)
		l["total"] = round(base + l["valor_extra"], 2)

	data = sorted(linhas.values(), key=lambda l: (-l["valor_extra"], l["nome_do_vigilante"] or ""))
	sem_base = sum(1 for l in data if not l["salario_base"])
	return _columns(), data, _mensagem(de, ate, dias, sem_base)


# ─────────────────────────────────────────────────────────────── data

def _coberturas(de, ate, filters):
	accoes = [filters["accao"]] if filters.get("accao") in ACCOES else list(ACCOES)
	case = " ".join(f"WHEN '{a}' THEN ta.{ACCOES[a]}" for a in accoes)
	params = {"de": de, "ate": ate, "accoes": tuple(accoes)}

	cond = ""
	if filters.get("vigilante"):
		cond += " AND c.cobridor = %(vig)s"; params["vig"] = filters["vigilante"]
	if filters.get("delegacao"):
		cond += " AND v.delegacao = %(deleg)s"; params["deleg"] = filters["delegacao"]

	return frappe.db.sql(
		f"""
		SELECT c.cobridor, c.accao, COUNT(*) AS n,
		       v.nome_completo AS nome, v.delegacao, v.categoria, v.funcionario
		FROM (
			SELECT CASE ta.proxima_accao {case} END AS cobridor, ta.proxima_accao AS accao
			FROM `tabTabela Ausencia` ta
			JOIN `tabAusencias` a ON a.name = ta.parent
			WHERE a.docstatus = 1
			  AND a.data BETWEEN %(de)s AND %(ate)s
			  AND ta.proxima_accao IN %(accoes)s
		) c
		JOIN `tabVigilante` v ON v.name = c.cobridor
		WHERE c.cobridor IS NOT NULL AND c.cobridor <> '' {cond}
		GROUP BY c.cobridor, c.accao
		""",
		params,
		as_dict=True,
	)


def _bases(funcionarios, ate):
	"""{employee: base} from each Employee's latest submitted SSA effective by `ate`."""
	funcionarios = tuple(set(funcionarios))
	if not funcionarios:
		return {}
	rows = frappe.db.sql(
		"""
		SELECT ssa.employee, ssa.base
		FROM `tabSalary Structure Assignment` ssa
		JOIN (
			SELECT employee, MAX(from_date) AS from_date
			FROM `tabSalary Structure Assignment`
			WHERE docstatus = 1 AND employee IN %(emps)s AND from_date <= %(ate)s
			GROUP BY employee
		) ult ON ult.employee = ssa.employee AND ult.from_date = ssa.from_date
		WHERE ssa.docstatus = 1
		ORDER BY ssa.creation
		""",
		{"emps": funcionarios, "ate": ate},
		as_dict=True,
	)
	return {r.employee: r.base for r in rows}   # latest-created wins on a same-day tie


# ──────────────────────────────────────────────────────────── output

def _mensagem(de, ate, dias, sem_base):
	partes = [_("Período de folha: <b>{0}</b> a <b>{1}</b> ({2} dias). "
	            "Cada dia coberto = Salário Base / {2}; Meia Dobra = metade.").format(
		formatdate(de), formatdate(ate), dias)]
	if sem_base:
		partes.append(_("<b>{0}</b> vigilante(s) sem Salário Base (sem Salary Structure Assignment "
		                "submetido) — extras a 0.").format(sem_base))
	return "<br>".join(partes)


def _columns():
	return [
		{"label": _("Vigilante"), "fieldname": "vigilante", "fieldtype": "Link", "options": "Vigilante", "width": 120},
		{"label": _("Nome do Vigilante"), "fieldname": "nome_do_vigilante", "fieldtype": "Data", "width": 220},
		{"label": _("Delegação"), "fieldname": "delegacao", "fieldtype": "Link", "options": "Delegacao", "width": 120},
		{"label": _("Total Dias"), "fieldname": "total_dias", "fieldtype": "Int", "width": 100},
		{"label": _("Dobras"), "fieldname": "dobras", "fieldtype": "Int", "width": 80},
		{"label": _("Meias Dobras"), "fieldname": "meias_dobras", "fieldtype": "Int", "width": 100},
		{"label": _("Horas Extras"), "fieldname": "horas_extras", "fieldtype": "Int", "width": 100},
		{"label": _("Salário Base"), "fieldname": "salario_base", "fieldtype": "Currency", "width": 140},
		{"label": _("Total Extras"), "fieldname": "valor_extra", "fieldtype": "Currency", "width": 140},
		{"label": _("Total (Base + Extras)"), "fieldname": "total", "fieldtype": "Currency", "width": 160},
	]
