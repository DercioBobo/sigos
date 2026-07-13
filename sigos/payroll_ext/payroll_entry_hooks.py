"""
Payroll Entry hooks for SIGOS.

(1) Keeps the Payroll Entry's Payroll Payable account in step with the one
configured in SIGOS Settings — the same account the auto-created Salary
Structure Assignments use (see sigos.api._aplicar_salario_base_vigilante). We
only fill it when blank, so a deliberate per-run choice in the UI is never
clobbered.

(2) Narrows the "Get Employees" result by Cliente / Delegação / Situação
(custom_customer / custom_delegacao / custom_situacao — SIGOS Setup custom
fields). Deliberately does NOT touch HRMS's own employee-fetch query (its
internals aren't something we want to depend on across upgrades) — instead it
PRUNES the `employees` child table after HRMS has already populated it, right
before save. Re-run "Get Employee Details" after changing a filter so the table
is refetched before pruning.

Wire-up (hooks.py):
    "Payroll Entry": {
        "before_validate": "sigos.payroll_ext.payroll_entry_hooks.before_validate",
    }
"""

import frappe


def before_validate(doc, method):
	_default_payroll_payable_account(doc)
	_filtrar_employees_por_criterio(doc)


def _default_payroll_payable_account(doc):
	if doc.get("payroll_payable_account"):
		return
	conta = frappe.db.get_single_value("SIGOS Settings", "payroll_payable_account")
	if conta:
		doc.payroll_payable_account = conta


def _filtrar_employees_por_criterio(doc):
	delegacao = doc.get("custom_delegacao")
	cliente = doc.get("custom_customer")
	situacao = doc.get("custom_situacao") or "Activos"
	if not (delegacao or cliente or situacao != "Todos"):
		return

	linhas = doc.get("employees") or []
	nomes = [l.employee for l in linhas if l.employee]
	if not nomes:
		return

	info_by_emp = {
		e.name: e for e in frappe.get_all(
			"Employee", filters={"name": ["in", nomes]},
			fields=["name", "status", "custom_delegacao", "custom_vigilante"],
		)
	}

	cliente_by_vig = {}
	if cliente:
		vig_names = [e.custom_vigilante for e in info_by_emp.values() if e.custom_vigilante]
		if vig_names:
			cliente_by_vig = {
				v.name: v.cliente for v in frappe.get_all(
					"Vigilante", filters={"name": ["in", vig_names]}, fields=["name", "cliente"],
				)
			}

	def mantem(employee):
		info = info_by_emp.get(employee)
		if not info:
			return True  # can't classify (shouldn't happen) — don't silently drop
		if delegacao and info.custom_delegacao != delegacao:
			return False
		if cliente and cliente_by_vig.get(info.custom_vigilante) != cliente:
			return False
		if situacao == "Activos" and info.status != "Active":
			return False
		if situacao == "Demitidos" and info.status != "Left":
			return False
		return True

	doc.set("employees", [l for l in linhas if mantem(l.employee)])
