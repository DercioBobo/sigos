"""
Previsão de Folha — a forecast of what payroll will cost for a given period,
BEFORE any real Payroll Entry / Salary Slip is created.

Reuses the real calculation logic verbatim: salary_slip_hooks.py's before_insert
+ before_validate chain (faltas, deduções, remunerações, empréstimo, subsídios,
proration) and HRMS's own native Salary Slip validate() (base pay / structure
components) are both driven purely by mutating an in-memory document — nothing
in that chain performs a database write. So this builds a Salary Slip document
that is NEVER inserted, fires the same hooks a real .insert() would (in the
same order), reads back the computed totals, and discards it. A savepoint +
rollback wraps the whole run as a safety net regardless.

Runs as a Prepared Report (see previsao_de_folha.json) — simulating hundreds/
thousands of employees this way is real per-employee DB work, not something to
run synchronously inside a blocking request.
"""

import frappe
from frappe import _


def execute(filters=None):
	filters = frappe._dict(filters or {})
	if not filters.get("start_date") or not filters.get("end_date"):
		frappe.throw(_("Indique o Início e o Fim do período."))

	savepoint = "previsao_de_folha"
	frappe.db.savepoint(savepoint)
	try:
		funcionarios = _resolver_funcionarios(filters)
		data = []
		sem_estrutura = 0
		for emp in funcionarios:
			row = _simular_funcionario(emp, filters.start_date, filters.end_date)
			if row is None:
				sem_estrutura += 1
				continue
			data.append(row)

		if sem_estrutura:
			frappe.msgprint(
				_("{0} funcionário(s) sem Estrutura Salarial atribuída foram "
				  "ignorados (sem base para prever).").format(sem_estrutura),
				alert=True, indicator="orange",
			)
		return _columns(), data
	finally:
		# Whatever the simulation touched, none of it is real — never let it commit.
		frappe.db.rollback(save_point=savepoint)


# ─── Employee resolution ───────────────────────────────────────────────────────

def _resolver_funcionarios(filters):
	"""Same mirrored Employee fields payroll_entry_hooks.py's own employee
	filter already uses (custom_delegacao/custom_cliente/custom_posto/status),
	so this selects exactly who a real Payroll Entry run would."""
	emp_filters = {}
	if filters.get("delegacao"):
		emp_filters["custom_delegacao"] = filters.delegacao
	if filters.get("cliente"):
		emp_filters["custom_cliente"] = filters.cliente

	situacao = filters.get("situacao") or "Activos"
	if situacao == "Activos":
		emp_filters["status"] = "Active"
	elif situacao == "Demitidos":
		emp_filters["status"] = "Left"

	postos = None
	if filters.get("project"):
		postos = frappe.get_all(
			"Posto De Vigilancia", filters={"project": filters.project}, pluck="name",
		)
		if not postos:
			return []
	if filters.get("posto"):
		postos = [filters.posto] if postos is None else [p for p in postos if p == filters.posto]
		if not postos:
			return []
	if postos is not None:
		emp_filters["custom_posto"] = ["in", postos]

	return frappe.get_all(
		"Employee",
		filters=emp_filters,
		fields=[
			"name", "employee_name", "company",
			"custom_vigilante", "custom_delegacao", "custom_posto", "custom_cliente",
		],
		order_by="employee_name asc",
	)


# ─── Per-employee simulation ────────────────────────────────────────────────────

def _simular_funcionario(emp, start_date, end_date):
	ssa = frappe.get_all(
		"Salary Structure Assignment",
		filters={"employee": emp.name, "docstatus": 1},
		fields=["salary_structure", "base"],
		order_by="from_date desc",
		limit=1,
	)
	if not ssa:
		return None
	ssa = ssa[0]

	base_row = {
		"employee": emp.name,
		"employee_name": emp.employee_name,
		"vigilante": emp.custom_vigilante,
		"delegacao": emp.custom_delegacao,
		"posto": emp.custom_posto,
		"cliente": emp.custom_cliente,
	}

	try:
		doc = frappe.get_doc({
			"doctype": "Salary Slip",
			"employee": emp.name,
			"employee_name": emp.employee_name,
			"company": emp.company,
			"salary_structure": ssa.salary_structure,
			"posting_date": end_date,
			"start_date": start_date,
			"end_date": end_date,
		})
		# Mirror exactly what a real .insert() fires, in the same order — but
		# never actually inserted, so nothing is written. before_validate and
		# validate are separate hook dispatches in Frappe (NOT one nested in
		# the other), so both must be called explicitly, or SIGOS's whole
		# faltas/deduções/remunerações chain (registered on before_validate)
		# would silently never run.
		doc.run_method("before_insert")
		doc.run_method("before_validate")
		doc.run_method("validate")

		return {
			**base_row,
			"base": doc.get("base") or ssa.base,
			"faltas": doc.get("custom_faltas_no_mes") or 0,
			"faltas_nao_justificadas": doc.get("custom_faltas_nao_justificadas") or 0,
			"dias_trabalhados": doc.get("custom_dias_trabalhados") or 0,
			"total_rendimentos": doc.get("gross_pay") or 0,
			"total_deducoes": doc.get("total_deduction") or 0,
			"valor_liquido": doc.get("net_pay") or 0,
			"estado": "OK",
		}
	except Exception as e:
		frappe.log_error(
			f"Previsão de Folha: erro ao simular {emp.name}: {e}",
			"SIGOS Previsão de Folha",
		)
		return {**base_row, "estado": "Erro"}


# ─── Columns ─────────────────────────────────────────────────────────────────

def _columns():
	return [
		{"label": _("Funcionário"), "fieldname": "employee", "fieldtype": "Link", "options": "Employee", "width": 110},
		{"label": _("Nome"), "fieldname": "employee_name", "fieldtype": "Data", "width": 180},
		{"label": _("Vigilante"), "fieldname": "vigilante", "fieldtype": "Link", "options": "Vigilante", "width": 110},
		{"label": _("Delegação"), "fieldname": "delegacao", "fieldtype": "Link", "options": "Delegacao", "width": 120},
		{"label": _("Posto"), "fieldname": "posto", "fieldtype": "Link", "options": "Posto De Vigilancia", "width": 150},
		{"label": _("Cliente"), "fieldname": "cliente", "fieldtype": "Link", "options": "Customer", "width": 130},
		{"label": _("Salário Base"), "fieldname": "base", "fieldtype": "Currency", "width": 110},
		{"label": _("Faltas"), "fieldname": "faltas", "fieldtype": "Int", "width": 80},
		{"label": _("Faltas Não Just."), "fieldname": "faltas_nao_justificadas", "fieldtype": "Int", "width": 110},
		{"label": _("Dias Trabalhados"), "fieldname": "dias_trabalhados", "fieldtype": "Int", "width": 110},
		{"label": _("Total Rendimentos"), "fieldname": "total_rendimentos", "fieldtype": "Currency", "width": 130},
		{"label": _("Total Deduções"), "fieldname": "total_deducoes", "fieldtype": "Currency", "width": 130},
		{"label": _("Valor Líquido a Receber"), "fieldname": "valor_liquido", "fieldtype": "Currency", "width": 150},
		{"label": _("Estado"), "fieldname": "estado", "fieldtype": "Data", "width": 90},
	]
