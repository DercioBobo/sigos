"""
Folha Processada — the REAL counterpart to Previsão de Folha: same filters,
same employee resolution, same columns, but reading actual submitted Salary
Slips instead of simulating one. No simulation, no rollback — this is a plain
read of what payroll already processed for the period.

Component columns (earn_*/ded_*) are only shown when at least one row actually
carries a non-zero value for them — an all-zero component (e.g. a Salary
Component every employee has on the structure but nobody triggered this month)
would just clutter the sheet.
"""

import frappe
from frappe import _

from sigos.security_ops.report.previsao_de_folha.previsao_de_folha import _resolver_funcionarios, _slug


def execute(filters=None):
	filters = frappe._dict(filters or {})
	if not filters.get("start_date") or not filters.get("end_date"):
		frappe.throw(_("Indique o Início e o Fim do período."))

	funcionarios = _resolver_funcionarios(filters)
	slips = _buscar_slips(funcionarios, filters.start_date, filters.end_date)

	data = []
	for emp in funcionarios:
		base_row = {
			"employee": emp.name,
			"employee_name": emp.employee_name,
			"vigilante": emp.custom_vigilante,
			"delegacao": emp.custom_delegacao,
			"posto": emp.custom_posto,
			"cliente": emp.custom_cliente,
		}
		slip = slips.get(emp.name)
		if not slip:
			data.append({
				**base_row,
				"base": 0, "faltas": 0, "faltas_nao_justificadas": 0, "dias_trabalhados": 0,
				"total_rendimentos": 0, "total_deducoes": 0, "valor_liquido": 0,
				"salary_slip": None, "estado": _("Não Processada"),
				"_earnings": {}, "_deductions": {},
			})
			continue

		data.append({
			**base_row,
			"base": slip.base or 0,
			"faltas": slip.custom_faltas_no_mes or 0,
			"faltas_nao_justificadas": slip.custom_faltas_nao_justificadas or 0,
			"dias_trabalhados": slip.custom_dias_trabalhados or 0,
			"total_rendimentos": slip.gross_pay or 0,
			"total_deducoes": slip.total_deduction or 0,
			"valor_liquido": slip.net_pay or 0,
			"salary_slip": slip.name,
			"estado": _("Processada"),
			"_earnings": slip._earnings,
			"_deductions": slip._deductions,
		})

	earning_cols, deduction_cols = _flatten_components(data)
	return _columns(earning_cols, deduction_cols), data


# ─── Real Salary Slip lookup ───────────────────────────────────────────────────

def _buscar_slips(funcionarios, start_date, end_date):
	"""Latest submitted Salary Slip overlapping the period, per employee — same
	overlap check salary_slip_hooks.py's own guard uses, so this finds exactly
	the slip a real payroll run for this period would have produced."""
	emp_names = [e.name for e in funcionarios]
	if not emp_names:
		return {}

	slips = frappe.get_all(
		"Salary Slip",
		filters={
			"employee": ["in", emp_names],
			"docstatus": 1,
			"start_date": ["<=", end_date],
			"end_date": [">=", start_date],
		},
		fields=[
			"name", "employee", "salary_structure", "gross_pay", "total_deduction", "net_pay",
			"custom_faltas_no_mes", "custom_faltas_nao_justificadas", "custom_dias_trabalhados",
		],
		order_by="end_date desc",
	)
	if not slips:
		return {}

	by_employee = {}
	for s in slips:
		by_employee.setdefault(s.employee, s)  # first hit wins — order_by end_date desc

	# Salary Slip has no "base" column (only base_hour_rate/base_gross_pay/…
	# company-currency mirrors) — the real base salary lives on the Salary
	# Structure Assignment, same fallback salary_slip_hooks._get_salario_base uses.
	for slip in by_employee.values():
		slip["base"] = frappe.db.get_value(
			"Salary Structure Assignment",
			{"employee": slip.employee, "salary_structure": slip.salary_structure, "docstatus": 1},
			"base",
		) or 0

	slip_names = [s.name for s in by_employee.values()]
	details = frappe.get_all(
		"Salary Detail",
		filters={"parent": ["in", slip_names], "parentfield": ["in", ["earnings", "deductions"]]},
		fields=["parent", "parentfield", "salary_component", "amount"],
	)
	earnings_by_slip, deductions_by_slip = {}, {}
	for d in details:
		alvo = earnings_by_slip if d.parentfield == "earnings" else deductions_by_slip
		alvo.setdefault(d.parent, {})[d.salary_component] = d.amount

	for slip in by_employee.values():
		slip["_earnings"] = earnings_by_slip.get(slip.name, {})
		slip["_deductions"] = deductions_by_slip.get(slip.name, {})

	return by_employee


# ─── Component flattening ──────────────────────────────────────────────────────

def _flatten_components(data):
	"""Turns each row's temp _earnings/_deductions dicts into earn_<slug>/ded_<slug>
	fields, in first-seen order — then drops any component column that is 0 on
	every row (nothing processed it this period)."""
	earning_cols, deduction_cols = [], []
	seen_earn, seen_ded = set(), set()

	for row in data:
		for component in row.get("_earnings", {}):
			if component not in seen_earn:
				seen_earn.add(component)
				earning_cols.append((component, "earn_" + _slug(component)))
		for component in row.get("_deductions", {}):
			if component not in seen_ded:
				seen_ded.add(component)
				deduction_cols.append((component, "ded_" + _slug(component)))

	for row in data:
		earnings = row.pop("_earnings", {})
		deductions = row.pop("_deductions", {})
		for label, fieldname in earning_cols:
			row[fieldname] = earnings.get(label, 0)
		for label, fieldname in deduction_cols:
			row[fieldname] = deductions.get(label, 0)

	earning_cols = [(l, f) for l, f in earning_cols if any(row.get(f) for row in data)]
	deduction_cols = [(l, f) for l, f in deduction_cols if any(row.get(f) for row in data)]
	return earning_cols, deduction_cols


# ─── Columns ─────────────────────────────────────────────────────────────────

def _columns(earning_cols, deduction_cols):
	component_col = lambda label, fieldname: {
		"label": label, "fieldname": fieldname, "fieldtype": "Currency", "width": 120,
	}
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
		*[component_col(label, fieldname) for label, fieldname in earning_cols],
		{"label": _("Total Rendimentos"), "fieldname": "total_rendimentos", "fieldtype": "Currency", "width": 130},
		*[component_col(label, fieldname) for label, fieldname in deduction_cols],
		{"label": _("Total Deduções"), "fieldname": "total_deducoes", "fieldtype": "Currency", "width": 130},
		{"label": _("Valor Líquido a Receber"), "fieldname": "valor_liquido", "fieldtype": "Currency", "width": 150},
		{"label": _("Salary Slip"), "fieldname": "salary_slip", "fieldtype": "Link", "options": "Salary Slip", "width": 130},
		{"label": _("Estado"), "fieldname": "estado", "fieldtype": "Data", "width": 110},
	]
