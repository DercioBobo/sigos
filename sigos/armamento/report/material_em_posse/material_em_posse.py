import frappe
from frappe import _


def execute(filters=None):
	filters = filters or {}

	conditions = [
		"p.docstatus = 1",
		"IFNULL(c.retornavel, 0) = 1",
		"(c.quantidade - IFNULL(c.qtd_devolvida, 0)) > 0",
	]
	values = {}
	for campo, coluna in (
		("delegacao", "p.delegacao"),
		("posto", "p.posto"),
		("vigilante", "p.vigilante"),
		("categoria", "m.categoria"),
	):
		if filters.get(campo):
			conditions.append(f"{coluna} = %({campo})s")
			values[campo] = filters[campo]

	where = " AND ".join(conditions)
	data = frappe.db.sql(
		f"""
		SELECT
			p.delegacao        AS delegacao,
			p.alocar_a         AS destino,
			p.posto            AS posto,
			p.vigilante        AS vigilante,
			m.categoria        AS categoria,
			c.material         AS material,
			(c.quantidade - IFNULL(c.qtd_devolvida, 0)) AS em_posse,
			p.data             AS data,
			c.parent           AS alocacao
		FROM `tabAlocacao Material Item` c
		JOIN `tabAlocacao De Material` p ON p.name = c.parent
		LEFT JOIN `tabMaterial` m ON m.name = c.material
		WHERE {where}
		ORDER BY p.posto, p.vigilante, c.material
		""",
		values,
		as_dict=True,
	)

	columns = [
		{"label": _("Delegação"), "fieldname": "delegacao", "fieldtype": "Link", "options": "Delegacao", "width": 120},
		{"label": _("Destino"), "fieldname": "destino", "fieldtype": "Data", "width": 90},
		{"label": _("Posto"), "fieldname": "posto", "fieldtype": "Link", "options": "Posto De Vigilancia", "width": 170},
		{"label": _("Vigilante"), "fieldname": "vigilante", "fieldtype": "Link", "options": "Vigilante", "width": 170},
		{"label": _("Categoria"), "fieldname": "categoria", "fieldtype": "Data", "width": 150},
		{"label": _("Material"), "fieldname": "material", "fieldtype": "Link", "options": "Material", "width": 160},
		{"label": _("Em Posse"), "fieldname": "em_posse", "fieldtype": "Int", "width": 90},
		{"label": _("Desde"), "fieldname": "data", "fieldtype": "Date", "width": 100},
		{"label": _("Alocação"), "fieldname": "alocacao", "fieldtype": "Link", "options": "Alocacao De Material", "width": 140},
	]
	return columns, data
