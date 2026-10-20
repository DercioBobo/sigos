"""
Tramitação do Processo Disciplinar — phases, deadlines and the sanctions' effects.

Calendar days from the Data de Abertura (`data`), SIGOS Settings (Processo
Disciplinar — Prazos):
  - Defesa: pd_prazo_defesa_dias (15) to present the defense; after it the right is
    lost (registar_defesa refuses).
  - Diligências: requested within the defense period, pd_prazo_diligencias_dias (5).
    Going past them sends the process to the Sindicato (marked + Jurista notified;
    the Jurista still records the decision).
  - Decisão: pd_prazo_decisao_dias (30) for the final decision; past it the process is
    "Caducado" — submitting a decision is refused unless a manager justifies it.
Fase (read-only) is recomputed on every save and by the daily job.

Sanctions (decisão) and their effects (applied when the process is approved):
  Repreensão / Termo de Responsabilidade / Arquivamento — recorded;
  Suspensão do Trabalho (≤10 days) — those days unpaid and no absences recorded
    (dias_suspensao_trabalho / periodo_suspensao_trabalho);
  Multa (≤20 days of salary) — base/30 × days via Outras Deduções;
  Despromoção (immediately lower category, ≤12 months) — Troca De Categoria at the
    start, reverted by the daily job after the end;
  Despedimento — Demissão (as before).
"""

import frappe
from frappe import _
from frappe.utils import add_days, add_months, cint, date_diff, flt, getdate, today

FASE_DEFESA = "Defesa"
FASE_DILIGENCIAS = "Diligências"
FASE_SINDICATO = "Sindicato"
FASE_DECISAO = "Decisão"
FASE_CONCLUIDO = "Concluído"
FASE_CADUCADO = "Caducado"

D_REPREENSAO = "Repreensão"
D_SUSPENSAO = "Suspensão do Trabalho"
D_MULTA = "Multa"
D_DESPROMOCAO = "Despromoção"
D_TERMO = "Termo de Responsabilidade"
D_DESPEDIMENTO = "Despedimento"
D_ARQUIVAMENTO = "Arquivamento"

MAX_SUSPENSAO_DIAS = 10
MAX_MULTA_DIAS = 20
MAX_DESPROMOCAO_MESES = 12

PAPEIS_TRAMITACAO = ("System Manager", "SIGOS Manager", "Jurista", "Aprovador RH")


def _setting(campo, padrao):
	from sigos.utils import valor_settings_bruto
	v = valor_settings_bruto(campo)
	return padrao if v in (None, "", "0", 0) else cint(v)


def prazo_defesa():
	return _setting("pd_prazo_defesa_dias", 15)


def prazo_diligencias():
	return _setting("pd_prazo_diligencias_dias", 5)


def prazo_decisao():
	return _setting("pd_prazo_decisao_dias", 30)


# ─── Deadlines + phase ──────────────────────────────────────────────────────────

def calcular_prazos(pd):
	if not pd.data:
		return
	abertura = getdate(pd.data)
	pd.prazo_defesa = add_days(abertura, prazo_defesa())
	pd.prazo_decisao = add_days(abertura, prazo_decisao())
	if pd.data_pedido_diligencias:
		pd.prazo_diligencias = add_days(getdate(pd.data_pedido_diligencias), prazo_diligencias())


def calcular_fase(pd, hoje=None):
	hoje = getdate(hoje or today())
	if pd.docstatus == 1:
		return FASE_CONCLUIDO
	if pd.prazo_decisao and hoje > getdate(pd.prazo_decisao):
		return FASE_CADUCADO
	if pd.sindicato_desde:
		return FASE_SINDICATO
	if pd.data_pedido_diligencias and not pd.diligencias_concluidas_em:
		if pd.prazo_diligencias and hoje > getdate(pd.prazo_diligencias):
			return FASE_SINDICATO
		return FASE_DILIGENCIAS
	if not pd.defesa_apresentada and pd.prazo_defesa and hoje <= getdate(pd.prazo_defesa):
		return FASE_DEFESA
	return FASE_DECISAO


def actualizar_estado(pd, hoje=None):
	"""Recompute deadlines + phase on the doc in memory; stamp the Sindicato
	hand-over the first time the diligências run past their deadline."""
	calcular_prazos(pd)
	fase = calcular_fase(pd, hoje)
	if fase == FASE_SINDICATO and not pd.sindicato_desde:
		pd.sindicato_desde = add_days(getdate(pd.prazo_diligencias), 1) if pd.prazo_diligencias else today()
	pd.fase = fase
	return fase


# ─── Guard's defense / diligências (whitelisted through the PD controller) ──────

def registar_defesa(pd, texto=None, anexo=None, data=None):
	frappe.only_for(PAPEIS_TRAMITACAO)
	_rascunho(pd)
	data = getdate(data or today())
	if pd.defesa_apresentada:
		frappe.throw(_("A defesa já foi registada."))
	if not (texto or anexo):
		frappe.throw(_("Escreva a defesa ou anexe o documento."))
	calcular_prazos(pd)
	if pd.prazo_defesa and data > getdate(pd.prazo_defesa):
		frappe.throw(
			_("O prazo de defesa terminou a <b>{0}</b> ({1} dias após a abertura) — o vigilante perdeu o "
			  "direito de apresentar a defesa.").format(
				frappe.format_value(pd.prazo_defesa, {"fieldtype": "Date"}), prazo_defesa()),
			title=_("Prazo de Defesa Expirado"))
	pd.defesa_apresentada = 1
	pd.data_defesa = data
	pd.defesa = texto
	pd.defesa_anexo = anexo
	_guardar(pd, _("Defesa apresentada em {0}.").format(frappe.format_value(data, {"fieldtype": "Date"})))


def pedir_diligencias(pd, descricao, data=None):
	frappe.only_for(PAPEIS_TRAMITACAO)
	_rascunho(pd)
	data = getdate(data or today())
	if pd.data_pedido_diligencias:
		frappe.throw(_("As diligências já foram pedidas."))
	if not (descricao or "").strip():
		frappe.throw(_("Descreva as diligências / investigação pedidas."))
	calcular_prazos(pd)
	if pd.prazo_defesa and data > getdate(pd.prazo_defesa):
		frappe.throw(_("As diligências só podem ser pedidas durante o prazo de defesa (até {0}).").format(
			frappe.format_value(pd.prazo_defesa, {"fieldtype": "Date"})), title=_("Fora do Prazo de Defesa"))
	pd.data_pedido_diligencias = data
	pd.diligencias_pedidas = descricao.strip()
	_guardar(pd, _("Diligências pedidas em {0} (até {1} dias).").format(
		frappe.format_value(data, {"fieldtype": "Date"}), prazo_diligencias()))


def concluir_diligencias(pd, resultado, data=None):
	frappe.only_for(PAPEIS_TRAMITACAO)
	_rascunho(pd)
	if not pd.data_pedido_diligencias:
		frappe.throw(_("Não há diligências pedidas."))
	if pd.diligencias_concluidas_em:
		frappe.throw(_("As diligências já foram concluídas."))
	pd.diligencias_concluidas_em = getdate(data or today())
	pd.diligencias_resultado = (resultado or "").strip() or None
	_guardar(pd, _("Diligências concluídas em {0}.").format(
		frappe.format_value(pd.diligencias_concluidas_em, {"fieldtype": "Date"})))


def _rascunho(pd):
	if pd.docstatus != 0:
		frappe.throw(_("O processo já tem decisão final."))


def _guardar(pd, nota):
	pd.flags.ignore_permissions = True
	pd.save()
	from sigos.timeline import registar
	registar(pd.vigilante, _("Processo Disciplinar <b>{0}</b>: {1}").format(pd.name, nota), pd)


# ─── Decision checks (before_submit) ────────────────────────────────────────────

def validar_decisao(pd):
	from sigos.disciplinar.prazos import pode_forcar

	dec = (pd.decisao or "").strip()
	if not dec:
		frappe.throw(_("Escolha a <b>Decisão</b> (sanção) antes de submeter."), title=_("Sem Decisão"))
	actualizar_estado(pd)
	if pd.fase == FASE_CADUCADO:
		msg = _("O processo caducou: a decisão final tinha de ser tomada até <b>{0}</b> ({1} dias após a "
			"abertura).").format(frappe.format_value(pd.prazo_decisao, {"fieldtype": "Date"}), prazo_decisao())
		if not pode_forcar():
			frappe.throw(msg + "<br>" + _("Só um gestor (SIGOS Manager) pode decidir fora de prazo, com justificação."),
				title=_("Processo Caducado"))
		if not (pd.justificacao_caducidade or "").strip():
			frappe.throw(msg + "<br>" + _("Escreva a <b>Justificação (Caducidade)</b> para decidir."),
				title=_("Processo Caducado"))
	if dec == D_SUSPENSAO:
		n = cint(pd.suspensao_dias)
		if not 1 <= n <= MAX_SUSPENSAO_DIAS:
			frappe.throw(_("Suspensão do trabalho: entre 1 e {0} dias.").format(MAX_SUSPENSAO_DIAS))
		if not pd.suspensao_inicio:
			frappe.throw(_("Indique o início da suspensão do trabalho."))
		pd.suspensao_fim = add_days(getdate(pd.suspensao_inicio), n - 1)
	elif dec == D_MULTA:
		n = cint(pd.multa_dias)
		if not 1 <= n <= MAX_MULTA_DIAS:
			frappe.throw(_("Multa: entre 1 e {0} dias de salário.").format(MAX_MULTA_DIAS))
		pd.multa_valor = valor_multa(pd.vigilante, n)
		if not pd.data_de_inicio:
			frappe.throw(_("Indique a data de início do desconto da multa."))
	elif dec == D_DESPROMOCAO:
		meses = cint(pd.despromocao_meses)
		if not 1 <= meses <= MAX_DESPROMOCAO_MESES:
			frappe.throw(_("Despromoção: entre 1 e {0} meses.").format(MAX_DESPROMOCAO_MESES))
		atual = frappe.db.get_value("Vigilante", pd.vigilante, "categoria")
		pd.categoria_anterior = atual
		inferior = frappe.db.get_value("Categoria Vigilante", atual, "categoria_inferior") if atual else None
		pd.despromocao_categoria = pd.despromocao_categoria or inferior
		if not pd.despromocao_categoria:
			frappe.throw(_("Indique a categoria imediatamente inferior (defina-a também na Categoria <b>{0}</b>).").format(
				atual or "-"))
		if pd.despromocao_categoria == atual:
			frappe.throw(_("A categoria de despromoção tem de ser diferente da actual."))
		if inferior and pd.despromocao_categoria != inferior:
			frappe.throw(_("A despromoção é para a categoria <b>imediatamente inferior</b>: {0}.").format(inferior))
		if not pd.despromocao_inicio:
			pd.despromocao_inicio = today()
		pd.despromocao_fim = add_days(add_months(getdate(pd.despromocao_inicio), meses), -1)
	elif dec == D_TERMO:
		if not pd.termo_de_responsabilidade:
			frappe.throw(_("Anexe o <b>Termo de Responsabilidade</b> assinado."))


def valor_multa(vigilante, dias):
	from sigos.api import resolver_salario_base
	return round(flt(resolver_salario_base(vigilante)) / 30 * cint(dias), 2)


# ─── Effects ───────────────────────────────────────────────────────────────────

def aplicar_despromocao(pd):
	"""Lower the category (Troca De Categoria) once the start day has come."""
	if pd.despromocao_aplicada or not pd.despromocao_inicio or getdate(pd.despromocao_inicio) > getdate(today()):
		return
	_troca_categoria(pd, pd.despromocao_categoria,
		_("Despromoção — Processo Disciplinar {0} (até {1})").format(
			pd.name, frappe.format_value(pd.despromocao_fim, {"fieldtype": "Date"})))
	pd.db_set("despromocao_aplicada", 1)


def reverter_despromocao(pd):
	if not pd.despromocao_aplicada or pd.despromocao_revertida or not pd.despromocao_fim:
		return
	if getdate(pd.despromocao_fim) >= getdate(today()):
		return
	if pd.categoria_anterior:
		_troca_categoria(pd, pd.categoria_anterior,
			_("Fim da despromoção — Processo Disciplinar {0}").format(pd.name))
	pd.db_set("despromocao_revertida", 1)


def _troca_categoria(pd, nova, motivo):
	atual = frappe.db.get_value("Vigilante", pd.vigilante, "categoria")
	if atual == nova:
		return
	troca = frappe.get_doc({
		"doctype": "Troca De Categoria", "data": today(), "vigilante": pd.vigilante,
		"delegacao": frappe.db.get_value("Vigilante", pd.vigilante, "delegacao"),
		"categoria_atual": atual, "categoria_nova": nova, "motivo": motivo,
	})
	if troca.meta.has_field("workflow_state"):
		troca.workflow_state = "Aprovado"  # decided by the process — no second approval
	troca.flags.ignore_permissions = True
	troca.insert()
	troca.submit()


def dias_suspensao_trabalho(vigilante, de, ate):
	"""Set of days of [de, ate] in an approved "Suspensão do Trabalho" sanction —
	unpaid (salary_slip_hooks._dias_fora_emprego)."""
	de, ate = getdate(de), getdate(ate)
	dias = set()
	for p in frappe.get_all(
		"Processo Disciplinar",
		filters={"vigilante": vigilante, "docstatus": 1, "decisao": D_SUSPENSAO,
			"suspensao_inicio": ["<=", ate], "suspensao_fim": [">=", de]},
		fields=["suspensao_inicio", "suspensao_fim"],
	):
		d, f = max(de, getdate(p.suspensao_inicio)), min(ate, getdate(p.suspensao_fim))
		while d <= f:
			dias.add(d)
			d = getdate(add_days(d, 1))
	return dias


def periodo_suspensao_trabalho(vigilante, data):
	nome = frappe.db.get_value(
		"Processo Disciplinar",
		{"vigilante": vigilante, "docstatus": 1, "decisao": D_SUSPENSAO,
		 "suspensao_inicio": ["<=", data], "suspensao_fim": [">=", data]},
		"name",
	)
	return _("Suspensão do Trabalho (Processo Disciplinar {0})").format(nome) if nome else None


# ─── Daily job ─────────────────────────────────────────────────────────────────

def actualizar_processos():
	"""Daily: phase/expiry of open processes (+ Jurista bell on Sindicato/Caducado)
	and despromoção start/end of decided ones."""
	for nome in frappe.get_all("Processo Disciplinar", filters={"docstatus": 0}, pluck="name"):
		try:
			pd = frappe.get_doc("Processo Disciplinar", nome)
			antes, sind_antes = pd.fase, pd.sindicato_desde
			actualizar_estado(pd)
			if pd.fase != antes or pd.sindicato_desde != sind_antes:
				for campo in ("fase", "prazo_defesa", "prazo_decisao", "prazo_diligencias", "sindicato_desde"):
					pd.db_set(campo, pd.get(campo), update_modified=False)
				if pd.fase in (FASE_SINDICATO, FASE_CADUCADO) and antes != pd.fase:
					_notificar(pd)
					from sigos.notificacoes import sinal
					sinal("Processo Disciplinar", pd.name,
						"sigos_pd_sindicato" if pd.fase == FASE_SINDICATO else "sigos_pd_caducado")
			frappe.db.commit()
		except Exception as ex:
			frappe.db.rollback()
			frappe.log_error(f"Processo Disciplinar {nome}: erro na tramitação diária: {ex}", "SIGOS Processo Disciplinar")

	for nome in frappe.get_all(
		"Processo Disciplinar",
		filters={"docstatus": 1, "decisao": D_DESPROMOCAO, "despromocao_revertida": 0},
		pluck="name",
	):
		try:
			pd = frappe.get_doc("Processo Disciplinar", nome)
			if (pd.get("workflow_state") or "Aprovado") != "Aprovado":
				continue
			aplicar_despromocao(pd)
			pd.reload()
			reverter_despromocao(pd)
			frappe.db.commit()
		except Exception as ex:
			frappe.db.rollback()
			frappe.log_error(f"Processo Disciplinar {nome}: erro na despromoção: {ex}", "SIGOS Processo Disciplinar")


def _notificar(pd):
	users = set(frappe.get_all("Has Role", filters={"role": ["in", ["Jurista", "SIGOS Manager"]],
		"parenttype": "User"}, pluck="parent"))
	activos = set(frappe.get_all("User", filters={"enabled": 1, "name": ["in", list(users) or [""]]}, pluck="name"))
	if pd.fase == FASE_SINDICATO:
		assunto = _("Processo {0} passou para o Sindicato").format(pd.name)
		corpo = _("As diligências de <b>{0}</b> ultrapassaram {1} dias — o processo é agora da responsabilidade "
			"do Sindicato. Registe o parecer e a decisão.").format(pd.nome_do_vigilante or pd.vigilante, prazo_diligencias())
	else:
		assunto = _("Processo {0} caducou").format(pd.name)
		corpo = _("O processo de <b>{0}</b> não teve decisão final até {1} ({2} dias).").format(
			pd.nome_do_vigilante or pd.vigilante, frappe.format_value(pd.prazo_decisao, {"fieldtype": "Date"}),
			prazo_decisao())
	for user in activos - {"Administrator", "Guest"}:
		frappe.get_doc({
			"doctype": "Notification Log", "subject": assunto, "email_content": corpo, "for_user": user,
			"type": "Alert", "document_type": "Processo Disciplinar", "document_name": pd.name,
		}).insert(ignore_permissions=True)


@frappe.whitelist()
def simular_multa(vigilante, dias):
	frappe.only_for(PAPEIS_TRAMITACAO)
	return valor_multa(vigilante, dias)
