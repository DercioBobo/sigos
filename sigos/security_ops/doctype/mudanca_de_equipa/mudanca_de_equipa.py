from frappe.model.document import Document


class MudancaDeEquipa(Document):
	"""Log of a guard's Turno da Equipa changes on calendar escalas (written by
	EscalaDoVigilante.on_update; read by the Histórico do Vigilante)."""
	pass
