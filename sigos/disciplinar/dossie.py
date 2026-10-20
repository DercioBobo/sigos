"""
Ficha do Vigilante — everything the Jurista / RH needs to decide a Processo
Disciplinar, in one call, so nobody has to go look elsewhere: identity and
seniority, current situation (posto, suspensão, presunção, baixa, salário
congelado), attendance (faltas, justificações, baixas), férias balance, pay and
debts (salary roles + Jurista only), disciplinary history (participações, earlier
processos, repeated infracções) and returnable material still in his possession.

Reuses the canonical sources — never recomputes them differently:
  - faltas: sigos.utils.calcular_faltas_vigilante / calcular_faltas_detalhado
    (same weights/de-dup as payroll and the Cumulativo de Faltas report);
  - férias: sigos.ferias._saldo (ledger sum);
  - salário: sigos.api.resolver_salario_base + Salary Structure Assignment + Salary Slip.
"""

import frappe
from frappe import _
from frappe.utils import add_days, add_months, date_diff, flt, get_first_day, get_last_day, getdate, nowdate

PAPEIS_DOSSIE = (
	"System Manager", "SIGOS Manager", "Aprovador RH", "RH Normal", "Jurista",
	"Aprovador Operações", "Operações SIGOS",
)
# Pay and debts are sensitive — not shown to Operações.
PAPEIS_DOSSIE_SALARIO = ("System Manager", "SIGOS Manager", "Aprovador RH", "RH Normal", "Jurista")

_ORD_GRAV = {"Baixa": 1, "Média": 2, "Alta": 3}


@frappe.whitelist()
def dossie_vigilante(vigilante, processo=None):
	frappe.only_for(PAPEIS_DOSSIE)
	if not vigilante or not frappe.db.exists("Vigilante", vigilante):
		return None
	hoje = getdate(nowdate())
	v = frappe.get_doc("Vigilante", vigilante)
	mostra_salario = bool(set(frappe.get_roles()) & set(PAPEIS_DOSSIE_SALARIO))

	return {
		"gerado_em": frappe.utils.now(),
		"mostra_salario": mostra_salario,
		"identificacao": _identificacao(v, hoje, mostra_salario),
		"posto": _posto(v),
		"situacao": _situacao(v),
		"assiduidade": _assiduidade(v, hoje),
		"ferias": _ferias(v, hoje),
		"salario": _salario(v) if mostra_salario else None,
		"disciplinar": _disciplinar(v, hoje, processo),
		"material": _material(v),
	}


def _antiguidade(desde, hoje):
	if not desde:
		return None
	desde = getdate(desde)
	meses = (hoje.year - desde.year) * 12 + (hoje.month - desde.month) - (1 if hoje.day < desde.day else 0)
	return {"anos": meses // 12, "meses": meses % 12, "dias": date_diff(hoje, desde)}


def _identificacao(v, hoje, sensivel):
	out = {
		"nome": v.nome_completo, "mecanografico": v.mecanografico, "foto": v.foto,
		"categoria": v.categoria, "tipo_de_vigilante": v.tipo_de_vigilante, "delegacao": v.delegacao,
		"status": v.status, "sexo": v.sexo, "data_de_nascimento": v.data_de_nascimento, "idade": v.idade,
		"estado_civil": v.estado_civil, "dependentes": v.dependentes, "contacto": v.contacto,
		"residencia": v.residencia, "funcionario": v.funcionario,
		"data_admissao": v.data_admissao, "antiguidade": _antiguidade(v.data_admissao, hoje),
	}
	if sensivel:  # identity numbers: RH / Jurista / managers only
		out.update({"documento": v.documento, "numero_documento": v.numero_documento,
			"nuit": v.nuit, "inss": v.inss})
	return out


def _posto(v):
	"""Current posto, or — when off it (suspensão / presunção / baixa) — the one he left."""
	posto, regime, origem = v.posto_de_vigilancia, v.regime_do_vigilante, None
	if not posto:
		for dt, link, campos in (
			("Participacao", v.participacao_suspensao, ["suspensao_posto", "suspensao_regime"]),
			("Presuncao De Abandono", v.presuncao_abandono, ["posto_de_vigilancia", "regime"]),
			("Baixa Medica", v.baixa_medica, ["posto_anterior", "regime_anterior"]),
		):
			if link and frappe.db.exists(dt, link):
				p, r = frappe.db.get_value(dt, link, campos) or (None, None)
				if p:
					posto, regime, origem = p, r, dt
					break
	info = frappe.db.get_value("Posto De Vigilancia", posto, ["nome_do_posto", "indicativo", "cliente", "project"],
		as_dict=True) if posto else None
	return {
		"posto": posto, "nome_do_posto": info.nome_do_posto if info else None,
		"indicativo": info.indicativo if info else None, "cliente": (info.cliente if info else None) or v.cliente,
		"projecto": (info.project if info else None) or v.projecto, "regime": regime,
		"anterior": bool(origem),
	}


def _situacao(v):
	out = []
	if v.salario_congelado:
		out.append({"tipo": "congelado", "texto": _("Salário congelado desde {0}").format(
			frappe.format_value(v.salario_congelado_desde, {"fieldtype": "Date"})), "detalhe": v.salario_congelado_motivo})
	if v.status == "Suspenso Preventivamente" and v.participacao_suspensao:
		s = frappe.db.get_value("Participacao", v.participacao_suspensao,
			["suspensao_desde", "suspensao_remuneracao"], as_dict=True) or {}
		out.append({"tipo": "suspenso", "texto": _("Suspenso preventivamente desde {0}").format(
			frappe.format_value(s.get("suspensao_desde"), {"fieldtype": "Date"})),
			"detalhe": _("Remuneração: {0}").format(s.get("suspensao_remuneracao") or "-"), "doc": v.participacao_suspensao,
			"doctype": "Participacao"})
	if v.status == "Abandono de Posto" and v.presuncao_abandono:
		p = frappe.db.get_value("Presuncao De Abandono", v.presuncao_abandono,
			["estado", "abandono_desde", "total_faltas", "primeira_falta"], as_dict=True) or {}
		out.append({"tipo": "abandono", "texto": _("Abandono de Posto desde {0}").format(
			frappe.format_value(p.get("abandono_desde"), {"fieldtype": "Date"})),
			"detalhe": _("Ausente desde {0} · {1} falta(s) · Presunção {2}").format(
				frappe.format_value(p.get("primeira_falta"), {"fieldtype": "Date"}), p.get("total_faltas") or 0,
				p.get("estado") or "-"), "doc": v.presuncao_abandono, "doctype": "Presuncao De Abandono"})
	if v.status == "Doente" and v.baixa_medica:
		b = frappe.db.get_value("Baixa Medica", v.baixa_medica, ["data_inicio"], as_dict=True) or {}
		out.append({"tipo": "doente", "texto": _("Doente desde {0}").format(
			frappe.format_value(b.get("data_inicio"), {"fieldtype": "Date"})), "doc": v.baixa_medica,
			"doctype": "Baixa Medica"})
	return out


def _assiduidade(v, hoje):
	from sigos.utils import calcular_faltas_detalhado, calcular_faltas_vigilante

	um_ano = add_months(hoje, -12)
	mes_ant = add_months(hoje, -1)
	detalhe = calcular_faltas_detalhado(v.name, um_ano, hoje)
	justificacoes = frappe.get_all(
		"Justificacao De Faltas",
		filters={"vigilante": v.name, "docstatus": 1, "dia_de_fim": [">=", um_ano]},
		fields=["name", "dia_de_inicio", "dia_de_fim", "numero", "doenca"],
		order_by="dia_de_inicio desc",
	)
	baixas = frappe.get_all(
		"Baixa Medica", filters={"vigilante": v.name, "data_inicio": [">=", um_ano]},
		fields=["name", "data_inicio", "data_regresso", "dias", "estado", "pago_por"], order_by="data_inicio desc",
	)
	presuncoes = frappe.get_all(
		"Presuncao De Abandono", filters={"vigilante": v.name},
		fields=["name", "data_deteccao", "estado", "total_faltas"], order_by="creation desc",
	)
	return {
		"mes_atual": calcular_faltas_vigilante(v.name, get_first_day(hoje), get_last_day(hoje)),
		"mes_anterior": calcular_faltas_vigilante(v.name, get_first_day(mes_ant), get_last_day(mes_ant)),
		"tres_meses": calcular_faltas_vigilante(v.name, add_months(hoje, -3), hoje),
		"doze_meses": sum(r["n_de_faltas"] or 0 for r in detalhe),
		"dias_com_falta_12m": len({getdate(r["data"]) for r in detalhe}),
		"justificadas_12m": sum(j.numero or 0 for j in justificacoes),
		"justificacoes": justificacoes[:8],
		"recentes": [
			{"data": r["data"], "turno": r.get("turno"), "posto": r.get("posto"), "tipo": r.get("tipo_de_ausencia"),
			 "n": r["n_de_faltas"], "justificacao": r.get("tipo_justificacao"), "ausencia": r.get("ausencia")}
			for r in list(reversed(detalhe))[:12]
		],
		"baixas_12m": baixas,
		"dias_baixa_12m": sum(
			(b.dias if b.data_regresso else date_diff(hoje, b.data_inicio) + 1) or 0 for b in baixas),
		"presuncoes": presuncoes,
	}


def _ferias(v, hoje):
	if not v.funcionario:
		return []
	from sigos.ferias import _saldo

	tipos = frappe.get_all(
		"Leave Allocation",
		filters={"employee": v.funcionario, "docstatus": 1, "to_date": [">=", hoje]},
		pluck="leave_type", distinct=True,
	)
	return [{"leave_type": t, "saldo": flt(_saldo(v.funcionario, t, hoje))} for t in tipos]


def _salario(v):
	emp = v.funcionario
	from sigos.api import resolver_salario_base

	out = {"base": flt(resolver_salario_base(v.name)), "ssa": None, "folhas": [], "emprestimos": [],
		"deducoes": [], "divida_total": 0}
	if not emp:
		return out
	ssa = frappe.get_all("Salary Structure Assignment", filters={"employee": emp, "docstatus": 1},
		fields=["base", "from_date"], order_by="from_date desc", limit=1)
	out["ssa"] = ssa[0] if ssa else None
	out["folhas"] = frappe.get_all(
		"Salary Slip", filters={"employee": emp, "docstatus": 1},
		fields=["name", "start_date", "end_date", "gross_pay", "total_deduction", "net_pay"],
		order_by="start_date desc", limit=3,
	)
	hoje = getdate(nowdate())

	def _restante(d):
		# remaining months × monthly value, from today to data_de_fim
		if not d.data_de_fim or getdate(d.data_de_fim) < hoje:
			return 0
		meses = (getdate(d.data_de_fim).year - hoje.year) * 12 + getdate(d.data_de_fim).month - hoje.month + 1
		return max(0, min(meses, d.meses_a_pagar or meses)) * flt(d.valor_mensal)

	for dt, chave in (("Emprestimo", "emprestimos"), ("Outras Deducoes", "deducoes")):
		campos = ["name", "valor_a_pagar", "valor_mensal", "meses_a_pagar", "data_de_inicio", "data_de_fim"]
		if dt == "Outras Deducoes":
			campos.append("tipo")
		linhas = frappe.get_all(dt, filters={"funcionario": emp, "docstatus": 1, "estado": "Activo"},
			fields=campos, order_by="data_de_inicio desc")
		for l in linhas:
			l["restante"] = _restante(l)
		out[chave] = linhas
	out["divida_total"] = sum(l["restante"] for l in out["emprestimos"] + out["deducoes"])
	return out


def _disciplinar(v, hoje, processo=None):
	parts = frappe.get_all(
		"Participacao", filters={"vigilante": v.name, "docstatus": 1},
		fields=["name", "data", "gravidade", "tipo_de_infracao", "processo_disciplinar", "relato"],
		order_by="data desc",
	)
	infr = {}
	for row in frappe.get_all("Participacao Infracao",
			filters={"parenttype": "Participacao", "parent": ["in", [p.name for p in parts] or [""]]},
			fields=["parent", "tipo_de_infracao"]):
		infr.setdefault(row.parent, []).append(row.tipo_de_infracao)
	contagem = {}
	for p in parts:
		p["infracoes"] = infr.get(p.name) or ([p.tipo_de_infracao] if p.tipo_de_infracao else [])
		for t in p["infracoes"]:
			contagem[t] = contagem.get(t, 0) + 1
		p["relato"] = (p.relato or "")[:180]
	um_ano = add_months(hoje, -12)
	por_grav = {"Baixa": 0, "Média": 0, "Alta": 0}
	for p in parts:
		if p.gravidade in por_grav:
			por_grav[p.gravidade] += 1
	processos = frappe.get_all(
		"Processo Disciplinar",
		filters={"vigilante": v.name, "docstatus": ["<", 2], "name": ["!=", processo or ""]},
		fields=["name", "data", "gravidade", "motivo", "decisao", "docstatus"], order_by="data desc",
	)
	from sigos.disciplinar.doctype.repreensao.repreensao import contar_repreensoes, limite_repreensoes
	repreensoes = frappe.get_all(
		"Repreensao", filters={"vigilante": v.name, "docstatus": 1},
		fields=["name", "data", "numero", "infracoes", "processo_disciplinar"], order_by="data desc",
	)
	return {
		"repreensoes": repreensoes[:10],
		"total_repreensoes": len(repreensoes),
		"repreensoes_desde_processo": contar_repreensoes(v.name),
		"limite_repreensoes": limite_repreensoes(),
		"participacoes": parts[:12],
		"total_participacoes": len(parts),
		"participacoes_12m": sum(1 for p in parts if p.data and getdate(p.data) >= um_ano),
		"por_gravidade": por_grav,
		"reincidencias": sorted(
			[{"tipo": t, "vezes": n} for t, n in contagem.items() if n > 1], key=lambda x: -x["vezes"]),
		"processos_anteriores": processos,
	}


def _material(v):
	return frappe.db.sql(
		"""
		SELECT c.material, m.categoria, (c.quantidade - IFNULL(c.qtd_devolvida, 0)) AS em_posse,
		       p.data, c.parent AS alocacao
		FROM `tabAlocacao Material Item` c
		JOIN `tabAlocacao De Material` p ON p.name = c.parent
		LEFT JOIN `tabMaterial` m ON m.name = c.material
		WHERE p.docstatus = 1 AND p.vigilante = %(v)s AND IFNULL(c.retornavel, 0) = 1
		  AND (c.quantidade - IFNULL(c.qtd_devolvida, 0)) > 0
		ORDER BY p.data DESC
		""",
		{"v": v.name},
		as_dict=True,
	)
