import frappe

# Loans used to live as Outras Deducoes rows with tipo="Emprestimo". They now have
# their own Emprestimo doctype. This moves any existing loan into Emprestimo
# (preserving values verbatim — validation is skipped so historical limits don't
# block the copy) and neutralises the old Outras Deducoes record so the installment
# is never double-counted nor left orphaned (the salary-slip hook no longer maps
# tipo=Emprestimo). Idempotent via the origem_deducao back-link.


def execute():
	if not frappe.db.exists("DocType", "Emprestimo"):
		return
	if not frappe.db.has_column("Outras Deducoes", "tipo"):
		return

	old_loans = frappe.get_all(
		"Outras Deducoes",
		filters={"tipo": "Emprestimo"},
		fields=[
			"name", "funcionario", "salario_base",
			"valor_a_pagar", "meses_a_pagar", "valor_mensal", "mes_referencia",
			"data_de_inicio", "data_de_fim", "estado", "descricao",
			"termo_de_responsabilidade", "docstatus",
		],
	)

	for old in old_loans:
		if frappe.db.exists("Emprestimo", {"origem_deducao": old.name}):
			continue

		try:
			emp = frappe.get_doc({
				"doctype": "Emprestimo",
				"funcionario": old.funcionario,
				"salario_base": old.salario_base,
				"valor_a_pagar": old.valor_a_pagar,
				"meses_a_pagar": old.meses_a_pagar,
				"valor_mensal": old.valor_mensal,
				"mes_referencia": old.mes_referencia,
				"data_de_inicio": old.data_de_inicio,
				"data_de_fim": old.data_de_fim,
				"estado": old.estado or "Activo",
				"descricao": old.descricao,
				"termo_de_responsabilidade": old.termo_de_responsabilidade,
				"origem_deducao": old.name,
			})
			emp.flags.ignore_validate = True   # keep historical values exactly as recorded
			emp.insert(ignore_permissions=True)
			if old.docstatus == 1:
				emp.submit()

			# Remove the old record from active processing
			old_doc = frappe.get_doc("Outras Deducoes", old.name)
			if old_doc.docstatus == 1:
				old_doc.flags.ignore_permissions = True
				old_doc.cancel()
			elif old_doc.docstatus == 0:
				frappe.delete_doc(
					"Outras Deducoes", old.name,
					ignore_permissions=True, force=True,
				)
		except Exception:
			frappe.log_error(
				f"migrate_emprestimos: falha ao migrar {old.name}",
				"SIGOS Migrate Emprestimos",
			)

	frappe.db.commit()
