import frappe


def execute():
	"""RVP was incoherent (requer_substituto with no outcome). Removed guard -> Reserva."""
	if frappe.db.exists("Operacao De Rotatividade", "RVP"):
		frappe.db.set_value("Operacao De Rotatividade", "RVP", "enviar_reserva", 1)
		frappe.db.commit()
