import frappe


def _next_contract_name(customer):
	"""Suggest a contract name: '<Customer> NN' (NN = next sequence for that customer)."""
	if not customer:
		return None
	base = (frappe.db.get_value("Customer", customer, "customer_name") or customer).strip()
	n = frappe.db.count("Project", {"customer": customer}) + 1
	candidate = f"{base} {n:02d}"
	while frappe.db.exists("Project", {"project_name": candidate}):
		n += 1
		candidate = f"{base} {n:02d}"
	return candidate


@frappe.whitelist()
def next_contract_name(customer):
	return _next_contract_name(customer)


def project_before_insert(doc, method=None):
	"""When a contract (Project) has a customer but no name yet, name it '<Customer> NN'."""
	if doc.customer and not (doc.project_name or "").strip():
		doc.project_name = _next_contract_name(doc.customer)
