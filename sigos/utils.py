"""
SIGOS shared utilities — imported by ausencias.py, salary_slip_hooks.py, and API.
Single source of truth for all business calculations.
"""
import frappe
from frappe.utils import getdate


# ─── Regime cache (per request) ───────────────────────────────────────────────

_regime_cache: dict = {}


def _get_regime(regime_nome: str):
	"""Return the Regime document, cached within the current request."""
	if regime_nome not in _regime_cache:
		try:
			_regime_cache[regime_nome] = frappe.get_doc("Regime", regime_nome)
		except frappe.DoesNotExistError:
			_regime_cache[regime_nome] = None
	return _regime_cache[regime_nome]


def calcular_n_faltas(regime_nome: str, turno: str) -> int:
	"""
	Look up how many faltas a given Turno (docname) counts in a given Regime.
	Falls back to 1 if the regime or turno is not found — never returns 0 for
	a non-folga turn so salary is always protected.
	"""
	if not regime_nome or not turno:
		return 1

	regime = _get_regime(regime_nome)
	if not regime:
		return 1

	return regime.get_n_faltas(turno)


def get_regime_turno_sequence(regime_nome: str) -> list:
	"""
	Return the ordered list of turno dicts for a regime.
	Each dict: {turno (Turno docname), periodo, e_folga, n_de_faltas, idx}
	"""
	regime = _get_regime(regime_nome)
	if not regime:
		return []
	return regime.get_turno_sequence()


def calcular_faltas_vigilante(vigilante: str, start_date, end_date) -> int:
	"""
	Sum n_de_faltas for a vigilante across all submitted Ausencias in [start_date, end_date].
	Reads the stored n_de_faltas from Tabela Ausencia (already validated by ausencias.py).
	"""
	if not vigilante:
		return 0

	result = frappe.db.sql(
		"""
		SELECT COALESCE(SUM(ta.n_de_faltas), 0) AS total
		FROM `tabTabela Ausencia` ta
		JOIN `tabAusencias` a ON a.name = ta.parent
		WHERE a.docstatus = 1
		  AND ta.vigilante = %(vigilante)s
		  AND a.data BETWEEN %(start)s AND %(end)s
		""",
		{"vigilante": vigilante, "start": getdate(start_date), "end": getdate(end_date)},
		as_dict=True,
	)
	return int(result[0].total) if result else 0


def atualizar_ocupacao_posto(posto_name: str):
	"""
	Recompute ocupacao_atual and status_ocupacao for a Posto De Vigilancia.
	Call this whenever a Vigilante's posto changes or numero_de_vagas changes.
	"""
	if not posto_name:
		return

	try:
		max_vagas = frappe.db.get_value("Posto De Vigilancia", posto_name, "numero_de_vagas") or 0

		atual = frappe.db.count(
			"Vigilante",
			{"posto_de_vigilancia": posto_name, "status": "Ativo"},
		)

		if max_vagas == 0:
			status = "Sem Limite"
		elif atual < max_vagas:
			status = "Desfalcado"
		elif atual == max_vagas:
			status = "Completo"
		else:
			status = "Excedido"

		frappe.db.set_value(
			"Posto De Vigilancia",
			posto_name,
			{"ocupacao_atual": atual, "status_ocupacao": status},
			update_modified=False,
		)
	except Exception as e:
		frappe.log_error(
			f"Erro ao actualizar ocupação do posto {posto_name}: {e}",
			"SIGOS Ocupação",
		)


def get_escalas_activas_com_vigilante(vigilante: str) -> list:
	"""
	Return all Activo Escalas that contain this vigilante.
	Used to surface alerts after Rotatividade, Demissão, or Troca De Regime.
	"""
	from sigos.security_ops.doctype.escala_do_vigilante.escala_do_vigilante import (
		get_escalas_com_vigilante,
	)
	return get_escalas_com_vigilante(vigilante)


def alertar_escalas_desactualizadas(vigilante: str, motivo: str):
	"""
	Show a frappe.msgprint listing all active Escalas that still contain
	this vigilante after a change that affects their assignment.
	Called from Rotatividade, Demissão, Troca De Regime on_submit.
	"""
	escalas = get_escalas_activas_com_vigilante(vigilante)
	if not escalas:
		return

	links = "".join(
		f"<li><a href='/app/escala-do-vigilante/{e.name}'>{e.name}</a> "
		f"— Posto: {e.posto_de_vigilancia} "
		f"(desde {e.data_de_inicio}, gerado até {e.gerado_ate})</li>"
		for e in escalas
	)

	frappe.msgprint(
		_(
			"<b>Atenção — Escalas que precisam ser actualizadas:</b><br>"
			"O vigilante <b>{0}</b> ainda aparece nas seguintes escalas activas "
			"após <b>{1}</b>. Por favor, actualize ou arquive conforme necessário:"
			"<ul>{2}</ul>"
		).format(vigilante, motivo, links),
		title=_("Escalas Desactualizadas"),
		indicator="orange",
	)


def get_ausencias_docs_para_periodo(vigilante: str, start_date, end_date) -> list:
	"""
	Return the list of Ausencias document names that affect this vigilante
	in the given period. Used for audit trails on Salary Slips.
	"""
	return frappe.db.sql(
		"""
		SELECT DISTINCT a.name
		FROM `tabTabela Ausencia` ta
		JOIN `tabAusencias` a ON a.name = ta.parent
		WHERE a.docstatus = 1
		  AND ta.vigilante = %(vigilante)s
		  AND a.data BETWEEN %(start)s AND %(end)s
		""",
		{"vigilante": vigilante, "start": getdate(start_date), "end": getdate(end_date)},
		pluck="name",
	)
