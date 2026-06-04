import frappe
from frappe.model.document import Document


class SIGOSSettings(Document):
	pass


def get_settings() -> "SIGOSSettings":
	return frappe.get_single("SIGOS Settings")
