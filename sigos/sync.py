import frappe
from sigos.security_ops.doctype.vigilante.vigilante import VIGILANTE_TO_EMP_STATUS

# ─── Status maps ───────────────────────────────────────────────────────────────
# Reverse status is intentionally narrow: only Suspended→Inactivo and Left→Demitido
# are unambiguous; "Active" maps to several Vigilante states so we don't push it back.
_EMP_TO_VIGILANTE_STATUS = {
	"Suspended": "Inactivo",
	"Left":      "Demitido",
}

# ─── Value-mapped fields ───────────────────────────────────────────────────────
SEXO_TO_GENDER = {"Masculino": "Male", "Feminino": "Female"}
GENDER_TO_SEXO = {v: k for k, v in SEXO_TO_GENDER.items()}

ESTCIVIL_TO_MARITAL = {
	"Solteiro": "Single", "Casado": "Married", "Divorciado": "Divorced",
	"Viúvo": "Widowed", "União de Facto": "Married",
}
MARITAL_TO_ESTCIVIL = {
	"Single": "Solteiro", "Married": "Casado", "Divorced": "Divorciado", "Widowed": "Viúvo",
}

# ─── Field maps (Vigilante field, Employee field) ──────────────────────────────
# Personal data — BIDIRECTIONAL (either side may be the source of truth).
_PERSONAL = [
	("data_de_nascimento",   "date_of_birth"),
	("contacto",             "cell_number"),
	("contacto_alternativo", "custom_contacto_alternativo"),
	("email",                "personal_email"),
	("data_admissao",        "date_of_joining"),
	("empresa",              "company"),
	("mecanografico",        "custom_mecanografico"),
	("nuit",                 "custom_nuit"),
	("documento",            "custom_tipo_documento"),
	("numero_documento",     "custom_numero_documento"),
	("residencia",           "custom_residencia"),
	("dependentes",          "custom_dependentes"),
]

# Operational data — FORWARD ONLY (Vigilante owns these; Employee fields are
# read-only mirrors, so we never push them back).
_OPS_MIRROR = [
	("categoria",           "custom_categoria"),
	("regime_do_vigilante", "custom_regime"),
	("posto_de_vigilancia", "custom_posto"),
	("delegacao",           "custom_delegacao"),
	("tipo_de_vigilante",   "custom_tipo_de_vigilante"),
	("idade",               "custom_idade"),
]


def _copy(src, dst, src_field, dst_field):
	"""
	Copy src_field→dst_field when the SOURCE has a real value and it differs.
	Fill, don't clear: an empty source must never blank out the destination
	(it would wipe required fields like Employee.date_of_joining / company).
	"""
	if not hasattr(dst, dst_field):
		return False
	val = getattr(src, src_field, None)
	if val in (None, ""):
		return False
	if getattr(dst, dst_field, None) != val:
		setattr(dst, dst_field, val)
		return True
	return False


# ─── Vigilante → Employee ──────────────────────────────────────────────────────

def vigilante_to_employee(doc, method=None):
	if doc.flags.get("ignore_sync"):
		return
	if not doc.funcionario:
		return

	try:
		emp = frappe.get_doc("Employee", doc.funcionario)
		emp.flags.ignore_sync = True
		changed = False

		# Status
		new_status = VIGILANTE_TO_EMP_STATUS.get(doc.status)
		if new_status and emp.status != new_status:
			emp.status = new_status
			changed = True

		# Name → first/last (HRMS rebuilds employee_name from the parts)
		if doc.nome_completo:
			parts = doc.nome_completo.strip().split()
			first = parts[0] if parts else doc.nome_completo
			last  = " ".join(parts[1:]) if len(parts) > 1 else ""
			if emp.first_name != first or (emp.last_name or "") != last:
				emp.first_name = first
				emp.last_name = last
				emp.employee_name = doc.nome_completo
				changed = True

		# Sexo → gender
		if doc.sexo:
			gender = SEXO_TO_GENDER.get(doc.sexo)
			if gender and emp.gender != gender:
				emp.gender = gender
				changed = True

		# Estado civil → marital_status
		if doc.estado_civil:
			marital = ESTCIVIL_TO_MARITAL.get(doc.estado_civil)
			if marital and getattr(emp, "marital_status", None) != marital:
				emp.marital_status = marital
				changed = True

		# Personal + operational direct fields
		for vig_f, emp_f in _PERSONAL + _OPS_MIRROR:
			if _copy(doc, emp, vig_f, emp_f):
				changed = True

		# Keep relieving_date coherent with the Employee status:
		#  - Left  -> HRMS requires one; fill with today if a direct DB write left it empty
		#  - Active -> a working employee must NOT carry a leaving date (readmissão); clear it,
		#    otherwise HR/payroll keep treating them as having left on that date.
		if emp.status == "Left" and not emp.get("relieving_date"):
			from frappe.utils import today
			emp.relieving_date = today()
			changed = True
		elif emp.status == "Active" and emp.get("relieving_date"):
			emp.relieving_date = None
			changed = True

		if changed:
			emp.save(ignore_permissions=True)

	except Exception as e:
		frappe.log_error(f"Sync Vigilante→Employee falhou [{doc.name}]: {e}", "SIGOS Sync")


# ─── Employee → Vigilante ──────────────────────────────────────────────────────

def employee_to_vigilante(doc, method=None):
	if doc.flags.get("ignore_sync"):
		return

	vigilante_name = frappe.db.get_value("Vigilante", {"funcionario": doc.name}, "name")
	if not vigilante_name:
		return

	try:
		vig = frappe.get_doc("Vigilante", vigilante_name)
		vig.flags.ignore_sync = True
		changed = False

		# Name (employee_name → nome_completo)
		if doc.employee_name and vig.nome_completo != doc.employee_name:
			vig.nome_completo = doc.employee_name
			changed = True

		# Gender → sexo
		if doc.gender:
			sexo = GENDER_TO_SEXO.get(doc.gender)
			if sexo and vig.sexo != sexo:
				vig.sexo = sexo
				changed = True

		# Marital status → estado civil
		if getattr(doc, "marital_status", None):
			estciv = MARITAL_TO_ESTCIVIL.get(doc.marital_status)
			if estciv and vig.estado_civil != estciv:
				vig.estado_civil = estciv
				changed = True

		# Personal direct fields (ops mirrors are NOT pushed back — Vigilante owns them)
		for vig_f, emp_f in _PERSONAL:
			if _copy(doc, vig, emp_f, vig_f):
				changed = True

		# Status: Suspended/Left → Inactivo/Demitido
		new_vig_status = _EMP_TO_VIGILANTE_STATUS.get(doc.status)
		if new_vig_status and vig.status != new_vig_status:
			vig.status = new_vig_status
			changed = True

		if changed:
			vig.save(ignore_permissions=True)

	except Exception as e:
		frappe.log_error(f"Sync Employee→Vigilante falhou [{doc.name}]: {e}", "SIGOS Sync")
