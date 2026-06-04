"""
Salary Slip hooks for SIGOS.

Payroll model:
  - Escala is purely operational and is NEVER read here.
  - Faltas come exclusively from Ausencias (sum of n_de_faltas).
  - custom_dias_de_trabalho = the monthly divisor (days in the period, HRMS-style).
  - The faltas deduction method is configurable in SIGOS Settings:
        "Proporcional ao Salário" → (base / dias_de_trabalho) × faltas_nao_justificadas
        "Valor Fixo por Falta"     → faltas_nao_justificadas × valor_fixo_por_falta

Wire-up (hooks.py):
    doc_events = {
        "Salary Slip": {
            "before_insert":   "sigos.payroll_ext.salary_slip_hooks.before_insert",
            "before_validate": "sigos.payroll_ext.salary_slip_hooks.before_validate",
            "before_submit":   "sigos.payroll_ext.salary_slip_hooks.before_submit",
        }
    }
"""

import frappe
from frappe.utils import getdate, add_days, date_diff
from sigos.utils import calcular_faltas_vigilante


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
	_set_dias_de_trabalho(doc)          # divisor — must run before the deduction
	_compute_faltas(doc)                # from Ausencias only
	_add_deducoes(doc)
	_add_reclamacao(doc)
	_compute_justificadas(doc)
	_compute_faltas_nao_justificadas(doc)
	_add_faltas_deduction(doc)          # uses the configured method
	_compute_dias_trabalhados(doc)


# ─── Subsídios ──────────────────────────────────────────────────────────────────

def _add_project_subsidios(doc):
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
			"Deducoes",
			filters={
				"funcionario": doc.employee,
				"docstatus": 1,
				"estado": "Activo",
				"data_de_inicio": ["<=", doc.start_date],
				"data_de_fim": [">=", doc.end_date],
			},
			fields=["valor_mensal", "name", "tipo"],
		)

		tipos_para_componentes = {
			"Deducoes Diversas":   "Deducoes diversas",
			"Uniforme":            "Uniforme",
			"Emprestimo":          "Emprestimo",
			"Processo Disciplinar": "Processo Disciplinar",
		}

		existentes = {d.salary_component for d in doc.deductions}
		for deducao in deducoes:
			componente = tipos_para_componentes.get(deducao.tipo)
			if not componente:
				continue
			if componente not in existentes and frappe.db.exists("Salary Component", componente):
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


def _add_reclamacao(doc):
	if not doc.employee or not doc.start_date or not doc.end_date:
		return
	try:
		componente = frappe.db.get_single_value("SIGOS Settings", "componente_retroativo") or "Retroativo"

		reclamacoes = frappe.get_all(
			"Reclamacao De Salario",
			filters=[
				["funcionario", "=", doc.employee],
				["data_de_inicio", "<=", doc.end_date],
				["data_de_fim", ">=", doc.start_date],
				["docstatus", "=", 1],
				["workflow_state", "=", "Aprovado"],
			],
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
	if not doc.employee:
		return

	inicio = doc.custom_dia_da_falta_inicio
	fim = doc.custom_dia_da_falta_fim
	if not inicio or not fim:
		doc.custom_faltas_justificadas = 0
		return

	try:
		justificacoes = frappe.get_all(
			"Justificacao De Faltas",
			filters={
				"funcionario": doc.employee,
				"docstatus": 1,
				"workflow_state": "Aprovado",
				"data_do_justificativo": ["between", [inicio, fim]],
			},
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


def _compute_dias_trabalhados(doc):
	"""
	Days credited as worked for pay = divisor − unjustified faltas.
	(Justified faltas are paid, so they count as worked.)
	"""
	dias = doc.custom_dias_de_trabalho or 0
	faltas_nao = doc.custom_faltas_nao_justificadas or 0
	doc.custom_dias_trabalhados = max(0, dias - faltas_nao)


# ─── before_submit ─────────────────────────────────────────────────────────────

def before_submit(doc, method):
	"""Finalise dias_trabalhados before submit."""
	_compute_dias_trabalhados(doc)
