import frappe
from frappe import _
from frappe.utils import getdate
from dateutil.relativedelta import relativedelta

STATUS_POR_DOCSTATUS = {0: "Rascunho", 1: "Aprovado", 2: "Cancelado"}
DOCSTATUS_POR_STATUS = {v: k for k, v in STATUS_POR_DOCSTATUS.items()}

ORIGEM_ROT = "Rotatividade"
ORIGEM_PD = "Processo Disciplinar"
ORIGEM_MANUAL = "Manual"


def execute(filters=None):
	filters = filters or {}

	conditions = []
	values = {}

	if filters.get("de_data"):
		conditions.append("d.data_de_demissao >= %(de_data)s")
		values["de_data"] = filters["de_data"]
	if filters.get("ate_data"):
		conditions.append("d.data_de_demissao <= %(ate_data)s")
		values["ate_data"] = filters["ate_data"]
	if filters.get("delegacao"):
		conditions.append("d.delegacao = %(delegacao)s")
		values["delegacao"] = filters["delegacao"]
	if filters.get("vigilante"):
		conditions.append("d.vigilante = %(vigilante)s")
		values["vigilante"] = filters["vigilante"]
	if filters.get("motivo"):
		conditions.append("d.motivo = %(motivo)s")
		values["motivo"] = filters["motivo"]
	if filters.get("uniforme"):
		conditions.append("d.uniforme = %(uniforme)s")
		values["uniforme"] = filters["uniforme"]
	if filters.get("status") and filters["status"] != "Todos":
		conditions.append("d.docstatus = %(docstatus)s")
		values["docstatus"] = DOCSTATUS_POR_STATUS[filters["status"]]

	where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
	# Demissao doesn't store posto/cliente/categoria and the Vigilante is wiped on
	# submit, so recover them from the document that originated the dismissal:
	# the DEM Rotatividade (matched the same way Rotatividade._criar_demissao
	# dedups) or the Processo Disciplinar with decisão Demissão.
	data = frappe.db.sql(
		f"""
		SELECT
			d.name                  AS demissao,
			d.data_de_demissao      AS data,
			d.delegacao             AS delegacao,
			d.vigilante             AS vigilante,
			v.nome_completo         AS nome_vigilante,
			d.mecanografico         AS mecanografico,
			d.motivo                AS motivo,
			d.regime                AS regime,
			d.uniforme              AS uniforme,
			v.data_admissao         AS data_admissao,
			d.docstatus             AS docstatus,
			(SELECT r.name FROM `tabRotatividade` r
				WHERE r.vigilante = d.vigilante AND r.docstatus = 1
				AND COALESCE(r.data_de_demissao, r.data) = d.data_de_demissao
				ORDER BY r.creation DESC LIMIT 1) AS rotatividade,
			(SELECT pd.name FROM `tabProcesso Disciplinar` pd
				WHERE pd.vigilante = d.vigilante AND pd.docstatus = 1
				AND pd.decisao = 'Demissão' AND pd.data = d.data_de_demissao
				ORDER BY pd.creation DESC LIMIT 1) AS processo_disciplinar
		FROM `tabDemissao` d
		LEFT JOIN `tabVigilante` v ON v.name = d.vigilante
		{where}
		ORDER BY d.data_de_demissao DESC, d.creation DESC
		""",
		values,
		as_dict=True,
	)

	rots = _por_nome("Rotatividade", [r.rotatividade for r in data],
		["name", "antigo_posto", "antigo_posto_nome", "cliente_antigo_posto", "categoria_vigilante"])
	pds = _por_nome("Processo Disciplinar", [r.processo_disciplinar for r in data],
		["name", "posto", "posto_nome", "categoria"])
	clientes_pd = _por_nome("Posto De Vigilancia", [p.posto for p in pds.values()], ["name", "cliente"])

	filtro_posto = filters.get("posto")
	filtro_origem = filters.get("origem")
	resultado = []
	for row in data:
		rot = rots.get(row.pop("rotatividade"))
		pd = pds.get(row.pop("processo_disciplinar"))
		if rot:
			row["origem_tipo"], row["origem"] = ORIGEM_ROT, rot.name
			posto, posto_nome = rot.antigo_posto, rot.antigo_posto_nome
			row["cliente"] = rot.cliente_antigo_posto
			row["categoria"] = rot.categoria_vigilante
		elif pd:
			row["origem_tipo"], row["origem"] = ORIGEM_PD, pd.name
			posto, posto_nome = pd.posto, pd.posto_nome
			row["cliente"] = (clientes_pd.get(pd.posto) or {}).get("cliente")
			row["categoria"] = pd.categoria
		else:
			row["origem_tipo"], row["origem"] = ORIGEM_MANUAL, None
			posto = posto_nome = row["cliente"] = row["categoria"] = None

		if filtro_posto and posto != filtro_posto:
			continue
		if filtro_origem and row["origem_tipo"] != filtro_origem:
			continue

		row["posto"] = _concat(posto, posto_nome)
		row["status"] = _(STATUS_POR_DOCSTATUS.get(row.pop("docstatus"), ""))
		row["vigilante"] = _concat(row.vigilante, row.pop("nome_vigilante"))
		row["antiguidade"] = _antiguidade(row.data_admissao, row.data)
		resultado.append(row)

	return _columns(), resultado, None, None, _summary(resultado)


def _por_nome(doctype, nomes, campos):
	nomes = list({n for n in nomes if n})
	if not nomes:
		return {}
	return {d.name: d for d in frappe.get_all(doctype, filters={"name": ["in", nomes]}, fields=campos)}


def _concat(codigo, nome):
	if codigo and nome:
		return f"{codigo} - {nome}"
	return codigo or nome or ""


def _antiguidade(admissao, demissao):
	if not admissao or not demissao:
		return ""
	delta = relativedelta(getdate(demissao), getdate(admissao))
	if delta.years < 0 or delta.months < 0:
		return ""
	partes = []
	if delta.years:
		partes.append(f"{delta.years}a")
	partes.append(f"{delta.months}m")
	return " ".join(partes)


def _summary(data):
	aprovadas = [r for r in data if r.status == _("Aprovado")]
	por_motivo = {}
	for r in aprovadas:
		if r.motivo == "Outro Motivo":
			continue
		chave = r.motivo or _("Sem Motivo")
		por_motivo[chave] = por_motivo.get(chave, 0) + 1

	summary = [
		{"label": _("Uniforme Não Entregue"), "value": sum(1 for r in aprovadas if r.uniforme == "Não Entregue"),
			"indicator": "Orange", "datatype": "Int"},
	]
	for motivo, n in sorted(por_motivo.items(), key=lambda kv: -kv[1]):
		summary.append({"label": motivo, "value": n, "indicator": "Blue", "datatype": "Int"})
	return summary


def _columns():
	return [
		{"label": _("Demissão"), "fieldname": "demissao", "fieldtype": "Link", "options": "Demissao", "width": 120},
		{"label": _("Data"), "fieldname": "data", "fieldtype": "Date", "width": 90},
		{"label": _("Estado"), "fieldname": "status", "fieldtype": "Data", "width": 90},
		{"label": _("Delegação"), "fieldname": "delegacao", "fieldtype": "Link", "options": "Delegacao", "width": 110},
		{"label": _("Vigilante"), "fieldname": "vigilante", "fieldtype": "Data", "width": 220},
		{"label": _("Mecanográfico"), "fieldname": "mecanografico", "fieldtype": "Data", "width": 110},
		{"label": _("Categoria"), "fieldname": "categoria", "fieldtype": "Data", "width": 130},
		{"label": _("Motivo"), "fieldname": "motivo", "fieldtype": "Data", "width": 120},
		{"label": _("Último Posto"), "fieldname": "posto", "fieldtype": "Data", "width": 220},
		{"label": _("Cliente"), "fieldname": "cliente", "fieldtype": "Data", "width": 130},
		{"label": _("Regime"), "fieldname": "regime", "fieldtype": "Data", "width": 90},
		{"label": _("Admissão"), "fieldname": "data_admissao", "fieldtype": "Date", "width": 90},
		{"label": _("Antiguidade"), "fieldname": "antiguidade", "fieldtype": "Data", "width": 90},
		{"label": _("Uniforme"), "fieldname": "uniforme", "fieldtype": "Data", "width": 110},
		{"label": _("Origem"), "fieldname": "origem_tipo", "fieldtype": "Data", "width": 140},
		{"label": _("Documento de Origem"), "fieldname": "origem", "fieldtype": "Dynamic Link", "options": "origem_tipo", "width": 130},
	]
