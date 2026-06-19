"""
Payroll Entry hooks for SIGOS.

Keeps the Payroll Entry's Payroll Payable account in step with the one configured
in SIGOS Settings — the same account the auto-created Salary Structure Assignments
use (see sigos.api._aplicar_salario_base_vigilante). We only fill it when blank, so
a deliberate per-run choice in the UI is never clobbered.

Wire-up (hooks.py):
    "Payroll Entry": {
        "before_validate": "sigos.payroll_ext.payroll_entry_hooks.before_validate",
    }
"""

import frappe


def before_validate(doc, method):
	if doc.get("payroll_payable_account"):
		return
	conta = frappe.db.get_single_value("SIGOS Settings", "payroll_payable_account")
	if conta:
		doc.payroll_payable_account = conta
