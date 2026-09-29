"""
Salários e Subsídios Atribuídos — what each employee is assigned to receive every
month: base salary + recurring subsídios, and the total.

Base = the latest submitted Salary Structure Assignment (what the slip pays on).
Subsídios = exactly what payroll would add, by running ONLY the subsídio hooks of
salary_slip_hooks (projecto matrix, Subsídio de Arma, Subsídios por Categoria/Função)
on an in-memory Salary Slip that is never inserted — same single source of truth,
so this report can't drift from the slip. Month-specific items (faltas, dobras,
Outras Remunerações, deduções) are deliberately out: this is the fixed assignment.
"""
import re
import unicodedata

import frappe
from frappe import _
from frappe.utils import flt, nowdate

from sigos.payroll_ext import salary_slip_hooks as ssh


def execute(filters=None):
	filters = frappe._dict(filters or {})
	emps = _funcionarios(filters)
	bases = _ssa(tuple(e.name for e in emps))

	data, componentes = [], []
	for e in emps:
		ssa = bases.get(e.name)
		base = flt(ssa.base) if ssa else 0
		subsidios = _subsidios(e, ssa)
		for c in subsidios:
			if c not in componentes:
				componentes.append(c)
		total_sub = round(sum(subsidios.values()), 2)
		data.append({
			"funcionario": e.name,
			"nome": e.employee_name,
			"mecanografico": e.custom_mecanografico,
			"delegacao": e.custom_delegacao,
			"salario_base": base,
			"total_subsidios": total_sub,
			"total": round(base + total_sub, 2),
			**{_campo(c): v for c, v in subsidios.items()},
		})

	componentes.sort()
	for r in data:                       # zero-fill so every row has every column
		for c in componentes:
			r.setdefault(_campo(c), 0)
	return _columns(componentes), data


def _funcionarios(filters):
	f = {}
	if filters.situacao != "Todos":
		f["status"] = "Active"
	if filters.delegacao:
		f["custom_delegacao"] = filters.delegacao
	if filters.cliente:
		f["custom_cliente"] = filters.cliente
	if filters.funcionario:
		f["name"] = filters.funcionario
	return frappe.get_all(
		"Employee", filters=f,
		fields=["name", "employee_name", "company", "custom_mecanografico", "custom_delegacao",
		        "custom_vigilante", "custom_categoria"],
		order_by="employee_name asc",
	)


def _ssa(emps):
	"""{employee: {salary_structure, base}} — latest submitted SSA in force today."""
	if not emps:
		return {}
	out = {}
	for r in frappe.get_all(
		"Salary Structure Assignment",
		filters={"employee": ["in", emps], "docstatus": 1, "from_date": ["<=", nowdate()]},
		fields=["employee", "salary_structure", "base", "from_date"],
		order_by="from_date asc, creation asc",     # later rows overwrite → latest wins
	):
		out[r.employee] = r
	return out


def _subsidios(e, ssa):
	"""Run only the slip's subsídio hooks on a never-inserted Salary Slip."""
	if not e.custom_vigilante:
		return {}                         # subsídios are all guard-driven (projecto/categoria/função)
	doc = frappe.get_doc({
		"doctype": "Salary Slip",
		"employee": e.name,
		"company": e.company,
		"salary_structure": ssa.salary_structure if ssa else None,
		# fetch_from fields are only filled by a real insert — set them by hand.
		"custom_vigilante": e.custom_vigilante,
		"custom_categoria": e.custom_categoria,
	})
	ssh._add_project_subsidios(doc)
	ssh._add_subsidio_arma(doc)
	ssh._add_subsidios_categoria_funcao(doc)
	out = {}
	for l in doc.get("earnings") or []:
		out[l.salary_component] = out.get(l.salary_component, 0) + flt(l.amount)
	return out


def _campo(componente):
	s = unicodedata.normalize("NFKD", componente).encode("ascii", "ignore").decode()
	return "sub_" + re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def _columns(componentes):
	cols = [
		{"label": _("Funcionário"), "fieldname": "funcionario", "fieldtype": "Link", "options": "Employee", "width": 120},
		{"label": _("Nome"), "fieldname": "nome", "fieldtype": "Data", "width": 220},
		{"label": _("Mecanográfico"), "fieldname": "mecanografico", "fieldtype": "Data", "width": 110},
		{"label": _("Delegação"), "fieldname": "delegacao", "fieldtype": "Link", "options": "Delegacao", "width": 120},
		{"label": _("Salário Base"), "fieldname": "salario_base", "fieldtype": "Currency", "width": 130},
	]
	cols += [{"label": c, "fieldname": _campo(c), "fieldtype": "Currency", "width": 120} for c in componentes]
	cols += [
		{"label": _("Total Subsídios"), "fieldname": "total_subsidios", "fieldtype": "Currency", "width": 130},
		{"label": _("Total a Receber"), "fieldname": "total", "fieldtype": "Currency", "width": 140},
	]
	return cols
