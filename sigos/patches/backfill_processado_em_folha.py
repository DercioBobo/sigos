import frappe

# Required one-time backfill for Tabela Ausencia.processado_em_folha (2026-07-15,
# configurable payroll periods — see salary_slip_hooks._compute_faltas /
# calcular_faltas_pendentes_vigilante in sigos/utils.py).
#
# _compute_faltas now selects faltas by "not yet processado_em_folha" instead of
# a start/end date-range filter, specifically so a falta filed AFTER its own
# period's slip was already submitted still rolls onto whichever slip processes
# it next, instead of being silently dropped. Without this backfill, every
# HISTORICAL Tabela Ausencia row would look "unprocessed" the first time this
# runs on an existing site, and the next Salary Slip built for each employee
# would re-pull years of already-paid faltas. This stamps history using the OLD
# date-range logic (data BETWEEN slip.start_date AND slip.end_date) so nothing
# gets re-counted. Idempotent: only touches rows that are still unstamped, and
# picks the earliest matching slip if periods ever historically overlapped.


def execute():
	if not frappe.db.has_column("Tabela Ausencia", "processado_em_folha"):
		return

	frappe.db.sql(
		"""
		UPDATE `tabTabela Ausencia` ta
		INNER JOIN `tabAusencias` a ON a.name = ta.parent AND a.docstatus = 1
		INNER JOIN `tabVigilante` v ON v.name = ta.vigilante
		INNER JOIN `tabEmployee` e ON e.name = v.funcionario
		SET ta.processado_em_folha = (
			SELECT ss.name FROM `tabSalary Slip` ss
			WHERE ss.employee = e.name AND ss.docstatus = 1
			  AND a.data BETWEEN ss.start_date AND ss.end_date
			ORDER BY ss.start_date ASC, ss.name ASC
			LIMIT 1
		)
		WHERE (ta.processado_em_folha IS NULL OR ta.processado_em_folha = '')
		  AND EXISTS (
			SELECT 1 FROM `tabSalary Slip` ss2
			WHERE ss2.employee = e.name AND ss2.docstatus = 1
			  AND a.data BETWEEN ss2.start_date AND ss2.end_date
		  )
		"""
	)
	frappe.db.commit()
