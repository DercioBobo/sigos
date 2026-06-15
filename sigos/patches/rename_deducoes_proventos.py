import frappe

# Rename the two payroll doctypes to their clearer names. Runs in [pre_model_sync]
# so the DB tables/links are renamed BEFORE the model sync imports the new JSON
# (otherwise sync would create empty "Outras *" doctypes alongside the old ones).
#
# Self-healing: a migrate that ran the new JSON sync BEFORE this patch existed (or an
# interrupted earlier run) can leave the target table present while the new DocType
# record is still missing — making a naive rename hit "Table already exists" (1050).
# We detect and repair those partial states, but only act when it is provably safe
# (an EMPTY leftover table); when both tables hold data we refuse and ask for a manual
# decision rather than risk losing payroll rows.
RENAMES = (
	("Deducoes", "Outras Deducoes"),
	("Proventos", "Outras Remuneracoes"),
)


def execute():
	for old, new in RENAMES:
		_reconciliar(old, new)
	frappe.db.commit()


def _tab(dt):
	return f"tab{dt}"


def _table_exists(dt):
	return bool(frappe.db.sql(
		"""
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = DATABASE() AND table_name = %s
		""",
		(_tab(dt),),
	))


def _row_count(dt):
	return frappe.db.sql(f"SELECT COUNT(*) FROM `{_tab(dt)}`")[0][0]


def _reconciliar(old, new):
	new_dt = frappe.db.exists("DocType", new)
	old_dt = frappe.db.exists("DocType", old)
	old_tbl = _table_exists(old)
	new_tbl = _table_exists(new)

	# Already fully migrated — drop a stale, empty old leftover table if one lingers.
	if new_dt:
		if old_tbl and not old_dt and _row_count(old) == 0:
			frappe.db.sql(f"DROP TABLE `{_tab(old)}`")
		return

	# Nothing to migrate from.
	if not old_dt:
		return

	# Clean case: the target table is free → standard, full rename (table + metadata + links).
	if not new_tbl:
		frappe.rename_doc("DocType", old, new, force=True)
		return

	# Blocker: the target table exists but its DocType record does not.
	if not old_tbl:
		# Interrupted run already renamed the data table; only metadata is stale.
		# Put the table back so rename_doc can redo the rename correctly and in full.
		frappe.db.sql(f"RENAME TABLE `{_tab(new)}` TO `{_tab(old)}`")
		frappe.rename_doc("DocType", old, new, force=True)
		return

	# Both tables exist. The `new` one is a leftover from an early sync.
	if _row_count(new) == 0:
		frappe.db.sql(f"DROP TABLE `{_tab(new)}`")
		frappe.rename_doc("DocType", old, new, force=True)
		return

	# Both tables hold data — ambiguous. Refuse to guess.
	frappe.throw(
		f"Migração: as tabelas `{_tab(old)}` e `{_tab(new)}` existem ambas COM dados. "
		f"Decida manualmente qual manter (mova as linhas e remova a outra) antes de re-correr a migração."
	)
