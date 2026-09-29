import frappe


def execute():
	"""Switch the payroll daily divisor to the fixed 30-day commercial month (the base
	is the same every month, so the daily value for faltas/dobras/horas extras must be
	too). Only replaces the old calendar default — an explicit "Dias Úteis (HRMS)"
	choice is left alone."""
	atual = frappe.db.get_single_value("SIGOS Settings", "base_dias_de_trabalho")
	if atual in (None, "", "Dias do Mês"):
		frappe.db.set_single_value("SIGOS Settings", "base_dias_de_trabalho", "30 Dias (Mês Comercial)")
