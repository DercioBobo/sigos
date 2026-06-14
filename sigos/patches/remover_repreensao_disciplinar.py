"""Retire the Repreensao Disciplinar doctype.

Participação is now the official warning and carries the same three-strikes
accumulation rule, so Repreensão is redundant. This drops the doctype (and its
table) on already-migrated sites; the field `Processo Disciplinar.repreensao_referente`
was removed from the JSON, so its orphan column (if any) is harmless.

Idempotent: no-op once the doctype is gone.
"""

import frappe


def execute():
	if frappe.db.exists("DocType", "Repreensao Disciplinar"):
		# delete_doc drops the backing `tabRepreensao Disciplinar` table too.
		frappe.delete_doc("DocType", "Repreensao Disciplinar", force=True, ignore_missing=True)
		frappe.db.commit()
