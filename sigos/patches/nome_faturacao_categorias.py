import frappe


def execute():
	"""Invoice names for the standard categorias (H24 Armado / H24 Simples), only
	where none was set."""
	frappe.reload_doc("sigos_setup", "doctype", "categoria_vigilante")
	for categoria, nome in (("Vigilante Armado", "Armado"), ("Vigilante Normal", "Simples")):
		if frappe.db.exists("Categoria Vigilante", categoria) and not frappe.db.get_value(
				"Categoria Vigilante", categoria, "nome_faturacao"):
			frappe.db.set_value("Categoria Vigilante", categoria, "nome_faturacao", nome,
				update_modified=False)
