import frappe


def execute():
	"""
	One-time backfill (2026-07-24) for the new HR-managed subsídio matrix
	(Project Subsidio Aplicacao, see the Project form's "Gerir Subsídios"
	button). Before this change, EVERY subsídio row on a Project applied
	unconditionally to EVERY Activo vigilante on that project — there was no way
	to opt only some of them in. Seed the matrix with exactly that starting
	state (all-on) so existing payroll behaviour doesn't silently drop to zero
	the moment this ships; HR can then narrow it down per project from there.
	"""
	linhas = frappe.get_all(
		"Project Subsidio Item",
		filters={"parenttype": "Project", "parentfield": "custom_subsidios"},
		fields=["parent as project", "salary_component"],
	)
	if not linhas:
		return

	componentes_por_projecto = {}
	for linha in linhas:
		componentes_por_projecto.setdefault(linha.project, []).append(linha.salary_component)

	agora = frappe.utils.now()
	rows = []
	for project, componentes in componentes_por_projecto.items():
		postos = frappe.get_all("Posto De Vigilancia", filters={"project": project}, pluck="name")
		if not postos:
			continue
		vigilantes = frappe.get_all(
			"Vigilante",
			filters={"posto_de_vigilancia": ["in", postos], "status": "Activo"},
			pluck="name",
		)
		for vigilante in vigilantes:
			for componente in componentes:
				rows.append([
					frappe.generate_hash(length=10), project, componente, vigilante,
					"Administrator", "Administrator", agora, agora,
				])

	if rows:
		frappe.db.bulk_insert(
			"Project Subsidio Aplicacao",
			fields=["name", "project", "salary_component", "vigilante", "owner", "modified_by", "creation", "modified"],
			values=rows,
		)
	frappe.db.commit()
