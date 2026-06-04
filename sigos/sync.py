import frappe

VIGILANTE_TO_EMPLOYEE_STATUS = {
	"Pre-Adimissão RH": "Active",
	"Pre-Adimissão": "Active",
	"Ativo": "Active",
	"Inactivo": "Suspended",
	"Demitido": "Left",
}

GENDER_TO_SEXO = {"Male": "Masculino", "Female": "Feminino"}
SEXO_TO_GENDER = {"Masculino": "Male", "Feminino": "Female"}


def vigilante_to_employee(doc, method=None):
	# Use doc.flags (Frappe's built-in flag system) — survives across instances
	if doc.flags.get("ignore_sync"):
		return
	if not doc.funcionario:
		return

	try:
		emp = frappe.get_doc("Employee", doc.funcionario)
		emp.flags.ignore_sync = True
		changed = False

		new_status = VIGILANTE_TO_EMPLOYEE_STATUS.get(doc.status)
		if new_status and emp.status != new_status:
			emp.status = new_status
			changed = True

		ops_map = {
			"categoria":           "custom_categoria",
			"regime_do_vigilante": "custom_regime",
			"posto_de_vigilancia": "custom_posto",
			"delegacao":           "custom_delegacao",
			"mecanografico":       "custom_mecanografico",
			"tipo_de_vigilante":   "custom_tipo_de_vigilante",
		}
		for vig_f, emp_f in ops_map.items():
			val = getattr(doc, vig_f, None)
			if hasattr(emp, emp_f) and getattr(emp, emp_f, None) != val:
				setattr(emp, emp_f, val)
				changed = True

		if changed:
			emp.save(ignore_permissions=True)

	except Exception as e:
		frappe.log_error(
			f"Sync Vigilante→Employee falhou [{doc.name}]: {e}",
			"SIGOS Sync",
		)


def employee_to_vigilante(doc, method=None):
	if doc.flags.get("ignore_sync"):
		return

	vigilante_name = frappe.db.get_value(
		"Vigilante", {"funcionario": doc.name}, "name"
	)
	if not vigilante_name:
		return

	try:
		vig = frappe.get_doc("Vigilante", vigilante_name)
		vig.flags.ignore_sync = True
		changed = False

		personal_map = {
			"employee_name":  "nome_completo",
			"date_of_birth":  "data_de_nascimento",
			"cell_number":    "contacto",
			"date_of_joining": "data_admissao",
		}
		for emp_f, vig_f in personal_map.items():
			val = getattr(doc, emp_f, None)
			if val and getattr(vig, vig_f, None) != val:
				setattr(vig, vig_f, val)
				changed = True

		if doc.gender:
			sexo = GENDER_TO_SEXO.get(doc.gender)
			if sexo and vig.sexo != sexo:
				vig.sexo = sexo
				changed = True

		if changed:
			vig.save(ignore_permissions=True)

	except Exception as e:
		frappe.log_error(
			f"Sync Employee→Vigilante falhou [{doc.name}]: {e}",
			"SIGOS Sync",
		)
