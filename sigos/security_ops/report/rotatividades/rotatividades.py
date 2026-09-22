import frappe
from frappe import _

STATUS_POR_DOCSTATUS = {0: "Rascunho", 1: "Aprovado", 2: "Cancelado"}
DOCSTATUS_POR_STATUS = {v: k for k, v in STATUS_POR_DOCSTATUS.items()}


def execute(filters=None):
	filters = filters or {}

	conditions = []
	values = {}

	if filters.get("de_data"):
		conditions.append("r.data >= %(de_data)s")
		values["de_data"] = filters["de_data"]
	if filters.get("ate_data"):
		conditions.append("r.data <= %(ate_data)s")
		values["ate_data"] = filters["ate_data"]
	if filters.get("delegacao"):
		conditions.append("r.delegacao = %(delegacao)s")
		values["delegacao"] = filters["delegacao"]
	if filters.get("vigilante"):
		conditions.append("(r.vigilante = %(vigilante)s OR r.novo_vigilante = %(vigilante)s)")
		values["vigilante"] = filters["vigilante"]
	if filters.get("posto"):
		conditions.append(
			"(r.antigo_posto = %(posto)s OR r.novo_posto = %(posto)s OR r.novo_posto_do_reserva = %(posto)s)"
		)
		values["posto"] = filters["posto"]
	if filters.get("abreviatura_op"):
		conditions.append("r.abreviatura_op = %(abreviatura_op)s")
		values["abreviatura_op"] = filters["abreviatura_op"]
	if filters.get("motivo"):
		conditions.append("r.motivo = %(motivo)s")
		values["motivo"] = filters["motivo"]
	if filters.get("status") and filters["status"] != "Todos":
		conditions.append("r.docstatus = %(docstatus)s")
		values["docstatus"] = DOCSTATUS_POR_STATUS[filters["status"]]

	where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
	data = frappe.db.sql(
		f"""
		SELECT
			r.name                    AS rotatividade,
			r.data                    AS data,
			r.delegacao               AS delegacao,
			r.vigilante                AS vigilante,
			v.nome_completo             AS nome_vigilante,
			r.mecanografico             AS mecanografico,
			r.categoria_vigilante      AS categoria,
			r.motivo                   AS motivo,
			r.antigo_posto              AS antigo_posto,
			r.antigo_posto_nome         AS antigo_posto_nome,
			r.novo_posto                AS novo_posto,
			r.novo_posto_nome           AS novo_posto_nome,
			r.cliente_antigo_posto      AS cliente_antigo_posto,
			r.cliente_novo_posto        AS cliente_novo_posto,
			r.regime                   AS regime,
			r.novo_regime               AS novo_regime,
			r.novo_vigilante            AS substituto,
			r.docstatus                 AS docstatus
		FROM `tabRotatividade` r
		LEFT JOIN `tabVigilante` v ON v.name = r.vigilante
		{where}
		ORDER BY r.data DESC, r.creation DESC
		""",
		values,
		as_dict=True,
	)

	for row in data:
		row["status"] = _(STATUS_POR_DOCSTATUS.get(row.pop("docstatus"), ""))
		row["vigilante"] = _concat(row.pop("vigilante"), row.pop("nome_vigilante"))
		row["antigo_posto"] = _concat(row.pop("antigo_posto"), row.pop("antigo_posto_nome"))
		row["novo_posto"] = _concat(row.pop("novo_posto"), row.pop("novo_posto_nome"))

	return _columns(), data


def _concat(codigo, nome):
	if codigo and nome:
		return f"{codigo} - {nome}"
	return codigo or nome or ""


def _columns():
	return [
		{"label": _("Rotatividade"), "fieldname": "rotatividade", "fieldtype": "Link", "options": "Rotatividade", "width": 130},
		{"label": _("Data"), "fieldname": "data", "fieldtype": "Date", "width": 90},
		{"label": _("Estado"), "fieldname": "status", "fieldtype": "Data", "width": 90},
		{"label": _("Delegação"), "fieldname": "delegacao", "fieldtype": "Link", "options": "Delegacao", "width": 110},
		{"label": _("Vigilante"), "fieldname": "vigilante", "fieldtype": "Data", "width": 220},
		{"label": _("Mecanográfico"), "fieldname": "mecanografico", "fieldtype": "Data", "width": 110},
		{"label": _("Categoria"), "fieldname": "categoria", "fieldtype": "Data", "width": 130},
		{"label": _("Tipo"), "fieldname": "motivo", "fieldtype": "Data", "width": 110},
		{"label": _("Posto Antigo"), "fieldname": "antigo_posto", "fieldtype": "Data", "width": 220},
		{"label": _("Posto Novo"), "fieldname": "novo_posto", "fieldtype": "Data", "width": 220},
		{"label": _("Cliente Antigo"), "fieldname": "cliente_antigo_posto", "fieldtype": "Data", "width": 120},
		{"label": _("Cliente Novo"), "fieldname": "cliente_novo_posto", "fieldtype": "Data", "width": 120},
		{"label": _("Regime"), "fieldname": "regime", "fieldtype": "Data", "width": 90},
		{"label": _("Novo Regime"), "fieldname": "novo_regime", "fieldtype": "Link", "options": "Regime", "width": 100},
		{"label": _("Substituto"), "fieldname": "substituto", "fieldtype": "Link", "options": "Vigilante", "width": 130},
	]
