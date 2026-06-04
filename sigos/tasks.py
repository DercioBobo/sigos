import frappe


def daily():
	"""Daily scheduled tasks for SIGOS."""
	_atualizar_idades()
	_atualizar_todas_ocupacoes()
	_rolar_escalas()
	_verificar_postos_temporarios()


def _verificar_postos_temporarios():
	"""Notify managers once when an active temporary post passes its expected end date."""
	from frappe.utils import today

	postos = frappe.get_all(
		"Posto de Vigilancia",
		filters={
			"tipo_de_posto": "Temporário",
			"estado": "Ativo",
			"aviso_expiracao_enviado": 0,
			"data_fim_prevista": ["<=", today()],
		},
		fields=["name", "nome_do_posto", "data_fim_prevista"],
	)
	if not postos:
		return

	gestores = frappe.get_all(
		"Has Role",
		filters={"role": ["in", ["SIGOS Manager", "System Manager"]], "parenttype": "User"},
		pluck="parent",
	)
	gestores = [u for u in set(gestores) if u not in ("Administrator", "Guest")]

	for p in postos:
		try:
			for user in gestores:
				frappe.get_doc({
					"doctype": "Notification Log",
					"subject": f"Posto temporário expirado: {p.nome_do_posto}",
					"email_content": (
						f"O posto temporário <b>{p.nome_do_posto}</b> ({p.name}) atingiu o "
						f"fim previsto em {p.data_fim_prevista}. Reveja: encerrar, prorrogar ou "
						f"tornar permanente."
					),
					"for_user": user,
					"type": "Alert",
					"document_type": "Posto de Vigilancia",
					"document_name": p.name,
				}).insert(ignore_permissions=True)

			frappe.db.set_value(
				"Posto de Vigilancia", p.name, "aviso_expiracao_enviado", 1, update_modified=False
			)
			frappe.db.commit()
		except Exception as ex:
			frappe.db.rollback()
			frappe.log_error(f"Erro ao notificar posto temporário {p.name}: {ex}", "SIGOS Posto Temporário")


def _rolar_escalas():
	"""
	Roll every active Escala's window forward and trim old days.
	reconciliar_escala() is idempotent, future-only and override-safe, so this
	only appends new horizon days and removes days past the keep-buffer.
	"""
	escalas = frappe.get_all(
		"Escala do Vigilante",
		filters={"estado": "Activo"},
		fields=["name"],
	)
	for e in escalas:
		try:
			doc = frappe.get_doc("Escala do Vigilante", e.name)
			doc.reconciliar_escala()
			doc.save(ignore_permissions=True)
			frappe.db.commit()
		except Exception as ex:
			frappe.db.rollback()
			frappe.log_error(
				f"Erro ao rolar escala {e.name}: {ex}",
				"SIGOS Escala Daily Roll",
			)


def _atualizar_todas_ocupacoes():
	"""Nightly recalculation of all posto occupation counters."""
	from sigos.utils import atualizar_ocupacao_posto
	postos = frappe.get_all("Posto de Vigilancia", fields=["name"])
	for p in postos:
		atualizar_ocupacao_posto(p.name)


def _atualizar_idades():
	"""Recalculate age for all active vigilantes."""
	from frappe.utils import date_diff, today, getdate

	records = frappe.get_all(
		"Vigilante",
		filters={"data_de_nascimento": ["is", "set"]},
		fields=["name", "data_de_nascimento"],
	)
	hoje = getdate(today())
	for r in records:
		dob = getdate(r.data_de_nascimento)
		idade = (
			hoje.year - dob.year - ((hoje.month, hoje.day) < (dob.month, dob.day))
		)
		frappe.db.set_value("Vigilante", r.name, "idade", idade, update_modified=False)
