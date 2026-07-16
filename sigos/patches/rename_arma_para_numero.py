import frappe
from frappe.model.rename_doc import rename_doc


def execute():
	"""
	One-time rename for the Arma autoname switch (2026-07-16): was
	naming_series ARM-.##, is now field:numero_da_arma (Descrição and Número de
	Série were removed — numero_da_arma is now the sole, mandatory identifier).

	Movimentacao De Arma.referencia_da_arma is the only Link to Arma in the app,
	so rename_doc cascades it automatically — nothing else to backfill.

	Uses frappe.model.rename_doc.rename_doc directly (not the frappe.rename_doc
	whitelisted wrapper) because the wrapper doesn't accept ignore_permissions —
	it always runs under the caller's own permissions, which is fine for the UI
	but not for an unattended patch.

	Records with an empty or duplicate numero_da_arma can't be safely
	auto-renamed (no identifier to rename to / would collide) — they're left
	under their old ARM-.## name and logged to Error Log so they can be fixed
	and renamed by hand afterwards.
	"""
	armas = frappe.get_all(
		"Arma", filters={"name": ["like", "ARM-%"]}, fields=["name", "numero_da_arma"]
	)

	vistos = set()
	for a in armas:
		novo = (a.numero_da_arma or "").strip()
		if not novo:
			frappe.log_error(
				f"Arma {a.name}: sem Número da Arma — não renomeada. "
				"Preencha o campo e renomeie manualmente (Renomear no menu ...).",
				"SIGOS Arma Rename",
			)
			continue
		if novo in vistos or frappe.db.exists("Arma", novo):
			frappe.log_error(
				f"Arma {a.name}: Número da Arma '{novo}' duplicado — não renomeada. "
				"Corrija o número para ser único e renomeie manualmente.",
				"SIGOS Arma Rename",
			)
			continue
		vistos.add(novo)
		rename_doc(doctype="Arma", old=a.name, new=novo, ignore_permissions=True)

	frappe.db.commit()
