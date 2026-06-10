import frappe
from frappe import _
from frappe.utils import getdate, get_first_day, get_last_day, today

from sigos.utils import calcular_faltas_detalhado


def execute(filters=None):
	filters = filters or {}
	de = getdate(filters.get("de_data") or get_first_day(today()))
	ate = getdate(filters.get("ate_data") or get_last_day(today()))

	cond = ""
	params = {"de": de, "ate": ate}
	if filters.get("vigilante"):
		cond += " AND ta.vigilante = %(vig)s"; params["vig"] = filters["vigilante"]
	if filters.get("delegacao"):
		cond += " AND ta.delegacao = %(deleg)s"; params["deleg"] = filters["delegacao"]

	vigs = frappe.db.sql(
		f"""
		SELECT DISTINCT ta.vigilante
		FROM `tabTabela Ausencia` ta
		JOIN `tabAusencias` a ON a.name = ta.parent
		WHERE a.docstatus = 1 AND a.data BETWEEN %(de)s AND %(ate)s {cond}
		""",
		params,
		as_dict=True,
	)

	data = []
	for v in vigs:
		data.extend(calcular_faltas_detalhado(v.vigilante, de, ate))
	data.sort(key=lambda r: (r["data"], r["ausencia"]))

	return _columns(), data


def _columns():
	return [
		{"label": _("Vigilante"), "fieldname": "vigilante", "fieldtype": "Link", "options": "Vigilante", "width": 130},
		{"label": _("Nome do Vigilante"), "fieldname": "nome_do_vigilante", "fieldtype": "Data", "width": 190},
		{"label": _("Regime"), "fieldname": "regime", "fieldtype": "Data", "width": 100},
		{"label": _("Posto"), "fieldname": "posto", "fieldtype": "Link", "options": "Posto De Vigilancia", "width": 150},
		{"label": _("Turno"), "fieldname": "turno", "fieldtype": "Data", "width": 110},
		{"label": _("Tipo de Ausência"), "fieldname": "tipo_de_ausencia", "fieldtype": "Data", "width": 130},
		{"label": _("Nº de Faltas"), "fieldname": "n_de_faltas", "fieldtype": "Int", "width": 100},
		{"label": _("Cumulativo de Faltas"), "fieldname": "cumulativo_de_faltas", "fieldtype": "Int", "width": 140},
		{"label": _("Data"), "fieldname": "data", "fieldtype": "Date", "width": 100},
		{"label": _("Ausência"), "fieldname": "ausencia", "fieldtype": "Link", "options": "Ausencias", "width": 150},
	]
