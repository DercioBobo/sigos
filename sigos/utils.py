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


def _folga_turnos(regime_nome: str) -> set:
	"""Turno names that are folgas (days off) for a regime — from Regime Turno Item."""
	regime = _get_regime(regime_nome)
	if not regime:
		return set()
	return {r.turno for r in regime.turnos if r.e_folga}


def _regime_deduz_consecutivas(regime_nome: str) -> bool:
	"""Whether this regime applies the consecutive-falta de-dup (opt-in, per regime)."""
	regime = _get_regime(regime_nome)
	return bool(regime and regime.get("faltas_consecutivas_contam_um"))


def _turno_anterior_de_trabalho(vigilante: str, regime_nome: str, data):
	"""
	Date of the guard's previous WORKING escala shift strictly before `data`
	(folga days are skipped). Read from the actual generated escala, so it honours
	the real rotation/overrides. Returns a date or None.
	"""
	folgas = _folga_turnos(regime_nome)
	params = {"vig": vigilante, "data": getdate(data)}
	cond = ""
	if folgas:
		cond = "AND te.turno NOT IN %(folgas)s"
		params["folgas"] = tuple(folgas)
	prev = frappe.db.sql(
		f"""
		SELECT te.data
		FROM `tabTabela De Escala De Vigilante` te
		WHERE te.vigilante = %(vig)s AND te.data < %(data)s {cond}
		ORDER BY te.data DESC
		LIMIT 1
		""",
		params,
	)
	return getdate(prev[0][0]) if prev else None


def calcular_faltas_detalhado(vigilante: str, start_date, end_date) -> list:
	"""
	Per-absence faltas for a guard, escala-aware, with a running cumulative.

	- Base weight = Regime Turno Item.n_de_faltas for the (regime, turno).
	- DE-DUP: a missed shift whose immediately preceding WORKING escala shift was ALSO
	  missed counts 1 — the folgas in between were already paid for by that previous
	  shift's weight (so 2a Noite=3 then the next 1a Manhã=1, not 3).
	- Cumulative is summed only within [start, end]; absences before start are still
	  read so the de-dup can see across the month boundary.

	Single source of truth for the Cumulativo de Faltas report AND payroll.
	"""
	if not vigilante:
		return []
	start, end = getdate(start_date), getdate(end_date)

	absences = frappe.db.sql(
		"""
		SELECT a.name AS ausencia, a.data AS data, ta.turno, ta.regime, ta.posto,
		       ta.nome_do_vigilante, ta.tipo_de_ausencia, ta.subtipo_falta,
		       ta.tipo_justificacao, ta.n_de_faltas
		FROM `tabTabela Ausencia` ta
		JOIN `tabAusencias` a ON a.name = ta.parent
		WHERE a.docstatus = 1 AND ta.vigilante = %(vig)s AND a.data <= %(end)s
		ORDER BY a.data ASC, a.name ASC
		""",
		{"vig": vigilante, "end": end},
		as_dict=True,
	)
	if not absences:
		return []

	absence_dates = {getdate(a.data) for a in absences}
	rows = []
	cumul = 0
	for a in absences:
		d = getdate(a.data)
		# Always derive the BASE from the regime — never from the stored n_de_faltas,
		# which is itself the de-dup'd value (else we'd de-dup twice).
		base = calcular_n_faltas(a.regime, a.turno)
		dedup = False
		if _regime_deduz_consecutivas(a.regime):
			anterior = _turno_anterior_de_trabalho(vigilante, a.regime, d)
			dedup = anterior is not None and anterior in absence_dates
		efetivo = 1 if dedup else int(base or 1)
		if start <= d <= end:
			cumul += efetivo
			rows.append({
				"vigilante": vigilante,
				"nome_do_vigilante": a.nome_do_vigilante,
				"regime": a.regime,
				"posto": a.posto,
				"turno": a.turno,
				"tipo_de_ausencia": a.tipo_de_ausencia,
				"subtipo_falta": a.subtipo_falta,
				"tipo_justificacao": a.tipo_justificacao,
				"n_de_faltas": efetivo,
				"cumulativo_de_faltas": cumul,
				"data": d,
				"ausencia": a.ausencia,
			})
	return rows


def calcular_faltas_vigilante(vigilante: str, start_date, end_date) -> int:
	"""
	Total faltas for a guard in [start, end] — escala-aware (consecutive missed shifts
	don't double-count the folgas). Same source as the Cumulativo de Faltas report, so
	the salary slip and the report always agree.
	"""
	if not vigilante:
		return 0
	return sum(r["n_de_faltas"] for r in calcular_faltas_detalhado(vigilante, start_date, end_date))


def calcular_faltas_vermelhas_vigilante(vigilante: str, start_date, end_date) -> int:
	"""
	Same escala-aware weighting as calcular_faltas_vigilante, counting only rows
	tagged subtipo_falta == 'Vermelha' — feeds the customer-specific férias
	withholding in salary_slip_hooks (SIGOS Settings.faltas_normal_vermelha_activo).
	"""
	if not vigilante:
		return 0
	return sum(
		r["n_de_faltas"] for r in calcular_faltas_detalhado(vigilante, start_date, end_date)
		if r.get("subtipo_falta") == "Vermelha"
	)


def calcular_dobras_vigilante(vigilante: str, start_date, end_date) -> int:
	"""
	Number of EXTRA shifts a guard covered (Dobra / Adiantamento) in [start, end],
	from SUBMITTED Ausencias. Each covered row = one extra shift worked on top of the
	guard's own — the earnings mirror of a falta. Substituto is deliberately excluded
	(a planned replacement filling a post, not extra effort beyond one's own shift).
	Single source so the slip and any report agree, like calcular_faltas_vigilante.
	"""
	if not vigilante:
		return 0
	row = frappe.db.sql(
		"""
		SELECT COUNT(*)
		FROM `tabTabela Ausencia` ta
		JOIN `tabAusencias` a ON a.name = ta.parent
		WHERE a.docstatus = 1 AND a.data BETWEEN %(s)s AND %(e)s
		  AND (
		    (ta.proxima_accao = 'Dobra de Turno' AND ta.vigilante_a_dobrar = %(v)s)
		    OR (ta.proxima_accao = 'Adiantamento de Turno' AND ta.vigilante_a_adiantar = %(v)s)
		  )
		""",
		{"v": vigilante, "s": getdate(start_date), "e": getdate(end_date)},
	)
	return int(row[0][0]) if row and row[0] else 0


def calcular_meias_dobras_vigilante(vigilante: str, start_date, end_date) -> int:
	"""
	Number of HALF shifts a guard covered (Meia Dobra) in [start, end], from SUBMITTED
	Ausencias — same source/shape as calcular_dobras_vigilante, kept as its own count
	(not folded into it) so the slip can price a half-covered shift differently from a
	full one and show its own earnings line.
	"""
	if not vigilante:
		return 0
	row = frappe.db.sql(
		"""
		SELECT COUNT(*)
		FROM `tabTabela Ausencia` ta
		JOIN `tabAusencias` a ON a.name = ta.parent
		WHERE a.docstatus = 1 AND a.data BETWEEN %(s)s AND %(e)s
		  AND ta.proxima_accao = 'Meia Dobra' AND ta.vigilante_a_meia_dobra = %(v)s
		""",
		{"v": vigilante, "s": getdate(start_date), "e": getdate(end_date)},
	)
	return int(row[0][0]) if row and row[0] else 0


def _existe_falta(vigilante: str, data, excluir_ausencia: str = None) -> bool:
	"""True if a SUBMITTED absence exists for the guard on `data`."""
	cond = ""
	params = {"v": vigilante, "d": getdate(data)}
	if excluir_ausencia:
		cond = "AND a.name != %(excl)s"
		params["excl"] = excluir_ausencia
	return bool(frappe.db.sql(
		f"""
		SELECT 1 FROM `tabTabela Ausencia` ta
		JOIN `tabAusencias` a ON a.name = ta.parent
		WHERE a.docstatus = 1 AND ta.vigilante = %(v)s AND a.data = %(d)s {cond}
		LIMIT 1
		""",
		params,
	))


def _turno_seguinte_de_trabalho(vigilante: str, regime_nome: str, data):
	"""Date of the guard's NEXT working escala shift strictly after `data` (folgas skipped)."""
	folgas = _folga_turnos(regime_nome)
	params = {"vig": vigilante, "data": getdate(data)}
	cond = ""
	if folgas:
		cond = "AND te.turno NOT IN %(folgas)s"
		params["folgas"] = tuple(folgas)
	nxt = frappe.db.sql(
		f"""
		SELECT te.data
		FROM `tabTabela De Escala De Vigilante` te
		WHERE te.vigilante = %(vig)s AND te.data > %(data)s {cond}
		ORDER BY te.data ASC
		LIMIT 1
		""",
		params,
	)
	return getdate(nxt[0][0]) if nxt else None


def calcular_n_faltas_efetivo(vigilante: str, regime_nome: str, turno: str, data) -> int:
	"""
	The effective n_de_faltas for ONE missed shift — what gets stored on Tabela Ausencia.
	Base = Regime Turno Item weight; reduced to 1 if the guard's previous WORKING escala
	shift was ALSO a submitted absence (the folgas were already paid for there).
	"""
	base = calcular_n_faltas(regime_nome, turno)
	if not (vigilante and data):
		return base
	if not _regime_deduz_consecutivas(regime_nome):
		return base
	anterior = _turno_anterior_de_trabalho(vigilante, regime_nome, data)
	if anterior and _existe_falta(vigilante, anterior):
		return 1
	return base


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
			{"posto_de_vigilancia": posto_name, "status": "Activo"},
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
