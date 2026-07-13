"""
Salary Slip hooks for SIGOS.

Payroll model:
  - Escala is purely operational and is NEVER read here.
  - Faltas come exclusively from Ausencias (sum of n_de_faltas).
  - custom_dias_de_trabalho = the monthly divisor (days in the period, HRMS-style).
  - The faltas deduction method is configurable in SIGOS Settings:
        "Proporcional ao Salário" → (base / dias_de_trabalho) × faltas_nao_justificadas
        "Valor Fixo por Falta"     → faltas_nao_justificadas × valor_fixo_por_falta
  - Customer-specific (SIGOS Settings.faltas_normal_vermelha_activo, default OFF):
    unjustified "Vermelha" faltas ALSO withhold days from the férias ledger, on top
    of the normal salary deduction above — see _deduzir_ferias_faltas_vermelhas.

Wire-up (hooks.py):
    doc_events = {
        "Salary Slip": {
            "before_insert":   "sigos.payroll_ext.salary_slip_hooks.before_insert",
            "before_validate": "sigos.payroll_ext.salary_slip_hooks.before_validate",
            "before_submit":   "sigos.payroll_ext.salary_slip_hooks.before_submit",
            "on_cancel":       "sigos.payroll_ext.salary_slip_hooks.on_cancel",
        }
    }
"""

import frappe
from frappe.utils import getdate, add_days, date_diff, flt
from sigos.utils import calcular_faltas_vigilante, calcular_dobras_vigilante, calcular_faltas_vermelhas_vigilante


def _aprovado_filter(doctype):
	"""
	Return {"workflow_state": "Aprovado"} only if the doctype actually has that
	field (i.e. a Workflow has been attached). Workflows are created manually,
	so before one exists the column is absent — filtering on it would raise
	'Unknown column'. A submitted (docstatus=1) doc without a workflow counts
	as approved.
	"""
	if frappe.get_meta(doctype).has_field("workflow_state"):
		return {"workflow_state": "Aprovado"}
	return {}


# ─── before_insert ─────────────────────────────────────────────────────────────

def before_insert(doc, method):
	_set_salary_structure(doc)
	_set_dia_da_falta_inicio(doc)


def _set_salary_structure(doc):
	if doc.salary_structure:
		return
	try:
		ssa_list = frappe.get_all(
			"Salary Structure Assignment",
			filters={"employee": doc.employee},
			fields=["salary_structure"],
			order_by="from_date desc",
			limit=1,
		)
		if ssa_list:
			doc.salary_structure = ssa_list[0].salary_structure
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro ao buscar salary_structure para {doc.employee}: {e}",
			"SIGOS Salary Slip Hooks",
		)


def _set_dia_da_falta_inicio(doc):
	if not doc.employee:
		return
	try:
		last_slip = frappe.get_all(
			"Salary Slip",
			filters=[
				["employee", "=", doc.employee],
				["docstatus", "=", 1],
				["name", "!=", doc.name or "___"],
			],
			fields=["posting_date"],
			order_by="posting_date desc",
			limit=1,
		)
		doc.custom_dia_da_falta_inicio = last_slip[0].posting_date if last_slip else doc.start_date
		if doc.posting_date:
			doc.custom_dia_da_falta_fim = add_days(doc.posting_date, -1)
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro ao definir dia_da_falta_inicio: {e}",
			"SIGOS Salary Slip Hooks",
		)


# ─── before_validate ───────────────────────────────────────────────────────────

def before_validate(doc, method):
	_add_project_subsidios(doc)
	_add_subsidio_arma(doc)
	_add_remuneracoes(doc)              # Outras Remuneracoes → earnings
	_set_dias_de_trabalho(doc)          # divisor — must run before the deduction
	_compute_faltas(doc)                # from Ausencias only
	_add_deducoes(doc)
	_add_emprestimos(doc)               # Emprestimo → deductions
	_add_reclamacao(doc)
	_compute_justificadas(doc)
	_compute_faltas_nao_justificadas(doc)
	_add_faltas_deduction(doc)          # uses the configured method
	_add_dobras(doc)                    # extra pay for covered shifts (earning)
	_add_proporcional_admissao_demissao(doc)   # prorate base for partial-month employment
	_compute_dias_trabalhados(doc)


# ─── Subsídios ──────────────────────────────────────────────────────────────────

def _resolve_projecto(doc):
	"""
	The slip's custom_projecto has no fetch_from (the Employee carries no project),
	so derive it when empty: prefer the SSA actually applied to this slip (the
	contract in force), falling back to the guard's current Vigilante.projecto.
	Without this the project subsídios below never get appended.
	"""
	if doc.custom_projecto:
		return
	try:
		if doc.salary_structure and doc.employee:
			proj = frappe.db.get_value(
				"Salary Structure Assignment",
				{"employee": doc.employee, "salary_structure": doc.salary_structure, "docstatus": 1},
				"custom_project",
			)
			if proj:
				doc.custom_projecto = proj
				return
		if doc.custom_vigilante:
			doc.custom_projecto = frappe.db.get_value(
				"Vigilante", doc.custom_vigilante, "projecto"
			)
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro ao resolver projecto: {e}",
			"SIGOS Salary Slip Hooks",
		)


def _add_project_subsidios(doc):
	_resolve_projecto(doc)
	if not doc.custom_projecto:
		return
	try:
		project = frappe.get_doc("Project", doc.custom_projecto)
		if not project.custom_subsidios:
			return
		existentes = {e.salary_component for e in doc.earnings}
		for row in project.custom_subsidios:
			if row.salary_component not in existentes:
				doc.append("earnings", {
					"salary_component": row.salary_component,
					"amount": row.amount,
				})
				existentes.add(row.salary_component)
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro ao adicionar subsídios do projecto: {e}",
			"SIGOS Salary Slip Hooks",
		)


def _add_subsidio_arma(doc):
	if doc.custom_categoria != "Vigilante Armado":
		return
	try:
		settings = frappe.get_single("SIGOS Settings")
		componente = settings.componente_subsidio_arma or "Subsidio De Arma"
		if not frappe.db.exists("Salary Component", componente):
			return

		existentes = {e.salary_component for e in doc.earnings}
		if componente not in existentes:
			arma_amount = settings.valor_subsidio_arma or 300
			doc.append("earnings", {
				"salary_component": componente,
				"amount": arma_amount,
			})
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro ao adicionar Subsidio de Arma: {e}",
			"SIGOS Salary Slip Hooks",
		)


# ─── Outras Remuneracoes (earnings) ──────────────────────────────────────────────

def _add_remuneracoes(doc):
	"""
	Append every approved Outras Remuneracoes whose period covers the slip.
	The earnings counterpart of _add_deducoes — without this, Outras Remuneracoes
	records compute a valor_mensal but never reach the slip. Each row carries its
	own Salary Component (tipo_de_subsidios); same-component rows are de-duped so a
	remuneração never doubles a project subsídio already present.
	"""
	if not doc.employee or not doc.start_date or not doc.end_date:
		return
	try:
		filters = {
			"funcionario": doc.employee,
			"docstatus": 1,
			"data_de_inicio": ["<=", doc.start_date],
			"data_de_fim": [">=", doc.end_date],
		}
		filters.update(_aprovado_filter("Outras Remuneracoes"))
		remuneracoes = frappe.get_all(
			"Outras Remuneracoes",
			filters=filters,
			fields=["valor_mensal", "tipo_de_subsidios", "name"],
		)

		existentes = {e.salary_component for e in doc.earnings}
		for rem in remuneracoes:
			componente = rem.tipo_de_subsidios
			if not componente or componente in existentes:
				continue
			if not frappe.db.exists("Salary Component", componente):
				continue
			doc.append("earnings", {
				"salary_component": componente,
				"amount": rem.valor_mensal or 0,
			})
			existentes.add(componente)
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro ao adicionar Outras Remuneracoes: {e}",
			"SIGOS Salary Slip Hooks",
		)


# ─── Dias de trabalho (divisor) ──────────────────────────────────────────────────

def _set_dias_de_trabalho(doc):
	"""
	custom_dias_de_trabalho is the monthly divisor for proportional deductions.
	  "Dias do Mês"        → total days in the slip period (e.g. 30)
	  "Dias Úteis (HRMS)"  → the slip's total_working_days
	"""
	base_setting = frappe.db.get_single_value("SIGOS Settings", "base_dias_de_trabalho") or "Dias do Mês"

	if base_setting == "Dias Úteis (HRMS)" and doc.total_working_days:
		doc.custom_dias_de_trabalho = doc.total_working_days
	elif doc.start_date and doc.end_date:
		doc.custom_dias_de_trabalho = date_diff(doc.end_date, doc.start_date) + 1
	else:
		doc.custom_dias_de_trabalho = 30


# ─── Deduções ─────────────────────────────────────────────────────────────────

def _add_deducoes(doc):
	if not doc.employee or not doc.start_date or not doc.end_date:
		return
	try:
		deducoes = frappe.get_all(
			"Outras Deducoes",
			filters={
				"funcionario": doc.employee,
				"docstatus": 1,
				"estado": "Activo",
				"data_de_inicio": ["<=", doc.start_date],
				"data_de_fim": [">=", doc.end_date],
			},
			fields=["valor_mensal", "name", "tipo"],
		)

		# Each record carries its own Salary Component directly in `tipo` (a Link),
		# mirroring Outras Remuneracoes' `tipo_de_subsidios` — no Settings map needed.
		existentes = {d.salary_component for d in doc.deductions}
		for deducao in deducoes:
			componente = deducao.tipo
			if not componente or componente in existentes:
				continue
			if not frappe.db.exists("Salary Component", componente):
				continue
			doc.append("deductions", {
				"salary_component": componente,
				"amount": deducao.valor_mensal or 0,
			})
			existentes.add(componente)
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro ao adicionar deduções: {e}",
			"SIGOS Salary Slip Hooks",
		)


def _add_emprestimos(doc):
	"""
	Append the monthly installment of every active Emprestimo covering the slip
	period as a single 'Emprestimo' deduction. Only one loan per employee is
	active at a time, but summing keeps it safe if that ever changes.
	"""
	if not doc.employee or not doc.start_date or not doc.end_date:
		return
	try:
		componente = frappe.db.get_single_value("SIGOS Settings", "componente_emprestimo") or "Emprestimo"
		if not frappe.db.exists("Salary Component", componente):
			return
		if componente in {d.salary_component for d in doc.deductions}:
			return

		emprestimos = frappe.get_all(
			"Emprestimo",
			filters={
				"funcionario": doc.employee,
				"docstatus": 1,
				"estado": "Activo",
				"data_de_inicio": ["<=", doc.start_date],
				"data_de_fim": [">=", doc.end_date],
			},
			fields=["valor_mensal", "name"],
		)

		total = round(sum(e.valor_mensal or 0 for e in emprestimos), 2)
		if total > 0:
			doc.append("deductions", {
				"salary_component": componente,
				"amount": total,
			})
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro ao adicionar empréstimos: {e}",
			"SIGOS Salary Slip Hooks",
		)


def _add_reclamacao(doc):
	if not doc.employee or not doc.start_date or not doc.end_date:
		return
	try:
		componente = frappe.db.get_single_value("SIGOS Settings", "componente_retroativo") or "Retroativo"

		filters = {
			"funcionario": doc.employee,
			"data_de_inicio": ["<=", doc.end_date],
			"data_de_fim": [">=", doc.start_date],
			"docstatus": 1,
		}
		filters.update(_aprovado_filter("Reclamacao De Salario"))
		reclamacoes = frappe.get_all(
			"Reclamacao De Salario",
			filters=filters,
			fields=["valor_a_reclamar", "name"],
		)

		if reclamacoes:
			reclamacao = reclamacoes[0]
			doc.custom_valor_a_reclamar = reclamacao.valor_a_reclamar or 0
			existentes = {e.salary_component for e in doc.earnings}
			if componente not in existentes and frappe.db.exists("Salary Component", componente):
				doc.append("earnings", {
					"salary_component": componente,
					"amount": reclamacao.valor_a_reclamar or 0,
				})
		else:
			doc.custom_valor_a_reclamar = 0
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro ao adicionar reclamação: {e}",
			"SIGOS Salary Slip Hooks",
		)


# ─── Faltas (from Ausencias only) ────────────────────────────────────────────────

def _compute_faltas(doc):
	"""Sum n_de_faltas from submitted Ausencias for this vigilante in the slip period."""
	if not doc.employee or not doc.start_date or not doc.end_date:
		return

	custom_vigilante = doc.custom_vigilante
	if not custom_vigilante:
		doc.custom_faltas_no_mes = 0
		return

	try:
		doc.custom_faltas_no_mes = calcular_faltas_vigilante(
			vigilante=custom_vigilante,
			start_date=doc.start_date,
			end_date=doc.end_date,
		)
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro ao computar faltas: {e}",
			"SIGOS Salary Slip Hooks",
		)


def _compute_justificadas(doc):
	# Match by vigilante — the same key faltas come from (Ausencias). Justificacao De
	# Faltas is vigilante-primary (reqd); its funcionario is only a fetched mirror, so
	# keying on it would silently miss justifications whenever the Vigilante→Employee
	# link is empty/stale, over-deducting the guard.
	if not doc.custom_vigilante:
		doc.custom_faltas_justificadas = 0
		return

	inicio = doc.custom_dia_da_falta_inicio
	fim = doc.custom_dia_da_falta_fim
	if not inicio or not fim:
		doc.custom_faltas_justificadas = 0
		return

	try:
		filters = {
			"vigilante": doc.custom_vigilante,
			"docstatus": 1,
			"data_do_justificativo": ["between", [inicio, fim]],
		}
		filters.update(_aprovado_filter("Justificacao De Faltas"))
		justificacoes = frappe.get_all(
			"Justificacao De Faltas",
			filters=filters,
			fields=["numero"],
		)
		doc.custom_faltas_justificadas = sum(j.get("numero") or 0 for j in justificacoes)
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro ao computar faltas justificadas: {e}",
			"SIGOS Salary Slip Hooks",
		)
		doc.custom_faltas_justificadas = 0


def _compute_faltas_nao_justificadas(doc):
	faltas = doc.custom_faltas_no_mes or 0
	justificadas = doc.custom_faltas_justificadas or 0
	doc.custom_faltas_nao_justificadas = max(0, faltas - justificadas)


def _get_salario_base(doc):
	"""Reliable base salary: slip.base first, fall back to the SSA base."""
	if doc.get("base"):
		return doc.base
	if doc.salary_structure and doc.employee:
		base = frappe.db.get_value(
			"Salary Structure Assignment",
			{
				"employee": doc.employee,
				"salary_structure": doc.salary_structure,
				"docstatus": 1,
			},
			"base",
		)
		return base or 0
	return 0


def _add_faltas_deduction(doc):
	"""
	Add/update the Faltas deduction using the method configured in SIGOS Settings.
	"""
	faltas_nao = doc.custom_faltas_nao_justificadas or 0

	settings = frappe.get_single("SIGOS Settings")
	componente = settings.componente_faltas or "Faltas"
	if not frappe.db.exists("Salary Component", componente):
		return

	# Compute the amount
	if faltas_nao <= 0:
		amount = 0
	elif (settings.metodo_calculo_faltas or "Proporcional ao Salário") == "Valor Fixo por Falta":
		amount = faltas_nao * (settings.valor_fixo_por_falta or 0)
	else:
		base = _get_salario_base(doc)
		dias = doc.custom_dias_de_trabalho or 0
		amount = (base / dias) * faltas_nao if dias > 0 else 0

	amount = round(amount, 2)

	# Update existing row or append
	for d in doc.deductions:
		if d.salary_component == componente:
			d.amount = amount
			return

	if amount > 0:
		doc.append("deductions", {
			"salary_component": componente,
			"amount": amount,
		})


def _add_dobras(doc):
	"""
	Credit a guard for EXTRA shifts covered — Dobra/Adiantamento — the earnings mirror
	of the Faltas deduction. Toggled by SIGOS Settings 'dobras_activo' (default OFF), so
	nothing changes until you enable it. Valuation mirrors faltas:
	  Proporcional ao Salário → (base / dias_de_trabalho) × nº dobras
	  Valor Fixo por Dobra     → nº dobras × valor_fixo_por_dobra
	Keyed on custom_vigilante (ops side of the bridge), like faltas.
	"""
	if not doc.custom_vigilante or not doc.start_date or not doc.end_date:
		return
	try:
		settings = frappe.get_single("SIGOS Settings")
		if not settings.dobras_activo:
			doc.custom_dobras_no_mes = 0
			return

		componente = settings.componente_dobra or "Dobra"
		if not frappe.db.exists("Salary Component", componente):
			return

		n_dobras = calcular_dobras_vigilante(doc.custom_vigilante, doc.start_date, doc.end_date)
		doc.custom_dobras_no_mes = n_dobras
		if n_dobras <= 0:
			return

		if (settings.metodo_calculo_dobra or "Proporcional ao Salário") == "Valor Fixo por Dobra":
			amount = n_dobras * (settings.valor_fixo_por_dobra or 0)
		else:
			base = _get_salario_base(doc)
			dias = doc.custom_dias_de_trabalho or 0
			amount = (base / dias) * n_dobras if dias > 0 else 0

		amount = round(amount, 2)
		if amount <= 0:
			return

		for e in doc.earnings:
			if e.salary_component == componente:
				e.amount = amount
				return
		doc.append("earnings", {
			"salary_component": componente,
			"amount": amount,
		})
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro ao adicionar dobras: {e}",
			"SIGOS Salary Slip Hooks",
		)


# ─── Proporcional por admissão/demissão a meio do mês ───────────────────────────

def _dias_fora_emprego(doc):
	"""Calendar days within the slip period that fall OUTSIDE the employment window
	[date_of_joining, relieving_date] — i.e. days not yet joined or already left.
	0 for a normal full-month employee."""
	if not (doc.employee and doc.start_date and doc.end_date):
		return 0
	emp = frappe.db.get_value(
		"Employee", doc.employee, ["date_of_joining", "relieving_date"], as_dict=True
	)
	if not emp:
		return 0
	start, end = getdate(doc.start_date), getdate(doc.end_date)
	total = date_diff(end, start) + 1
	emp_start = max(start, getdate(emp.date_of_joining)) if emp.date_of_joining else start
	emp_end = min(end, getdate(emp.relieving_date)) if emp.relieving_date else end
	empregado = (date_diff(emp_end, emp_start) + 1) if emp_start <= emp_end else 0
	return max(0, total - empregado)


def _get_componente_proporcional():
	"""Deduction component for the partial-month proration; auto-created (type
	Deduction) if missing so proration never silently no-ops. None on failure."""
	nome = frappe.db.get_single_value("SIGOS Settings", "componente_proporcional") or "Proporcional"
	if frappe.db.exists("Salary Component", nome):
		return nome
	try:
		frappe.get_doc({
			"doctype": "Salary Component",
			"salary_component": nome,
			"type": "Deduction",
			"description": "Desconto proporcional por admissão/demissão a meio do mês (SIGOS).",
		}).insert(ignore_permissions=True)
		return nome
	except Exception as e:
		frappe.log_error(f"Falha ao criar Salary Component {nome}: {e}", "SIGOS Salary Slip Hooks")
		return None


def _add_proporcional_admissao_demissao(doc):
	"""Deduct the base portion for days the employee was NOT in service this period
	(joined or left mid-month): base × dias_fora / total_dias. Uses the exact calendar
	fraction (independent of the faltas divisor) and is disjoint from faltas — no
	Ausencias exist outside the employment window. No-op for full-month employees."""
	if not (doc.employee and doc.start_date and doc.end_date):
		return
	try:
		dias_fora = _dias_fora_emprego(doc)
		if dias_fora <= 0:
			return
		total = date_diff(getdate(doc.end_date), getdate(doc.start_date)) + 1
		base = _get_salario_base(doc)
		if total <= 0 or base <= 0:
			return
		componente = _get_componente_proporcional()
		if not componente:
			return
		amount = round(base * dias_fora / total, 2)
		if amount <= 0:
			return
		for d in doc.deductions:
			if d.salary_component == componente:
				d.amount = amount
				return
		doc.append("deductions", {"salary_component": componente, "amount": amount})
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro no proporcional admissão/demissão: {e}",
			"SIGOS Salary Slip Hooks",
		)


def _compute_dias_trabalhados(doc):
	"""
	Days credited as worked for pay = divisor − unjustified faltas − days outside the
	employment window (partial month from admission/dismissal).
	(Justified faltas are paid, so they count as worked.)
	"""
	dias = doc.custom_dias_de_trabalho or 0
	faltas_nao = doc.custom_faltas_nao_justificadas or 0
	dias_fora = _dias_fora_emprego(doc)
	doc.custom_dias_trabalhados = max(0, dias - faltas_nao - dias_fora)


# ─── before_submit ─────────────────────────────────────────────────────────────

def before_submit(doc, method):
	"""Finalise dias_trabalhados before submit."""
	_compute_dias_trabalhados(doc)
	_deduzir_ferias_faltas_vermelhas(doc)


# ─── on_cancel ─────────────────────────────────────────────────────────────────

def on_cancel(doc, method):
	_reverter_ferias_faltas_vermelhas(doc)


def _deduzir_ferias_faltas_vermelhas(doc):
	"""
	Customer-specific (SIGOS Settings.faltas_normal_vermelha_activo, default OFF):
	unjustified 'Vermelha' faltas also withhold days from the férias ledger, on top
	of the normal salary deduction. Approximation: vermelhas_nao_justificadas =
	min(vermelhas no período, faltas_nao_justificadas total) — a Justificacao De
	Faltas doesn't say WHICH subtipo it covers, so this assumes a justification
	clears the guard's faltas as a whole, not per-subtipo.

	Fires once, at final submit — unlike the salary/dobra lines above (which just
	live inside the slip and are naturally undone by cancelling it), this writes a
	real submitted Leave Ledger Entry, so it needs its own idempotency guard and
	its own reversal on cancel (see on_cancel above).
	"""
	settings = frappe.get_single("SIGOS Settings")
	if not settings.faltas_normal_vermelha_activo:
		return
	if not doc.custom_vigilante or not doc.employee or not doc.start_date or not doc.end_date:
		return

	if frappe.db.exists("Leave Ledger Entry", {
		"transaction_type": "Salary Slip", "transaction_name": doc.name, "docstatus": 1,
	}):
		return

	try:
		vermelhas = calcular_faltas_vermelhas_vigilante(doc.custom_vigilante, doc.start_date, doc.end_date)
		nao_justificadas = min(vermelhas, doc.custom_faltas_nao_justificadas or 0)
		if nao_justificadas <= 0:
			return

		leave_type = settings.leave_type_ferias or "Ferias"
		from sigos.ferias import _buscar_alocacao
		alloc = _buscar_alocacao(doc.employee, leave_type)
		if not alloc:
			frappe.log_error(
				f"SalarySlip {doc.name}: sem Leave Allocation de '{leave_type}' para "
				f"{doc.employee} — não foi possível abater faltas vermelhas das férias.",
				"SIGOS Faltas Vermelhas",
			)
			return

		lle = frappe.get_doc({
			"doctype": "Leave Ledger Entry",
			"employee": doc.employee,
			"employee_name": doc.employee_name,
			"leave_type": leave_type,
			"transaction_type": "Salary Slip",
			"transaction_name": doc.name,
			"leaves": -flt(nao_justificadas),
			"from_date": alloc["from_date"],
			"to_date": alloc["to_date"],
			"is_carry_forward": 0,
			"is_expired": 0,
			"is_lwp": 0,
			"company": alloc.get("company") or doc.company,
		})
		lle.flags.ignore_permissions = True
		lle.insert()
		lle.submit()

		# Mirror the display fields, same as ferias.py's own ledger writes.
		frappe.db.set_value(
			"Leave Allocation", alloc["name"],
			{
				"new_leaves_allocated": flt(alloc.get("new_leaves_allocated")) - nao_justificadas,
				"total_leaves_allocated": flt(alloc.get("total_leaves_allocated")) - nao_justificadas,
			},
			update_modified=False,
		)
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro ao abater férias por faltas vermelhas: {e}",
			"SIGOS Faltas Vermelhas",
		)


def _reverter_ferias_faltas_vermelhas(doc):
	"""Cancel the Leave Ledger Entry (if any) this slip created for Vermelha
	faltas, so cancelling/correcting a payroll run doesn't leave a stale férias
	deduction behind."""
	nome = frappe.db.get_value("Leave Ledger Entry", {
		"transaction_type": "Salary Slip", "transaction_name": doc.name, "docstatus": 1,
	})
	if not nome:
		return
	try:
		lle = frappe.get_doc("Leave Ledger Entry", nome)
		lle.flags.ignore_permissions = True
		lle.cancel()
	except Exception as e:
		frappe.log_error(
			f"SalarySlip {doc.name}: erro ao reverter abatimento de férias (faltas vermelhas): {e}",
			"SIGOS Faltas Vermelhas",
		)
