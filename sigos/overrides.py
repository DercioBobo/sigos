import frappe
from frappe import _


def project_dashboard(data):
	"""
	Add a SIGOS "Operações" connection to the Project (contract) form so it lists
	every Posto De Vigilancia tied to this contract, with a live count badge and a
	one-click "+ New Posto" that pre-fills the project. Posto De Vigilancia links to
	Project via its `project` field (non-standard fieldname, so it's mapped below).
	"""
	data = dict(data or {})
	data.setdefault("transactions", [])
	data.setdefault("non_standard_fieldnames", {})

	data["non_standard_fieldnames"]["Posto De Vigilancia"] = "project"
	data["transactions"].append({
		"label": _("Operações"),
		"items": ["Posto De Vigilancia"],
	})
	return data
