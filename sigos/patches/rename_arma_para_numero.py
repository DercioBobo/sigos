import frappe


def execute():
	"""
	One-time rename for the Arma autoname switch (2026-07-16): was
	naming_series ARM-.##, is now field:numero_da_arma (Descrição and Número de
	Série were removed — numero_da_arma is now the sole, mandatory identifier).

	Movimentacao De Arma.referencia_da_arma is the only Link to Arma in the app,
	so frappe.rename_doc cascades it automatically — nothing else to backfill.

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
		frappe.rename_doc("Arma", a.name, novo, ignore_permissions=True)

	frappe.db.commit()
