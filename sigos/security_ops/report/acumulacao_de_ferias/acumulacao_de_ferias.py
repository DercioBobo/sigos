"""
Acumulação de Férias — lê o saldo e o histórico directamente das Leave Ledger
Entries (a fonte de verdade do saldo no HRMS).

- Sem colaborador seleccionado → RESUMO: um colaborador por linha (antiguidade,
  anos de serviço, taxa mensal, saldo actual, última acumulação).
- Com colaborador seleccionado → HISTÓRICO: cada movimento (acumulação / gozo /
  expiração) com o saldo corrente acumulado.
"""
import frappe
from frappe import _
from frappe.utils import getdate, nowdate, date_diff, add_months, flt


def execute(filters=None):
	filters = filters or {}
	leave_type = filters.get("leave_type") or _leave_type_padrao()

	if filters.get("employee"):
		return _colunas_detalhe(), _detalhe(filters["employee"], leave_type)
	return _colunas_resumo(), _resumo(filters, leave_type)


def _leave_type_padrao():
	return frappe.db.get_single_value("SIGOS Settings", "leave_type_ferias") or "Ferias"


# ─── Resumo (um colaborador por linha) ─────────────────────────────────────────

def _resumo(filters, leave_type):
	hoje = getdate(nowdate())
	um_ano_atras = getdate(add_months(hoje, -12))

	emp_filters = {"status": "Active"}
	if filters.get("delegacao"):
		emp_filters["custom_delegacao"] = filters["delegacao"]

	emps = frappe.get_all(
		"Employee",
		filters=emp_filters,
		fields=[
			"name", "employee_name", "date_of_joining",
			"custom_data_antiguidade_ferias", "custom_ultima_acumulacao_ferias",
		],
	)

	rows = []
	for e in emps:
		alloc = frappe.db.get_value(
			"Leave Allocation",
			{"employee": e.name, "leave_type": leave_type, "docstatus": 1},
			"name",
		)
		saldo = _saldo(e.name, leave_type, hoje)
		if not alloc and not saldo:
			continue  # só lista quem participa nas férias

		anchor = e.custom_data_antiguidade_ferias or e.date_of_joining
		anos = round(date_diff(hoje, getdate(anchor)) / 365.0, 1) if anchor else None
		taxa = (2.5 if anchor and getdate(anchor) <= um_ano_atras else 1.0) if anchor else None

		rows.append({
			"employee": e.name,
			"employee_name": e.employee_name,
			"antiguidade": anchor,
			"anos_servico": anos,
			"taxa_mensal": taxa,
			"saldo": saldo,
			"ultima_acumulacao": e.custom_ultima_acumulacao_ferias,
			"allocation": alloc,
		})

	rows.sort(key=lambda r: (r["employee_name"] or "").lower())
	return rows


def _colunas_resumo():
	return [
		{"label": _("Colaborador"), "fieldname": "employee", "fieldtype": "Link", "options": "Employee", "width": 120},
		{"label": _("Nome"), "fieldname": "employee_name", "fieldtype": "Data", "width": 200},
		{"label": _("Antiguidade"), "fieldname": "antiguidade", "fieldtype": "Date", "width": 110},
		{"label": _("Anos de Serviço"), "fieldname": "anos_servico", "fieldtype": "Float", "precision": 1, "width": 120},
		{"label": _("Taxa/Mês"), "fieldname": "taxa_mensal", "fieldtype": "Float", "precision": 1, "width": 90},
		{"label": _("Saldo Actual"), "fieldname": "saldo", "fieldtype": "Float", "precision": 1, "width": 110},
		{"label": _("Última Acumulação"), "fieldname": "ultima_acumulacao", "fieldtype": "Date", "width": 140},
		{"label": _("Allocation"), "fieldname": "allocation", "fieldtype": "Link", "options": "Leave Allocation", "width": 150},
	]


# ─── Histórico (um movimento por linha) ────────────────────────────────────────

def _detalhe(employee, leave_type):
	entries = frappe.get_all(
		"Leave Ledger Entry",
		filters={"employee": employee, "leave_type": leave_type, "docstatus": 1},
		fields=["from_date", "leaves", "is_expired", "transaction_type", "transaction_name", "creation"],
		order_by="from_date asc, creation asc",
	)

	saldo = 0.0
	rows = []
	for en in entries:
		saldo += flt(en.leaves)
		if en.is_expired:
			tipo = _("Expiração")
		elif en.transaction_type == "Leave Application":
			tipo = _("Gozo")
		elif flt(en.leaves) > 0:
			tipo = _("Acumulação")
		else:
			tipo = _("Ajuste")
		rows.append({
			"data": en.from_date,
			"tipo": tipo,
			"dias": flt(en.leaves),
			"saldo": saldo,
			"documento": en.transaction_name,
		})
	return rows


def _colunas_detalhe():
	return [
		{"label": _("Data"), "fieldname": "data", "fieldtype": "Date", "width": 110},
		{"label": _("Tipo"), "fieldname": "tipo", "fieldtype": "Data", "width": 130},
		{"label": _("Dias"), "fieldname": "dias", "fieldtype": "Float", "precision": 1, "width": 90},
		{"label": _("Saldo"), "fieldname": "saldo", "fieldtype": "Float", "precision": 1, "width": 100},
		{"label": _("Documento"), "fieldname": "documento", "fieldtype": "Dynamic Link", "width": 200},
	]


# ─── Saldo (soma do ledger) ────────────────────────────────────────────────────

def _saldo(employee, leave_type, ate):
	val = frappe.db.sql(
		"""
		SELECT IFNULL(SUM(leaves), 0)
		FROM `tabLeave Ledger Entry`
		WHERE employee = %s AND leave_type = %s AND docstatus = 1
		  AND from_date <= %s
		""",
		(employee, leave_type, ate),
	)
	return flt(val[0][0]) if val else 0.0
