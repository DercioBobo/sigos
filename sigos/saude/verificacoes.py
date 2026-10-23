"""
Saúde SIGOS checks — see sigos/saude/__init__.py for the contract. Grouped as the
page sidebar; each fix calls the existing domain function so every validation,
timeline entry and notification signal still applies. Some things are never fixes
here, only links: a Demissão or a sanction only comes from the Processo Disciplinar.
"""

import frappe
from frappe import _
from frappe.utils import (
	add_days, add_months, cint, date_diff, flt, fmt_money, formatdate, get_first_day, getdate,
	now_datetime, strip_html_tags, today,
)

from sigos.saude import AVISO, CRITICO, INFO, correcao, linha, verificacao

GESTAO = ("SIGOS Manager",)
OPS = GESTAO + ("Aprovador Operações", "Operações SIGOS")
SUPERVISAO = OPS + ("Supervisor SIGOS",)
RH = GESTAO + ("Aprovador RH", "RH Normal")
JURISTA = GESTAO + ("Jurista",)
FIN = GESTAO + ("Accounts Manager",)

EMPREGADOS = ("Activo", "Reserva", "Abandono de Posto", "Doente", "Suspenso Preventivamente")

# Thresholds (calendar days)
VAGA_ANTIGA = 7
PRESUNCAO_PARADA = 5
BAIXA_LONGA = 30
PARTICIPACAO_RASCUNHO = 2
PARTICIPACAO_AVISO_PRAZO = 5
PD_AVISO_DEFESA = 2
PD_AVISO_DECISAO = 3
PEDIDO_PARADO = 3
ROTATIVIDADE_PARADA = 2
PRE_ADMISSAO_PARADA = 14
FATURA_RASCUNHO = 2
FATURA_VENCIDA_CRITICA = 60

_MOTIVO = [{"fieldname": "motivo", "fieldtype": "Small Text", "label": "Motivo", "reqd": 1}]


def _data(d):
	return formatdate(d) if d else "—"


def _ha(d):
	return date_diff(today(), getdate(d)) if d else None


def _vigilantes(filtros, extra=()):
	return frappe.get_all("Vigilante", filters=filtros, fields=[
		"name", "nome_completo", "mecanografico", "delegacao", "posto_de_vigilancia", "status",
		"creation", *extra,
	])


def _lv(v, detalhe, dias=None, nivel=None):
	return linha("Vigilante", v.name, v.nome_completo, v.mecanografico or v.name, detalhe,
		v.delegacao, dias, nivel)


# ═══ Operações ══════════════════════════════════════════════════════════════════

@verificacao("postos_desfalcados", "operacoes", "Postos desfalcados", CRITICO, SUPERVISAO,
	"Postos activos com menos vigilantes do que as vagas.")
def postos_desfalcados():
	return [
		linha("Posto De Vigilancia", p.name, p.nome_do_posto, p.name,
			_("{0} de {1} vigilantes · faltam {2}").format(p.n, p.numero_de_vagas, p.numero_de_vagas - p.n),
			p.delegacao, dias=p.numero_de_vagas - p.n)
		for p in _ocupacao("<")
	]


@verificacao("postos_excedidos", "operacoes", "Postos com vigilantes a mais", AVISO, SUPERVISAO,
	"Mais vigilantes activos do que as vagas do posto.")
def postos_excedidos():
	return [
		linha("Posto De Vigilancia", p.name, p.nome_do_posto, p.name,
			_("{0} vigilantes para {1} vagas").format(p.n, p.numero_de_vagas), p.delegacao,
			dias=p.n - p.numero_de_vagas)
		for p in _ocupacao(">")
	]


def _ocupacao(op):
	# Same count as utils.atualizar_ocupacao_posto (Cobridor shadows don't count).
	return frappe.db.sql(f"""
		SELECT p.name, p.nome_do_posto, p.delegacao, p.numero_de_vagas, COUNT(v.name) AS n
		FROM `tabPosto De Vigilancia` p
		LEFT JOIN `tabVigilante` v ON v.posto_de_vigilancia = p.name AND v.status = 'Activo'
			AND IFNULL(v.cobertura_de_posto_activa, '') = ''
		WHERE p.estado = 'Activo' AND IFNULL(p.numero_de_vagas, 0) > 0
		GROUP BY p.name
		HAVING n {op} p.numero_de_vagas
	""", as_dict=True)


@verificacao("vagas_antigas", "operacoes", "Vagas abertas há muito tempo", AVISO, SUPERVISAO,
	f"Vagas por preencher há mais de {VAGA_ANTIGA} dias.")
def vagas_antigas():
	limite = add_days(now_datetime(), -VAGA_ANTIGA)
	return [
		linha("Vaga De Posto", g.name, g.posto_de_vigilancia, g.name,
			_("{0} · {1} · aberta há {2} dias").format(g.regime or "—", g.turno or "—", _ha(g.data_abertura)),
			g.delegacao, _ha(g.data_abertura))
		for g in frappe.get_all("Vaga De Posto",
			filters={"estado": "Aberta", "data_abertura": ["<", limite]},
			fields=["name", "posto_de_vigilancia", "regime", "turno", "delegacao", "data_abertura"])
	]


@verificacao("activo_sem_posto", "operacoes", "Activos sem posto", AVISO, OPS,
	"Vigilantes Activos sem posto atribuído.")
def activo_sem_posto():
	return [_lv(v, _("Activo sem posto")) for v in
		_vigilantes({"status": "Activo", "posto_de_vigilancia": ["is", "not set"]})]


@correcao("activo_sem_posto", "reserva", "Mover para Reserva", OPS, campos=_MOTIVO)
def _activo_para_reserva(nome, params):
	frappe.get_doc("Vigilante", nome).colocar_em_reserva(params.motivo)
	return _("Em Reserva")


@verificacao("fora_da_escala", "operacoes", "Activos fora da escala", AVISO, SUPERVISAO,
	"Vigilantes com posto que não estão na escala activa desse posto.")
def fora_da_escala():
	return [
		_lv(v, _("Posto {0} · fora da escala activa").format(v.posto_de_vigilancia))
		for v in frappe.db.sql("""
			SELECT v.name, v.nome_completo, v.mecanografico, v.delegacao, v.posto_de_vigilancia
			FROM `tabVigilante` v
			WHERE v.status = 'Activo' AND IFNULL(v.posto_de_vigilancia, '') != ''
			  AND IFNULL(v.cobertura_de_posto_activa, '') = ''
			  AND NOT EXISTS (
				SELECT 1 FROM `tabTab Vigilante Do Posto` t
				JOIN `tabEscala Do Vigilante` e ON e.name = t.parent
				WHERE t.parenttype = 'Escala Do Vigilante' AND t.vigilante = v.name
				  AND e.estado = 'Activo' AND e.posto_de_vigilancia = v.posto_de_vigilancia)
		""", as_dict=True)
	]


@verificacao("postos_temporarios_expirados", "operacoes", "Postos temporários expirados", AVISO, OPS,
	"Postos temporários activos depois da data de fim prevista.")
def postos_temporarios_expirados():
	return [
		linha("Posto De Vigilancia", p.name, p.nome_do_posto, p.name,
			_("Fim previsto {0} · {1} vigilantes").format(_data(p.data_fim_prevista), cint(p.ocupacao_atual)),
			p.delegacao, _ha(p.data_fim_prevista))
		for p in frappe.get_all("Posto De Vigilancia",
			filters={"estado": "Activo", "tipo_de_posto": "Temporário", "data_fim_prevista": ["<", today()]},
			fields=["name", "nome_do_posto", "delegacao", "data_fim_prevista", "ocupacao_atual"])
	]


@correcao("postos_temporarios_expirados", "encerrar", "Encerrar Posto", OPS, campos=_MOTIVO,
	perigosa=True, confirmar="A equipa passa para Reserva e o posto fica inactivo.")
def _encerrar_posto(nome, params):
	from sigos.api import encerrar_posto
	r = encerrar_posto(nome, params.motivo) or {}
	return _("Encerrado · {0} vigilantes para Reserva").format(cint(r.get("benched")))


@verificacao("postos_sem_contrato", "operacoes", "Postos sem contrato", AVISO, OPS + FIN,
	"Postos activos sem contrato: não são facturados.")
def postos_sem_contrato():
	return [
		linha("Posto De Vigilancia", p.name, p.nome_do_posto, p.name,
			_("Cliente: {0}").format(p.cliente) if p.cliente else _("Sem cliente nem contrato"), p.delegacao)
		for p in frappe.get_all("Posto De Vigilancia",
			filters={"estado": "Activo", "posto_interno": 0, "project": ["is", "not set"]},
			fields=["name", "nome_do_posto", "delegacao", "cliente"])
	]


@verificacao("ausencia_duplicada", "operacoes", "Ausências Duplicadas no Mesmo Dia", AVISO, OPS + RH,
	"Vigilante com mais de uma ausência submetida no mesmo dia (períodos diferentes).")
def ausencia_duplicada():
	return [
		linha("Vigilante", f"{d.vigilante} · {d.data}", d.nome, d.mecanografico or d.vigilante,
			_("{0} · {1} · {2} faltas").format(_data(d.data), d.folhas, d.faltas),
			d.delegacao, _ha(d.data), link=("Vigilante", d.vigilante))
		for d in frappe.db.sql("""
			SELECT ta.vigilante, a.data, MAX(v.nome_completo) AS nome,
				MAX(v.mecanografico) AS mecanografico, MAX(v.delegacao) AS delegacao,
				GROUP_CONCAT(CONCAT(a.periodo, ' (', a.name, ')') SEPARATOR ', ') AS folhas,
				SUM(ta.n_de_faltas) AS faltas
			FROM `tabTabela Ausencia` ta
			JOIN `tabAusencias` a ON a.name = ta.parent
			JOIN `tabVigilante` v ON v.name = ta.vigilante
			WHERE a.docstatus = 1
			GROUP BY ta.vigilante, a.data
			HAVING COUNT(*) > 1
		""", as_dict=True)
	]


# ═══ Abandono ═══════════════════════════════════════════════════════════════════

@verificacao("limite_faltas", "abandono", "Limite de faltas atingido", CRITICO, OPS + ("Jurista",),
	"Atingiram o limite de abandono e ainda não têm Presunção.")
def limite_faltas():
	return [
		_lv(v, _("Faltas desde {0} · detectado {1}").format(
			_data(v.abandono_primeira_falta), _data(v.abandono_detectado_em)),
			_ha(v.abandono_primeira_falta))
		for v in frappe.db.sql("""
			SELECT v.name, v.nome_completo, v.mecanografico, v.delegacao,
				v.abandono_primeira_falta, v.abandono_detectado_em
			FROM `tabVigilante` v
			WHERE v.abandono_detectado_em IS NOT NULL AND v.status IN ('Activo', 'Reserva')
			  AND NOT EXISTS (SELECT 1 FROM `tabPresuncao De Abandono` p WHERE p.vigilante = v.name
				AND p.estado IN ('Aberta', 'Em Análise', 'Encaminhada para Processo'))
		""", as_dict=True)
	]


@correcao("limite_faltas", "presuncao", "Criar Presunção", ("SIGOS Manager", "Aprovador Operações", "Operações SIGOS"),
	perigosa=True, confirmar="O vigilante sai do posto e o salário fica congelado.")
def _criar_presuncao(nome, params):
	from sigos.abandono import criar_presuncao
	return _("Presunção {0}").format(criar_presuncao(nome, origem="Manual"))


@verificacao("presuncao_parada", "abandono", "Presunções por analisar", AVISO, JURISTA + ("Aprovador RH",),
	f"Presunções Abertas há mais de {PRESUNCAO_PARADA} dias.")
def presuncao_parada():
	return [
		linha("Presuncao De Abandono", p.name, p.nome_do_vigilante, p.name,
			_("Aberta desde {0}").format(_data(p.data_deteccao)), p.delegacao, _ha(p.data_deteccao))
		for p in frappe.get_all("Presuncao De Abandono",
			filters={"estado": "Aberta", "data_deteccao": ["<=", add_days(today(), -PRESUNCAO_PARADA)]},
			fields=["name", "nome_do_vigilante", "delegacao", "data_deteccao"])
	]


@verificacao("abandono_sem_presuncao", "abandono", "Em abandono sem Presunção", CRITICO, OPS + ("Jurista",),
	"Estado Abandono de Posto sem Presunção em curso.")
def abandono_sem_presuncao():
	return [
		_lv(v, _("Em abandono desde {0}").format(_data(v.data_inicio_abandono)), _ha(v.data_inicio_abandono))
		for v in frappe.db.sql("""
			SELECT v.name, v.nome_completo, v.mecanografico, v.delegacao, v.data_inicio_abandono
			FROM `tabVigilante` v
			WHERE v.status = 'Abandono de Posto'
			  AND NOT EXISTS (SELECT 1 FROM `tabPresuncao De Abandono` p WHERE p.vigilante = v.name
				AND p.estado IN ('Aberta', 'Em Análise', 'Encaminhada para Processo'))
		""", as_dict=True)
	]


# ═══ Doença e Suspensões ════════════════════════════════════════════════════════

@verificacao("baixa_longa", "doenca", "Baixas longas", INFO, RH + OPS,
	f"Baixas médicas em curso há mais de {BAIXA_LONGA} dias.")
def baixa_longa():
	return [
		linha("Baixa Medica", b.name, b.nome_do_vigilante, b.name,
			_("Doente desde {0} · {1} dias").format(_data(b.data_inicio), _ha(b.data_inicio)),
			b.delegacao, _ha(b.data_inicio))
		for b in frappe.get_all("Baixa Medica",
			filters={"estado": "Em Curso", "data_inicio": ["<=", add_days(today(), -BAIXA_LONGA)]},
			fields=["name", "nome_do_vigilante", "delegacao", "data_inicio"])
	]


@verificacao("doente_sem_baixa", "doenca", "Doentes sem Baixa Médica", CRITICO, RH + OPS,
	"Estado Doente sem Baixa Médica em curso.")
def doente_sem_baixa():
	return [
		_lv(v, _("Doente sem Baixa Médica em curso"))
		for v in frappe.db.sql("""
			SELECT v.name, v.nome_completo, v.mecanografico, v.delegacao
			FROM `tabVigilante` v
			WHERE v.status = 'Doente' AND NOT EXISTS (SELECT 1 FROM `tabBaixa Medica` b
				WHERE b.vigilante = v.name AND b.estado = 'Em Curso')
		""", as_dict=True)
	]


@verificacao("suspenso_sem_processo", "doenca", "Suspensos sem Processo", AVISO, OPS + ("Jurista",),
	"Suspensos preventivamente cuja Participação ainda não tem Processo Disciplinar.")
def suspenso_sem_processo():
	return [
		linha("Vigilante", v.name, v.nome_completo, v.mecanografico or v.name,
			_("Suspenso desde {0} · {1}").format(_data(v.suspensao_desde), v.participacao),
			v.delegacao, _ha(v.suspensao_desde), link=("Participacao", v.participacao))
		for v in frappe.db.sql("""
			SELECT v.name, v.nome_completo, v.mecanografico, v.delegacao,
				p.name AS participacao, p.suspensao_desde
			FROM `tabVigilante` v
			JOIN `tabParticipacao` p ON p.name = v.participacao_suspensao
			WHERE v.status = 'Suspenso Preventivamente' AND IFNULL(p.processo_disciplinar, '') = ''
		""", as_dict=True)
	]


# ═══ Disciplinar ════════════════════════════════════════════════════════════════

@verificacao("participacao_sem_seguimento", "disciplinar", "Participações sem Processo", CRITICO,
	JURISTA + ("Aprovador Operações",),
	"Submetidas, sem Processo nem Repreensão, com o prazo a acabar ou expirado.")
def participacao_sem_seguimento():
	from sigos.disciplinar.prazos import estado, prazo_processo
	prazo, out = prazo_processo(), []
	for p in frappe.get_all("Participacao",
			filters={"docstatus": 1, "processo_disciplinar": ["is", "not set"],
				"repreensao": ["is", "not set"], "data_conhecimento_infracao": ["is", "set"]},
			fields=["name", "nome_do_vigilante", "delegacao", "data_conhecimento_infracao"]):
		e = estado(p.data_conhecimento_infracao, prazo)
		if e["restam"] > PARTICIPACAO_AVISO_PRAZO:
			continue
		detalhe = (_("Prazo expirou em {0}").format(_data(e["limite"])) if e["expirado"]
			else _("Prazo até {0} · faltam {1} dias").format(_data(e["limite"]), e["restam"]))
		out.append(linha("Participacao", p.name, p.nome_do_vigilante, p.name, detalhe, p.delegacao,
			-e["restam"], CRITICO if e["restam"] <= 2 else AVISO))
	return out


@verificacao("participacao_rascunho", "disciplinar", "Participações por submeter", AVISO, OPS,
	f"Em rascunho há mais de {PARTICIPACAO_RASCUNHO} dias.")
def participacao_rascunho():
	return [
		linha("Participacao", p.name, p.nome_do_vigilante, p.name,
			_("Criada há {0} dias · conhecimento {1}").format(_ha(p.creation), _data(p.data_conhecimento_infracao)),
			p.delegacao, _ha(p.creation))
		for p in frappe.get_all("Participacao",
			filters={"docstatus": 0, "creation": ["<", add_days(now_datetime(), -PARTICIPACAO_RASCUNHO)]},
			fields=["name", "nome_do_vigilante", "delegacao", "creation", "data_conhecimento_infracao"])
	]


@verificacao("pd_prazos", "disciplinar", "Processos com prazo a acabar", AVISO, JURISTA,
	"Defesa ou decisão a vencer nos próximos dias.")
def pd_prazos():
	out = []
	for pd in frappe.get_all("Processo Disciplinar",
			filters={"docstatus": 0, "fase": ["in", ["Defesa", "Diligências", "Decisão"]]},
			fields=["name", "nome_do_vigilante", "delegacao", "fase", "prazo_defesa", "prazo_decisao",
				"defesa_apresentada"]):
		motivos, minimo = [], None
		if pd.fase == "Defesa" and pd.prazo_defesa and not pd.defesa_apresentada:
			r = date_diff(pd.prazo_defesa, today())
			if 0 <= r <= PD_AVISO_DEFESA:
				motivos.append(_("defesa até {0}").format(_data(pd.prazo_defesa)))
				minimo = r
		if pd.prazo_decisao:
			r = date_diff(pd.prazo_decisao, today())
			if 0 <= r <= PD_AVISO_DECISAO:
				motivos.append(_("decisão até {0}").format(_data(pd.prazo_decisao)))
				minimo = r if minimo is None else min(minimo, r)
		if motivos:
			out.append(linha("Processo Disciplinar", pd.name, pd.nome_do_vigilante, pd.name,
				"{0} · {1}".format(_(pd.fase), ", ".join(motivos)), pd.delegacao, -minimo,
				CRITICO if minimo == 0 else AVISO))
	return out


@verificacao("pd_sindicato", "disciplinar", "Processos com o Sindicato", AVISO, JURISTA,
	"Diligências fora de prazo: aguardam parecer e decisão.")
def pd_sindicato():
	return [
		linha("Processo Disciplinar", pd.name, pd.nome_do_vigilante, pd.name,
			_("Com o Sindicato desde {0}").format(_data(pd.sindicato_desde)), pd.delegacao, _ha(pd.sindicato_desde))
		for pd in frappe.get_all("Processo Disciplinar", filters={"docstatus": 0, "fase": "Sindicato"},
			fields=["name", "nome_do_vigilante", "delegacao", "sindicato_desde"])
	]


@verificacao("pd_caducado", "disciplinar", "Processos caducados", CRITICO, JURISTA,
	"Sem decisão dentro do prazo. Só um gestor pode decidir.")
def pd_caducado():
	return [
		linha("Processo Disciplinar", pd.name, pd.nome_do_vigilante, pd.name,
			_("Prazo de decisão era {0}").format(_data(pd.prazo_decisao)), pd.delegacao, _ha(pd.prazo_decisao))
		for pd in frappe.get_all("Processo Disciplinar", filters={"docstatus": 0, "fase": "Caducado"},
			fields=["name", "nome_do_vigilante", "delegacao", "prazo_decisao"])
	]


# ═══ Salários ═══════════════════════════════════════════════════════════════════

@verificacao("sem_salario", "salarios", "Sem salário base", CRITICO, RH,
	"Activos ou em Reserva sem Salary Structure Assignment submetida.")
def sem_salario():
	return [
		_lv(v, _("{0} · sem salário atribuído").format(_(v.status)), _ha(v.creation))
		for v in frappe.db.sql("""
			SELECT v.name, v.nome_completo, v.mecanografico, v.delegacao, v.status, v.creation
			FROM `tabVigilante` v
			WHERE v.status IN ('Activo', 'Reserva') AND IFNULL(v.funcionario, '') != ''
			  AND NOT EXISTS (SELECT 1 FROM `tabSalary Structure Assignment` s
				WHERE s.employee = v.funcionario AND s.docstatus = 1)
		""", as_dict=True)
	]


@correcao("sem_salario", "contrato", "Aplicar salário do contrato", RH,
	confirmar="Atribui o salário resolvido pelo contrato, regime e categoria.")
def _aplicar_salario(nome, params):
	from sigos.api import aplicar_salario_base, resolver_salario_base
	r = aplicar_salario_base(vigilante=nome, silent=True)
	if not r:
		frappe.throw(_("Defina a Estrutura Salarial Padrão em SIGOS Settings."))
	if not (r.get("atribuido") or r.get("actualizado")):
		frappe.throw(_("Sem salário no contrato — use Definir salário."))
	return fmt_money(resolver_salario_base(nome))


@correcao("sem_salario", "valor", "Definir salário", RH,
	campos=[{"fieldname": "valor", "fieldtype": "Currency", "label": "Salário base", "reqd": 1}])
def _definir_salario(nome, params):
	from sigos.api import definir_salario_base
	r = definir_salario_base(nome, valor=flt(params.valor), confirmar_reducao=1) or {}
	return fmt_money(r.get("base"))


@verificacao("congelado_sem_motivo", "salarios", "Salário congelado sem motivo", CRITICO, RH,
	"Salário congelado de quem já não está em Abandono, Doente ou Suspenso.")
def congelado_sem_motivo():
	return [
		_lv(v, _("{0} · congelado desde {1}").format(_(v.status), _data(v.salario_congelado_desde)),
			_ha(v.salario_congelado_desde))
		for v in _vigilantes({"salario_congelado": 1,
			"status": ["not in", ["Abandono de Posto", "Doente", "Suspenso Preventivamente"]]},
			("salario_congelado_desde",))
	]


@correcao("congelado_sem_motivo", "descongelar", "Descongelar", RH,
	campos=[{"fieldname": "motivo", "fieldtype": "Small Text", "label": "Motivo"}],
	confirmar="Volta a entrar nas folhas de salário. Processe depois os meses em falta.")
def _descongelar(nome, params):
	return frappe.get_doc("Vigilante", nome).descongelar_salario(params.motivo)


@verificacao("sem_dados_bancarios", "salarios", "Sem conta bancária", AVISO, RH,
	"Sem NIB no Funcionário: ficam fora da folha do banco.")
def sem_dados_bancarios():
	if not frappe.db.has_column("Employee", "custom_contanib"):
		return []
	return [
		_lv(v, _("{0} · sem NIB").format(_(v.status)))
		for v in frappe.db.sql("""
			SELECT v.name, v.nome_completo, v.mecanografico, v.delegacao, v.status
			FROM `tabVigilante` v JOIN `tabEmployee` e ON e.name = v.funcionario
			WHERE v.status IN ('Activo', 'Reserva') AND IFNULL(e.custom_contanib, '') = ''
		""", as_dict=True)
	]


@verificacao("sem_nuit_inss", "salarios", "Sem NUIT ou INSS", INFO, RH,
	"Dados fiscais em falta.")
def sem_nuit_inss():
	out = []
	for v in _vigilantes({"status": ["in", list(EMPREGADOS)]}, ("nuit", "inss")):
		falta = [n for n, val in (("NUIT", v.nuit), ("INSS", v.inss)) if not (val or "").strip()]
		if falta:
			out.append(_lv(v, _("Falta: {0}").format(", ".join(falta))))
	return out


@verificacao("folhas_rascunho", "salarios", "Folhas de salário em rascunho", AVISO, RH,
	"Salary Slips de períodos já terminados por submeter.")
def folhas_rascunho():
	return [
		linha("Salary Slip", s.name, s.employee_name, s.employee,
			_("{0} a {1}").format(_data(s.start_date), _data(s.end_date)), None, _ha(s.end_date))
		for s in frappe.get_all("Salary Slip", filters={"docstatus": 0, "end_date": ["<", today()]},
			fields=["name", "employee", "employee_name", "start_date", "end_date"])
	]


@verificacao("sem_folha_mes_anterior", "salarios", "Sem folha do último período", AVISO, RH,
	"O último período foi processado, mas estes vigilantes ficaram de fora.")
def sem_folha_mes_anterior():
	from sigos.utils import resolver_periodo_folha
	ref = add_months(get_first_day(today()), -1)
	inicio, fim = resolver_periodo_folha(ref.month, ref.year)
	if not frappe.db.exists("Salary Slip", {"docstatus": 1, "start_date": [">=", inicio], "end_date": ["<=", fim]}):
		return []  # that period hasn't been processed yet
	periodo = _("{0} a {1}").format(_data(inicio), _data(fim))
	return [
		_lv(v, _("Sem folha de {0}").format(periodo))
		for v in frappe.db.sql("""
			SELECT v.name, v.nome_completo, v.mecanografico, v.delegacao
			FROM `tabVigilante` v JOIN `tabEmployee` e ON e.name = v.funcionario
			WHERE v.status IN ('Activo', 'Reserva') AND IFNULL(v.salario_congelado, 0) = 0
			  AND e.date_of_joining <= %(fim)s
			  AND NOT EXISTS (SELECT 1 FROM `tabSalary Slip` s WHERE s.employee = e.name
				AND s.docstatus < 2 AND s.start_date <= %(fim)s AND s.end_date >= %(inicio)s)
		""", {"inicio": inicio, "fim": fim}, as_dict=True)
	]


# ═══ RH e Cadastro ══════════════════════════════════════════════════════════════

@verificacao("sem_funcionario", "rh", "Sem Funcionário", CRITICO, RH,
	"Vigilantes empregados sem Employee: não entram na folha.")
def sem_funcionario():
	return [_lv(v, _(v.status), _ha(v.creation))
		for v in _vigilantes({"status": ["in", list(EMPREGADOS)], "funcionario": ["is", "not set"]})]


@verificacao("employee_dessincronizado", "rh", "Funcionário com estado errado", CRITICO, RH,
	"O estado do Employee não corresponde ao do Vigilante.")
def employee_dessincronizado():
	from sigos.security_ops.doctype.vigilante.vigilante import VIGILANTE_TO_EMP_STATUS
	out = []
	for v in frappe.db.sql("""
			SELECT v.name, v.nome_completo, v.mecanografico, v.delegacao, v.status, e.status AS emp_status
			FROM `tabVigilante` v JOIN `tabEmployee` e ON e.name = v.funcionario
		""", as_dict=True):
		esperado = VIGILANTE_TO_EMP_STATUS.get(v.status)
		if esperado and v.emp_status != esperado:
			out.append(_lv(v, _("Vigilante {0} · Employee {1} (devia ser {2})").format(
				_(v.status), _(v.emp_status), _(esperado))))
	return out


@correcao("employee_dessincronizado", "sincronizar", "Sincronizar", RH)
def _sincronizar(nome, params):
	from sigos.security_ops.doctype.vigilante.vigilante import VIGILANTE_TO_EMP_STATUS
	from sigos.sync import vigilante_to_employee
	vig = frappe.get_doc("Vigilante", nome)
	vigilante_to_employee(vig)
	actual = frappe.db.get_value("Employee", vig.funcionario, "status")
	if actual != VIGILANTE_TO_EMP_STATUS.get(vig.status):
		frappe.throw(_("Não foi possível actualizar o Employee {0} (ver Error Log).").format(vig.funcionario))
	return _("Employee {0}").format(_(actual))


_PEDIDOS_RH = (
	("Justificacao De Faltas", "funcionario"),
	("Outras Deducoes", "funcionario_nome"),
	("Outras Remuneracoes", "funcionario_nome"),
	("Emprestimo", "funcionario_nome"),
	("Pedido De Licenca", "nome_do_vigilante"),
	("Reclamacao De Salario", "funcionario_nome"),
)


@verificacao("pedidos_por_aprovar", "rh", "Pedidos por aprovar", AVISO, RH,
	f"Pedidos de RH em rascunho há mais de {PEDIDO_PARADO} dias.")
def pedidos_por_aprovar():
	limite, out = add_days(now_datetime(), -PEDIDO_PARADO), []
	for dt, campo_nome in _PEDIDOS_RH:
		if not frappe.db.table_exists(dt):
			continue
		campos = ["name", "creation", campo_nome]
		if frappe.db.has_column(dt, "workflow_state"):
			campos.append("workflow_state")
		if frappe.db.has_column(dt, "delegacao"):
			campos.append("delegacao")
		for d in frappe.get_all(dt, filters={"docstatus": 0, "creation": ["<", limite]}, fields=campos):
			estado = d.get("workflow_state") or _("Rascunho")
			out.append(linha(dt, d.name, d.get(campo_nome) or d.name, d.name,
				_("{0} · {1} · há {2} dias").format(_(dt), _(estado), _ha(d.creation)),
				d.get("delegacao"), _ha(d.creation)))
	return out


@verificacao("rotatividades_por_aprovar", "rh", "Rotatividades por aprovar", AVISO, OPS,
	f"Rotatividades em rascunho há mais de {ROTATIVIDADE_PARADA} dias.")
def rotatividades_por_aprovar():
	campos = ["name", "creation", "vigilante", "abreviatura_op", "delegacao"]
	if frappe.db.has_column("Rotatividade", "workflow_state"):
		campos.append("workflow_state")
	nomes = {}
	rots = frappe.get_all("Rotatividade",
		filters={"docstatus": 0, "creation": ["<", add_days(now_datetime(), -ROTATIVIDADE_PARADA)]},
		fields=campos)
	if rots:
		nomes = dict(frappe.get_all("Vigilante", filters={"name": ["in", [r.vigilante for r in rots if r.vigilante]] or [""]},
			fields=["name", "nome_completo"], as_list=True))
	return [
		linha("Rotatividade", r.name, nomes.get(r.vigilante) or r.vigilante or r.name, r.name,
			_("{0} · {1} · há {2} dias").format(r.abreviatura_op or "—", _(r.get("workflow_state") or "Rascunho"),
				_ha(r.creation)), r.delegacao, _ha(r.creation))
		for r in rots
	]


@verificacao("pre_admissao_parada", "rh", "Pré-admissões paradas", INFO, RH,
	f"Em pré-admissão há mais de {PRE_ADMISSAO_PARADA} dias.")
def pre_admissao_parada():
	return [_lv(v, _("{0} desde {1}").format(_(v.status), _data(v.creation)), _ha(v.creation))
		for v in _vigilantes({"status": ["in", ["Pre-Adimissão RH", "Pre-Adimissão"]],
			"creation": ["<", add_days(now_datetime(), -PRE_ADMISSAO_PARADA)]})]


# ═══ Armamento e Material ═══════════════════════════════════════════════════════

@verificacao("material_com_saidos", "armamento", "Material com ex-vigilantes", AVISO, OPS,
	"Material retornável ainda com vigilantes Demitidos ou Inactivos.")
def material_com_saidos():
	return [
		linha("Alocacao De Material", a.name, a.nome_completo, a.name,
			_("{0} · {1} artigo(s) por devolver").format(_(a.status), cint(a.pendentes)), a.delegacao, _ha(a.data))
		for a in frappe.db.sql("""
			SELECT a.name, a.data, a.delegacao, v.nome_completo, v.status,
				SUM(i.quantidade - IFNULL(i.qtd_devolvida, 0)) AS pendentes
			FROM `tabAlocacao De Material` a
			JOIN `tabVigilante` v ON v.name = a.vigilante
			JOIN `tabAlocacao Material Item` i ON i.parent = a.name AND i.parenttype = 'Alocacao De Material'
			WHERE a.docstatus = 1 AND a.alocar_a = 'Vigilante' AND a.estado IN ('Alocado', 'Devolvido Parcial')
			  AND v.status IN ('Demitido', 'Inactivo') AND i.retornavel = 1
			  AND i.quantidade > IFNULL(i.qtd_devolvida, 0)
			GROUP BY a.name
		""", as_dict=True)
	]


@verificacao("armas_posto_inactivo", "armamento", "Armas em postos inactivos", AVISO, OPS,
	"Armas atribuídas a postos que já fecharam.")
def armas_posto_inactivo():
	return [
		linha("Arma", a.name, a.numero_da_arma or a.name, a.name,
			_("{0} · posto {1} inactivo").format(_(a.tipo or "Arma"), a.posto), a.delegacao)
		for a in frappe.db.sql("""
			SELECT a.name, a.numero_da_arma, a.tipo, a.posto, a.delegacao
			FROM `tabArma` a JOIN `tabPosto De Vigilancia` p ON p.name = a.posto
			WHERE p.estado = 'Inactivo'
		""", as_dict=True)
	]


# ═══ Faturação ══════════════════════════════════════════════════════════════════

def _linhas_faturacao():
	"""calcular_linhas once per request (two checks use it)."""
	if frappe.flags.saude_linhas_faturacao is None:
		from sigos.sigos_setup.doctype.faturacao_mensal.faturacao_mensal import calcular_linhas
		frappe.flags.saude_linhas_faturacao = calcular_linhas()[0]
	return frappe.flags.saude_linhas_faturacao


@verificacao("nao_facturados", "faturacao", "Clientes por facturar", CRITICO, FIN,
	"Clientes com contratos facturáveis sem factura SIGOS do mês anterior.")
def nao_facturados():
	from sigos.sigos_setup.doctype.faturacao_mensal.faturacao_mensal import (
		_clientes_ja_faturados, empresa_faturacao,
	)
	company = empresa_faturacao()
	if not company:
		return []
	mes = add_months(get_first_day(today()), -1)
	totais = {}
	for l in _linhas_faturacao():
		if l["cliente"] and l["quantidade"] and l["valor_unitario"]:
			totais[l["cliente"]] = totais.get(l["cliente"], 0) + flt(l["total"])
	if not totais:
		return []
	ja = _clientes_ja_faturados(company, mes, set(totais))
	nomes = dict(frappe.get_all("Customer", filters={"name": ["in", list(totais)]},
		fields=["name", "customer_name"], as_list=True))
	return [
		linha("Customer", c, nomes.get(c) or c, c,
			_("Sem factura de {0} · previsto {1}").format(formatdate(mes, "MMMM yyyy"), fmt_money(t)),
			None, date_diff(today(), mes))
		for c, t in sorted(totais.items()) if c not in ja
	]


@correcao("nao_facturados", "faturar", "Abrir Faturação", FIN, em_massa=False)
def _faturar(nome, params):
	from sigos.sigos_setup.doctype.faturacao_mensal.faturacao_mensal import faturar_cliente
	run = faturar_cliente(nome, add_months(get_first_day(today()), -1))
	return {"msg": run, "rota": ["Form", "Faturacao Mensal", run]}


@verificacao("sem_tarifa", "faturacao", "Contratos sem tarifa", CRITICO, FIN,
	"Regimes com vigilantes mas sem preço: não são facturados.")
def sem_tarifa():
	from sigos.contrato import nomes_faturacao_categorias, rotulo_tarifa
	nomes = nomes_faturacao_categorias()
	grupos = {}
	for l in _linhas_faturacao():
		if l["quantidade"] and not l["valor_unitario"]:
			chave = (l["project"], rotulo_tarifa(l["regime"], l.get("categoria"), nomes))
			g = grupos.setdefault(chave, {"cliente": l["cliente"], "n": 0})
			g["n"] += cint(l["quantidade"])
	return [
		linha("Project", f"{proj} · {regime}", proj, regime,
			_("{0} · {1} vigilantes sem preço").format(g["cliente"] or "—", g["n"]), None, g["n"],
			link=("Project", proj))
		for (proj, regime), g in sorted(grupos.items())
	]


@verificacao("faturas_rascunho", "faturacao", "Facturas SIGOS em rascunho", AVISO, FIN,
	f"Facturas mensais em rascunho há mais de {FATURA_RASCUNHO} dias.")
def faturas_rascunho():
	if not frappe.db.has_column("Sales Invoice", "custom_mes_referencia"):
		return []
	return [
		linha("Sales Invoice", s.name, s.customer_name, s.name,
			_("{0} · {1}").format(formatdate(s.custom_mes_referencia, "MMMM yyyy"),
				fmt_money(s.grand_total, currency=s.currency)), None, _ha(s.creation))
		for s in frappe.get_all("Sales Invoice",
			filters={"docstatus": 0, "custom_mes_referencia": ["is", "set"],
				"creation": ["<", add_days(now_datetime(), -FATURA_RASCUNHO)]},
			fields=["name", "customer_name", "custom_mes_referencia", "grand_total", "currency", "creation"])
	]


@correcao("faturas_rascunho", "submeter", "Submeter", FIN, perigosa=True,
	confirmar="As facturas ficam emitidas e lançadas na contabilidade.")
def _submeter_fatura(nome, params):
	si = frappe.get_doc("Sales Invoice", nome)
	si.submit()
	return fmt_money(si.grand_total, currency=si.currency)


@verificacao("faturas_vencidas", "faturacao", "Facturas vencidas", AVISO, FIN,
	"Facturas com valor em dívida depois do vencimento.")
def faturas_vencidas():
	return [
		linha("Sales Invoice", s.name, s.customer_name, s.name,
			_("Vencida há {0} dias · em dívida {1}").format(_ha(s.due_date),
				fmt_money(s.outstanding_amount, currency=s.currency)),
			None, _ha(s.due_date), CRITICO if _ha(s.due_date) > FATURA_VENCIDA_CRITICA else None)
		for s in frappe.get_all("Sales Invoice",
			filters={"docstatus": 1, "is_return": 0, "outstanding_amount": [">", 0], "due_date": ["<", today()]},
			fields=["name", "customer_name", "due_date", "outstanding_amount", "currency"])
	]


@verificacao("faturacao_auto_falhada", "faturacao", "Facturação automática bloqueada", AVISO, FIN,
	"Execuções automáticas que não geraram factura.")
def faturacao_auto_falhada():
	desde = add_months(get_first_day(today()), -1)
	return [
		linha("Faturacao Mensal", f.name, f.cliente, f.name,
			"{0} · {1}".format(formatdate(f.mes_referencia, "MMMM yyyy"),
				strip_html_tags(f.registo_automatico or "").strip()[:140] or _("sem factura")),
			None, _ha(f.creation))
		for f in frappe.get_all("Faturacao Mensal",
			filters={"automatica": 1, "faturas_geradas": ["is", "not set"], "mes_referencia": [">=", desde]},
			fields=["name", "cliente", "mes_referencia", "registo_automatico", "creation"])
	]
