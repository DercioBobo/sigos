import frappe
from frappe import _
from frappe.utils import get_first_day, get_last_day, getdate, today

MESES_PT = {
	1: "Janeiro", 2: "Fevereiro", 3: "Março", 4: "Abril",
	5: "Maio", 6: "Junho", 7: "Julho", 8: "Agosto",
	9: "Setembro", 10: "Outubro", 11: "Novembro", 12: "Dezembro",
}


def execute(filters=None):
	filters = filters or {}
	de = getdate(filters.get("de_data") or get_first_day(today()))
	ate = getdate(filters.get("ate_data") or get_last_day(today()))

	cond = ""
	params = {"de": de, "ate": ate}
	if filters.get("company"):
		cond += " AND ss.company = %(company)s"
		params["company"] = filters["company"]

	# custom_contanib (NIB) lives on Employee, not Salary Slip — the old script
	# assumed it was on the slip itself, which never worked; joined here instead.
	rows = frappe.db.sql(
		f"""
		SELECT
			emp.custom_contanib AS conta,
			ROUND(ss.net_pay, 2) AS valor,
			ss.employee_name AS nome_beneficiario
		FROM `tabSalary Slip` ss
		INNER JOIN `tabEmployee` emp ON emp.name = ss.employee
		WHERE ss.docstatus = 1
		  AND ss.posting_date BETWEEN %(de)s AND %(ate)s
		  {cond}
		ORDER BY ss.employee_name
		""",
		params,
		as_dict=True,
	)

	descritivo_debito = _("Pag do Salário {0}").format(_(MESES_PT[de.month]))
	descritivo_credito = _("Pag de Salario")

	data = []
	for i, r in enumerate(rows, start=1):
		data.append({
			"seq": i,
			"conta": r.conta or "",
			"valor": r.valor,
			"descritivo_debito": descritivo_debito,
			"descritivo_credito": descritivo_credito,
			"nome_beneficiario": r.nome_beneficiario,
		})

	return _columns(), data


def _columns():
	return [
		{"label": _("Seq"), "fieldname": "seq", "fieldtype": "Int", "width": 60},
		{"label": _("Conta"), "fieldname": "conta", "fieldtype": "Data", "width": 160},
		{"label": _("Valor"), "fieldname": "valor", "fieldtype": "Currency", "width": 120},
		{"label": _("Descritivo a Débito"), "fieldname": "descritivo_debito", "fieldtype": "Data", "width": 180},
		{"label": _("Descritivo a Crédito"), "fieldname": "descritivo_credito", "fieldtype": "Data", "width": 150},
		{"label": _("Nome Beneficiário"), "fieldname": "nome_beneficiario", "fieldtype": "Data", "width": 220},
	]
