import frappe
from frappe.model.document import Document


class ProjectSubsidioAplicacao(Document):
	"""One (project, salary_component, vigilante) triple = that guard receives
	that project subsídio. Managed exclusively through the Project form's
	"Gerir Subsídios" matrix modal (sigos.api.salvar_project_subsidio_matrix does
	a full delete+bulk-insert per project) — never hand-edited record by record."""
	pass
