import frappe


def execute():
	"""One-time backfill for Processo Disciplinar.delegacao (2026-07-20) — the
	field never had a fetch_from (unlike posto/categoria/mecanografico, which
	all fetch off the linked Vigilante), so existing records were left blank.
	New saves are filled automatically now that fetch_from is wired up; this
	just seeds existing rows from their linked Vigilante's delegação.
	"""
	frappe.db.sql(
		"""
		UPDATE `tabProcesso Disciplinar` pd
		INNER JOIN `tabVigilante` v ON v.name = pd.vigilante
		SET pd.delegacao = v.delegacao
		WHERE v.delegacao IS NOT NULL AND v.delegacao != ''
		  AND (pd.delegacao IS NULL OR pd.delegacao = '')
		"""
	)
	frappe.db.commit()
