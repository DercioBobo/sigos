import frappe
from frappe.utils import flt


def execute():
	"""
	Split the contract's single tariff table into RH (Salários por Regime) and
	Finance (Faturação por Regime).

	For every Project, the billing rate that lived on Project Regime Rate.valor moves
	to a new Project Faturacao Regime row. The old project-wide fallback
	(custom_valor_do_contrato) is being removed, so regimes that were only priced
	through it — i.e. regimes of the contract's Activo guards with no own row — get
	an explicit finance row at that value, keeping current billing unchanged.
	Nº de Vigilantes is seeded with today's Activo headcount per regime.

	Then: RH rows left with no salário base (they only carried a billing price) are
	removed, and the fallback Custom Field is deleted. Idempotent: projects that
	already have finance rows are skipped.
	"""
	from sigos.install import _load_custom_fields

	frappe.reload_doc("sigos_setup", "doctype", "project_faturacao_regime")
	_load_custom_fields()  # custom_faturacao_regimes must exist before rows point at it

	tem_valor = frappe.db.has_column("Project Regime Rate", "valor")
	tem_fallback = frappe.db.has_column("Project", "custom_valor_do_contrato")

	tarifas = {}
	if tem_valor:
		for r in frappe.db.sql("""
			SELECT parent, regime, valor, descricao FROM `tabProject Regime Rate`
			WHERE parenttype = 'Project' AND IFNULL(valor, 0) > 0
			ORDER BY parent, idx
		""", as_dict=True):
			tarifas.setdefault(r.parent, {}).setdefault(r.regime, r)

	fallback = {}
	if tem_fallback:
		fallback = {
			r.name: flt(r.custom_valor_do_contrato)
			for r in frappe.db.sql("""
				SELECT name, custom_valor_do_contrato FROM `tabProject`
				WHERE IFNULL(custom_valor_do_contrato, 0) > 0
			""", as_dict=True)
		}

	activos = {}
	for r in frappe.db.sql("""
		SELECT projecto, regime_do_vigilante AS regime, COUNT(*) AS qtd
		FROM `tabVigilante`
		WHERE status = 'Activo' AND IFNULL(projecto, '') != ''
		  AND IFNULL(regime_do_vigilante, '') != ''
		  AND IFNULL(cobertura_de_posto_activa, '') = ''
		GROUP BY projecto, regime_do_vigilante
	""", as_dict=True):
		activos.setdefault(r.projecto, {})[r.regime] = r.qtd

	for project in set(tarifas) | set(fallback):
		if frappe.db.exists("Project Faturacao Regime", {"parent": project, "parenttype": "Project"}):
			continue

		# The finance 'descricao' is printed on the invoice ('Descrição na Factura'),
		# so old internal notes are NOT carried over — empty means the automatic text.
		linhas = []
		for regime, r in tarifas.get(project, {}).items():
			linhas.append((regime, flt(r.valor)))
		if project in fallback:
			com_tarifa = set(tarifas.get(project, {}))
			for regime in sorted(activos.get(project, {})):
				if regime not in com_tarifa:
					linhas.append((regime, fallback[project]))

		for idx, (regime, valor) in enumerate(linhas, start=1):
			qtd = activos.get(project, {}).get(regime, 0)
			frappe.get_doc({
				"doctype": "Project Faturacao Regime",
				"parent": project,
				"parenttype": "Project",
				"parentfield": "custom_faturacao_regimes",
				"idx": idx,
				"regime": regime,
				"quantidade": qtd,
				"valor": valor,
				"total": qtd * valor,
			}).db_insert()

		total = sum(activos.get(project, {}).get(reg, 0) * val for reg, val in linhas)
		frappe.db.set_value("Project", project, "custom_total_contratual", total, update_modified=False)

	# RH rows that only carried a billing price are now empty — drop them.
	frappe.db.sql("""
		DELETE FROM `tabProject Regime Rate`
		WHERE parenttype = 'Project' AND IFNULL(salario_base, 0) = 0
	""")

	nome = frappe.db.get_value("Custom Field", {"dt": "Project", "fieldname": "custom_valor_do_contrato"})
	if nome:
		frappe.delete_doc("Custom Field", nome, ignore_permissions=True, force=True)

	frappe.clear_cache(doctype="Project")
