"""
SIGOS — Acumulação automática de férias (Lei do Trabalho de Moçambique).

POLÍTICA (autoritativa)
-----------------------
- Acumulação MENSAL, no dia de admissão (antiguidade) de cada colaborador:
    • < 1 ano de antiguidade  → +1,0 dia/mês
    • ≥ 1 ano de antiguidade  → +2,5 dias/mês (30/ano)
- TECTO: a partir de 2 anos de antiguidade, no aniversário de admissão o saldo é
  limitado a `dias_maximos_ferias` (padrão 60). O excedente expira.
- Uma ÚNICA Leave Allocation rolante por colaborador (to_date num horizonte
  distante, ex.: 2099-12-31) que reflecte sempre o saldo real — o colaborador pode
  pedir férias e consultar o saldo a qualquer momento.

MECÂNICA (correcta ao nível do ledger)
--------------------------------------
O saldo reservável do HRMS é a SOMA das Leave Ledger Entries, NÃO o campo
`new_leaves_allocated`. Por isso cada acumulação/expiração é escrita como uma
Leave Ledger Entry própria (delta), e os campos da Leave Allocation são apenas
sincronizados para exibição. Escrever directamente em `new_leaves_allocated` (como
fazia o script de origem) NÃO move o saldo — foi o bug que aqui se corrige.

A antiguidade lê-se de Employee.custom_data_antiguidade_ferias (predefinida com
date_of_joining; reposta numa readmissão para reiniciar no ano 1). A janela da
allocation (from_date) é a data de arranque do sistema, separada da antiguidade.

VERIFICAR EM PRODUÇÃO (erpnext-site): confirmar que o saldo (get_leave_balance_on
/ relatório) cresce após uma corrida — i.e. que as Leave Ledger Entries criadas
aqui são somadas no saldo reservável desta versão do HRMS.
"""
import frappe
from frappe.utils import (
	getdate, nowdate, add_months, date_diff, get_last_day, flt, is_leap_year,
)

HORIZONTE_PADRAO = "2099-12-31"


def acumular_ferias():
	"""Entrada diária. Acumula/expira férias a cada colaborador activo, no seu dia."""
	settings = frappe.get_cached_doc("SIGOS Settings")
	if not settings.get("ferias_activo"):
		return

	leave_type = settings.get("leave_type_ferias") or "Ferias"
	cap = flt(settings.get("dias_maximos_ferias")) or 60.0
	company_fallback = settings.get("empresa_padrao") or frappe.defaults.get_global_default("company")

	if not frappe.db.exists("Leave Type", leave_type):
		frappe.log_error(f"Leave Type '{leave_type}' não existe — acumulação de férias ignorada.", "SIGOS Férias")
		return

	hoje = getdate(nowdate())

	employees = frappe.get_all(
		"Employee",
		filters={"status": "Active"},
		fields=[
			"name", "employee_name", "company",
			"date_of_joining", "custom_data_antiguidade_ferias",
			"custom_ultima_acumulacao_ferias", "custom_vigilante",
		],
	)

	for emp in employees:
		try:
			_processar_employee(emp, leave_type, cap, company_fallback, hoje)
			frappe.db.commit()
		except Exception:
			frappe.db.rollback()
			frappe.log_error(frappe.get_traceback(), f"SIGOS Férias — {emp.name}")


def migrar_saldos_iniciais(dry_run=True, company=None):
	"""
	MIGRAÇÃO (correr UMA vez) — semeia o saldo inicial de férias dos colaboradores
	já existentes, de forma correcta ao nível do ledger.

	Saldo teórico = primeiros 12 meses x1 dia + meses seguintes x2,5 dias, menos as
	férias já gozadas (aprovadas), LIMITADO ao tecto (dias_maximos_ferias, padrão 60).
	Cria UMA Leave Allocation submetida por colaborador que ainda não tenha nenhuma
	(o on_submit do HRMS escreve o ledger inicial). Colaboradores que já tenham uma
	alocação de férias são IGNORADOS — por isso é seguro re-correr e não colide com a
	acumulação diária. Fixa a âncora de antiguidade e marca a última acumulação = hoje
	para o motor diário continuar sem duplicar o mês corrente.

	Pré-visualizar:  bench --site <site> execute sigos.ferias.migrar_saldos_iniciais
	Executar mesmo:  bench --site <site> execute sigos.ferias.migrar_saldos_iniciais --kwargs "{'dry_run': False}"
	"""
	if isinstance(dry_run, str):
		dry_run = dry_run.lower() not in ("0", "false", "no", "nao", "não", "")

	settings = frappe.get_cached_doc("SIGOS Settings")
	leave_type = settings.get("leave_type_ferias") or "Ferias"
	cap = flt(settings.get("dias_maximos_ferias")) or 60.0
	company_fallback = company or settings.get("empresa_padrao") or frappe.defaults.get_global_default("company")

	if not frappe.db.exists("Leave Type", leave_type):
		frappe.throw(f"Leave Type '{leave_type}' não existe.")

	hoje = getdate(nowdate())
	emp_filters = {"status": "Active"}
	if company:
		emp_filters["company"] = company

	employees = frappe.get_all(
		"Employee",
		filters=emp_filters,
		fields=["name", "employee_name", "company", "date_of_joining", "custom_data_antiguidade_ferias", "custom_vigilante"],
	)

	res = {"seeded": 0, "skipped_existing": 0, "skipped_zero": 0, "skipped_no_anchor": 0, "errors": 0, "total_dias": 0.0}

	for emp in employees:
		try:
			anchor = emp.get("custom_data_antiguidade_ferias") or emp.get("date_of_joining")
			if not anchor:
				res["skipped_no_anchor"] += 1
				continue
			anchor = getdate(anchor)

			if _buscar_alocacao(emp["name"], leave_type):
				res["skipped_existing"] += 1
				continue

			teorico = _saldo_teorico(anchor, hoje)
			usado = _dias_usados(emp["name"], leave_type)
			saldo = min(max(teorico - usado, 0.0), cap)

			if saldo <= 0:
				# Nada a semear ainda — o motor diário cria a alocação na 1ª acumulação.
				res["skipped_zero"] += 1
				continue

			if not dry_run:
				comp = emp.get("company") or company_fallback
				_criar_alocacao(emp, leave_type, comp, saldo, hoje)
				if not emp.get("custom_data_antiguidade_ferias"):
					frappe.db.set_value("Employee", emp["name"], "custom_data_antiguidade_ferias", anchor, update_modified=False)
				frappe.db.set_value("Employee", emp["name"], "custom_ultima_acumulacao_ferias", hoje, update_modified=False)
				_timeline(emp, f"Saldo inicial de férias: {_fmt(saldo)} dias (migração)")
				frappe.db.commit()

			res["seeded"] += 1
			res["total_dias"] += saldo
		except Exception:
			res["errors"] += 1
			frappe.db.rollback()
			frappe.log_error(frappe.get_traceback(), f"SIGOS Férias Migração — {emp.get('name')}")

	res["total_dias"] = round(res["total_dias"], 1)
	res["modo"] = "PRÉ-VISUALIZAÇÃO (dry_run)" if dry_run else "EXECUTADO"
	frappe.logger().info(f"SIGOS Férias migração: {res}")
	print(f"SIGOS Férias — migração de saldos iniciais: {res}")
	return res


@frappe.whitelist()
def enfileirar_migracao_saldos(dry_run=1):
	"""
	Lança a migração de saldos iniciais de férias num job de fundo.
	Usado pelo botão nas SIGOS Settings — devolve logo e notifica no fim por realtime.
	"""
	frappe.only_for(("System Manager", "SIGOS Manager"))
	job = frappe.enqueue(
		"sigos.ferias._migracao_em_fila",
		queue="long",
		timeout=3600,
		dry_run=dry_run,
		user=frappe.session.user,
	)
	return {"job_id": getattr(job, "id", None)}


def _migracao_em_fila(dry_run=1, user=None):
	"""Executa a migração e notifica o utilizador que a lançou (evento realtime)."""
	res = migrar_saldos_iniciais(dry_run=dry_run)
	frappe.publish_realtime("sigos_ferias_migracao", res, user=user or frappe.session.user)
	return res


def _saldo_teorico(anchor, hoje):
	"""Dias acumulados por antiguidade: 12 meses x1 + meses seguintes x2,5 (meses completos)."""
	meses = (hoje.year - anchor.year) * 12 + (hoje.month - anchor.month)
	if hoje.day < anchor.day:
		meses -= 1
	if meses <= 0:
		return 0.0
	m1 = min(meses, 12)
	m2 = max(meses - 12, 0)
	return m1 * 1.0 + m2 * 2.5


def _dias_usados(employee, leave_type):
	"""Férias já gozadas (Leave Applications aprovadas e submetidas)."""
	val = frappe.db.sql(
		"""
		SELECT IFNULL(SUM(total_leave_days), 0)
		FROM `tabLeave Application`
		WHERE employee = %s AND leave_type = %s AND status = 'Approved' AND docstatus = 1
		""",
		(employee, leave_type),
	)
	return flt(val[0][0]) if val else 0.0


def _processar_employee(emp, leave_type, cap, company_fallback, hoje):
	anchor = emp.get("custom_data_antiguidade_ferias") or emp.get("date_of_joining")
	if not anchor:
		return
	anchor = getdate(anchor)

	# Fixar a antiguidade no Employee (estável e visível; sobrevive a edições do DOJ).
	if not emp.get("custom_data_antiguidade_ferias"):
		frappe.db.set_value("Employee", emp["name"], "custom_data_antiguidade_ferias", anchor, update_modified=False)

	company = emp.get("company") or company_fallback
	alloc = _buscar_alocacao(emp["name"], leave_type)

	# ── 1) Expiração do tecto, no aniversário de admissão ─────────────────────
	if alloc and _e_aniversario(anchor, hoje):
		saldo = _saldo(emp["name"], leave_type, hoje)
		excedente = _dias_a_expirar(anchor, hoje, saldo, cap)
		if excedente > 0:
			_aplicar_delta(alloc, emp, leave_type, company, -excedente, is_expiry=True)
			_timeline(emp, f"-{_fmt(excedente)} dias de férias expirados "
				f"(tecto {int(cap)}) &middot; saldo {_fmt(saldo - excedente)}")

	# ── 2) Acumulação mensal, no dia de admissão (idempotente por dia) ────────
	if not _e_dia_incremento(anchor, hoje):
		return
	ultima = emp.get("custom_ultima_acumulacao_ferias")
	if ultima and getdate(ultima) == hoje:
		return  # já acumulou hoje — evita duplicação numa nova corrida

	dias = _dias_a_alocar(anchor, hoje)
	if alloc:
		_aplicar_delta(alloc, emp, leave_type, company, dias, is_expiry=False)
	else:
		_criar_alocacao(emp, leave_type, company, dias, hoje)

	frappe.db.set_value("Employee", emp["name"], "custom_ultima_acumulacao_ferias", hoje, update_modified=False)
	saldo = _saldo(emp["name"], leave_type, hoje)
	_timeline(emp, f"+{_fmt(dias)} dias de férias acumulados &middot; saldo {_fmt(saldo)}")


# ─── Regras de cadência / taxa (porte do script-política) ──────────────────────

def _e_dia_incremento(anchor, hoje):
	"""Hoje é o dia-do-mês de admissão? (com tratamento de fim de mês curto)."""
	dia_anchor = anchor.day
	dia_hoje = hoje.day
	ultimo_dia = get_last_day(hoje).day
	if dia_anchor == dia_hoje:
		return True
	# Admissão a 29/30/31 num mês mais curto → acumula no último dia do mês.
	if dia_anchor > ultimo_dia and dia_hoje == ultimo_dia:
		return True
	return False


def _e_aniversario(anchor, hoje):
	"""Hoje é o aniversário anual de admissão?"""
	if anchor.month == hoje.month and anchor.day == hoje.day:
		return True
	# 29 Fev em ano não-bissexto → aniversário a 28 Fev.
	if anchor.month == 2 and anchor.day == 29 and hoje.month == 2 and hoje.day == 28:
		return not is_leap_year(hoje.year)
	return False


def _dias_a_alocar(anchor, hoje):
	"""< 1 ano → 1 dia/mês; ≥ 1 ano → 2,5 dias/mês."""
	um_ano_atras = getdate(add_months(hoje, -12))
	return 2.5 if anchor <= um_ano_atras else 1.0


def _dias_a_expirar(anchor, hoje, saldo, cap):
	"""A partir de 2 anos de antiguidade, o que excede o tecto expira."""
	anos = date_diff(hoje, anchor) / 365.0
	if anos < 2:
		return 0.0
	return saldo - cap if saldo > cap else 0.0


# ─── Acesso a dados / aplicação de deltas ──────────────────────────────────────

def _buscar_alocacao(employee, leave_type):
	"""Leave Allocation rolante (submetida) do colaborador, se existir."""
	return frappe.db.get_value(
		"Leave Allocation",
		{"employee": employee, "leave_type": leave_type, "docstatus": 1},
		["name", "from_date", "to_date", "company", "new_leaves_allocated", "total_leaves_allocated"],
		as_dict=True,
	)


def _saldo(employee, leave_type, ate):
	"""Saldo real = soma das Leave Ledger Entries até `ate` (allocations +, usos/expirações -)."""
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


def _aplicar_delta(alloc, emp, leave_type, company, delta, is_expiry=False):
	"""
	Move o saldo escrevendo UMA Leave Ledger Entry (o que de facto altera o saldo
	reservável), e sincroniza os campos de exibição da Leave Allocation.
	"""
	lle = frappe.get_doc({
		"doctype": "Leave Ledger Entry",
		"employee": emp["name"],
		"employee_name": emp.get("employee_name"),
		"leave_type": leave_type,
		"transaction_type": "Leave Allocation",
		"transaction_name": alloc["name"],
		"leaves": delta,
		"from_date": alloc["from_date"],
		"to_date": alloc["to_date"],
		"is_carry_forward": 0,
		"is_expired": 1 if is_expiry else 0,
		"is_lwp": 0,
		"company": alloc.get("company") or company,
	})
	lle.flags.ignore_permissions = True
	lle.insert()
	lle.submit()

	# Espelho de exibição (o saldo verdadeiro vem do ledger, não destes campos).
	frappe.db.set_value(
		"Leave Allocation", alloc["name"],
		{
			"new_leaves_allocated": flt(alloc.get("new_leaves_allocated")) + delta,
			"total_leaves_allocated": flt(alloc.get("total_leaves_allocated")) + delta,
		},
		update_modified=False,
	)
	# Manter a cópia local coerente caso haja mais de um delta na mesma corrida.
	alloc["new_leaves_allocated"] = flt(alloc.get("new_leaves_allocated")) + delta
	alloc["total_leaves_allocated"] = flt(alloc.get("total_leaves_allocated")) + delta


def _criar_alocacao(emp, leave_type, company, dias, data_inicio):
	"""Primeira Leave Allocation rolante — o on_submit do HRMS cria o ledger inicial."""
	fim = frappe.db.get_value("Leave Type", leave_type, "custom_allocation_end_date") or HORIZONTE_PADRAO
	alloc = frappe.get_doc({
		"doctype": "Leave Allocation",
		"employee": emp["name"],
		"employee_name": emp.get("employee_name"),
		"company": company,
		"leave_type": leave_type,
		"from_date": getdate(data_inicio),
		"to_date": getdate(fim),
		"new_leaves_allocated": dias,
		"carry_forward": 0,
	})
	alloc.flags.ignore_permissions = True
	alloc.insert()
	alloc.submit()
	return alloc.name


# ─── Auxiliares ────────────────────────────────────────────────────────────────

def _timeline(emp, texto):
	"""Linha na timeline do Vigilante (só para colaboradores que são vigilantes)."""
	vig = emp.get("custom_vigilante")
	if not vig:
		return
	from sigos.timeline import registar
	registar(vig, texto)


def _fmt(n):
	"""Formata 2.5 → '2.5' e 3.0 → '3' (sem zeros à direita)."""
	return ("%g" % flt(n))
