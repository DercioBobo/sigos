import frappe


def execute():
	"""Automático is now the default abandono_modo (the company stops paying from the
	Presunção date — opening it late in Apenas Alerta would leave unrecorded days).
	Switch sites still on the old default; an explicit Desactivado is kept."""
	actual = frappe.db.get_single_value("SIGOS Settings", "abandono_modo")
	if actual in (None, "", "Apenas Alerta"):
		frappe.db.set_single_value("SIGOS Settings", "abandono_modo", "Automático")
		frappe.db.commit()

	# Presunções opened under the previous design (guard kept on posto, salary not
	# frozen): start their unpaid window at the detection date and freeze the
	# salary of guards still in Abandono. Their posto/escala is left as is —
	# release it with Registar Regresso / Demitir.
	for p in frappe.get_all(
		"Presuncao De Abandono", filters={"abandono_desde": ["is", "not set"]},
		fields=["name", "data_deteccao"],
	):
		frappe.db.set_value("Presuncao De Abandono", p.name, "abandono_desde", p.data_deteccao,
			update_modified=False)
	for v in frappe.get_all(
		"Vigilante", filters={"status": "Abandono de Posto", "salario_congelado": 0},
		fields=["name", "data_inicio_abandono"],
	):
		frappe.db.set_value("Vigilante", v.name, {
			"salario_congelado": 1,
			"salario_congelado_desde": v.data_inicio_abandono,
			"salario_congelado_motivo": "Congelado automaticamente — Abandono de Posto.",
		}, update_modified=False)
	frappe.db.commit()
