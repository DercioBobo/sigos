"""
Cumulativo de Coberturas — what RH owes each guard for the extra shifts they were
called in to cover in one payroll month.

A cover is a submitted Ausencias row (Tabela Ausencia) whose proxima_accao names a
covering guard: Dobra de Turno / Adiantamento de Turno / Meia Dobra / Horas Extras.
Substituto is excluded — that's a Reserva guard filling a post, not paid extra (same
rule as utils.calcular_dobras_vigilante).

The period is the payroll period of the chosen Mês/Ano (utils.resolver_periodo_folha,
honours dia_corte_folha) and the pricing mirrors salary_slip_hooks._add_dobras /
_add_meia_dobra / _add_horas_extras exactly — same SIGOS Settings gates, métodos and
fixed values, base = the guard's Salary Structure Assignment base (what the slip
pays on) — so this report shows what the Salary Slip will credit.
"""
import frappe
from frappe import _
from frappe.utils import getdate, date_diff, flt, nowdate, formatdate

from sigos.utils import resolver_periodo_folha


# proxima_accao -> Tabela Ausencia field holding the covering guard
ACCOES = {
	"Dobra de Turno":        "vigilante_a_dobrar",
	"Adiantamento de Turno": "vigilante_a_adiantar",
	"Meia Dobra":            "vigilante_a_meia_dobra",
	"Horas Extras":          "vigilante_a_horas_extras",
}
_COL = {
	"Dobra de Turno": "dobras",
	"Adiantamento de Turno": "adiantamentos",
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

	s = frappe.get_single("SIGOS Settings")
	dias = _dias_do_periodo(s, de, ate)

	linhas = {}
	for r in _coberturas(de, ate, filters):
		l = linhas.setdefault(r.cobridor, {
			"vigilante": r.cobridor, "nome_do_vigilante": r.nome,
			"delegacao": r.delegacao, "categoria": r.categoria, "funcionario": r.funcionario,
			"dobras": 0, "adiantamentos": 0, "meias_dobras": 0, "horas_extras": 0,
		})
		l[_COL[r.accao]] += int(r.n)

	bases = _bases(filter(None, (l["funcionario"] for l in linhas.values())), ate)
	for l in linhas.values():
		base = flt(bases.get(l["funcionario"]))
		diario = base / dias if dias else 0
		l["salario_base"] = base
		l["valor_diario"] = round(diario, 2)
		l["valor_dobras"] = _valor_dobras(s, l["dobras"] + l["adiantamentos"], diario)
		l["valor_meias_dobras"] = _valor_meias(s, l["meias_dobras"], diario)
		l["valor_horas_extras"] = _valor_he(s, l["horas_extras"], diario)
		l["valor_extra"] = round(l["valor_dobras"] + l["valor_meias_dobras"] + l["valor_horas_extras"], 2)
		l["total"] = round(base + l["valor_extra"], 2)

	data = sorted(linhas.values(), key=lambda l: (-l["valor_extra"], l["nome_do_vigilante"] or ""))
	return _columns(), data, _mensagem(s, de, ate, dias)


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


# ───────────────────────────────────────── pricing (mirror of the slip)

def _dias_do_periodo(s, de, ate):
	# Slip divisor = days in the period ("Dias do Mês"). "Dias Úteis (HRMS)" depends on
	# the slip's own holiday list, so the report approximates it with period days too.
	return date_diff(ate, de) + 1


def _proporcional(metodo):
	return (metodo or "Proporcional ao Salário") == "Proporcional ao Salário"


def _valor_dobras(s, n, diario):
	if not s.dobras_activo or n <= 0:
		return 0
	if _proporcional(s.metodo_calculo_dobra):
		return round(diario * n, 2)
	return round(n * flt(s.valor_fixo_por_dobra), 2)


def _valor_meias(s, n, diario):
	if not s.dobras_activo or n <= 0:
		return 0
	if _proporcional(s.metodo_calculo_dobra):
		return round(diario * n * 0.5, 2)
	return round(n * flt(s.valor_fixo_por_meia_dobra), 2)


def _valor_he(s, n, diario):
	if not s.horas_extras_activo or n <= 0:
		return 0
	if _proporcional(s.metodo_calculo_horas_extras):
		return round(diario * n, 2)
	return round(n * flt(s.valor_fixo_por_horas_extras), 2)


# ──────────────────────────────────────────────────────────── output

def _mensagem(s, de, ate, dias):
	partes = [_("Período de folha: <b>{0}</b> a <b>{1}</b> ({2} dias).").format(
		formatdate(de), formatdate(ate), dias)]
	if not s.dobras_activo:
		partes.append(_("Dobras / Adiantamentos / Meias Dobras estão <b>desactivados</b> em SIGOS Settings — valor 0."))
	if not s.horas_extras_activo:
		partes.append(_("Horas Extras estão <b>desactivadas</b> em SIGOS Settings — valor 0."))
	return "<br>".join(partes)


def _columns():
	cur = {"fieldtype": "Currency", "width": 120}
	return [
		{"label": _("Vigilante"), "fieldname": "vigilante", "fieldtype": "Link", "options": "Vigilante", "width": 120},
		{"label": _("Nome do Vigilante"), "fieldname": "nome_do_vigilante", "fieldtype": "Data", "width": 190},
		{"label": _("Delegação"), "fieldname": "delegacao", "fieldtype": "Link", "options": "Delegacao", "width": 110},
		{"label": _("Categoria"), "fieldname": "categoria", "fieldtype": "Data", "width": 120},
		{"label": _("Dobras"), "fieldname": "dobras", "fieldtype": "Int", "width": 75},
		{"label": _("Adiantamentos"), "fieldname": "adiantamentos", "fieldtype": "Int", "width": 105},
		{"label": _("Meias Dobras"), "fieldname": "meias_dobras", "fieldtype": "Int", "width": 100},
		{"label": _("Horas Extras"), "fieldname": "horas_extras", "fieldtype": "Int", "width": 100},
		{"label": _("Salário Base"), "fieldname": "salario_base", **cur},
		{"label": _("Valor Diário"), "fieldname": "valor_diario", **cur, "width": 105},
		{"label": _("Valor Dobras"), "fieldname": "valor_dobras", **cur, "width": 110},
		{"label": _("Valor Meias Dobras"), "fieldname": "valor_meias_dobras", **cur, "width": 130},
		{"label": _("Valor Horas Extras"), "fieldname": "valor_horas_extras", **cur, "width": 130},
		{"label": _("Valor Extra"), "fieldname": "valor_extra", **cur},
		{"label": _("Total (Base + Extra)"), "fieldname": "total", **cur, "width": 140},
	]
