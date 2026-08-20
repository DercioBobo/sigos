import frappe
from frappe import _
from frappe.utils import nowdate, now_datetime

# ─── SMV (app do posto) integration ─────────────────────────────────────────
# One shared server-to-server credential for the SMV backend — NOT one per
# posto. SMV's own backend already knows which posto a given device/request
# belongs to (device<->posto assignment lives entirely on their side); every
# endpoint below takes an explicit `posto` parameter and trusts it, because
# the caller is SMV's backend (a controlled service), not an individual phone.
# See docs/mobile-api-spec.md for the full contract handed to the SMV dev.
#
# Posto isolation between SMV requests is therefore NOT enforced independently
# here beyond "does this posto exist and is it Activo" — it's SMV's backend's
# job to always pass the right posto. What IS still enforced server-side:
# the guard being marked absent must actually be escalado at that posto today
# (get_escalados_hoje / marcar_ausencia both re-check this), and the Ausencias
# permission grid keeps this role at write-not-submit no matter what's sent.

PAPEL_SMV = "SMV Integration"
SMV_USER = "smv@integration.sigos.local"


def _periodo_actual():
	"""Noon cutoff — same rule as Ausencias' own _periodo_automatico() in ausencias.js."""
	return "Manhã" if now_datetime().hour < 12 else "Noite"


def _get_posto_activo(posto):
	if not posto:
		frappe.throw(_("Parâmetro 'posto' em falta."))
	info = frappe.db.get_value(
		"Posto De Vigilancia", posto,
		["name", "nome_do_posto", "delegacao", "estado"], as_dict=True,
	)
	if not info:
		frappe.throw(_("Posto <b>{0}</b> não existe.").format(posto), frappe.DoesNotExistError)
	if info.estado != "Activo":
		frappe.throw(_("Posto <b>{0}</b> não está activo.").format(posto), frappe.PermissionError)
	return info


def _vigilante_escalado_no_posto(vigilante, posto, data):
	return frappe.db.sql(
		"""
		SELECT 1
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent
		WHERE te.vigilante = %(vigilante)s AND te.posto = %(posto)s AND te.data = %(data)s
		  AND e.estado = 'Activo'
		LIMIT 1
		""",
		{"vigilante": vigilante, "posto": posto, "data": data},
	)


@frappe.whitelist()
def get_postos():
	"""Full posto list, for SMV's backend to sync its own posto table against.
	`posto` (the PT-... code) is the permanent id to store and to send on every
	other call — nome_do_posto is an editable label, not safe as a foreign key."""
	frappe.only_for((PAPEL_SMV, "System Manager"))
	return frappe.get_all(
		"Posto De Vigilancia",
		fields=["name as posto", "nome_do_posto", "delegacao", "estado"],
		order_by="name",
	)


@frappe.whitelist()
def get_posto_info(posto):
	"""Sanity-check a posto id (existence + Activo) before relying on it."""
	frappe.only_for((PAPEL_SMV, "System Manager"))
	info = _get_posto_activo(posto)
	return {
		"posto": info.name,
		"nome_do_posto": info.nome_do_posto,
		"delegacao": info.delegacao,
		"estado": info.estado,
	}


@frappe.whitelist()
def get_opcoes():
	"""Current option lists — SIGOS Settings can change these without an SMV release."""
	frappe.only_for((PAPEL_SMV, "System Manager"))
	return {
		"tipo_de_ausencia": ["Falta", "Atraso", "Saída Antecipada", "Suspensão", "Licença", "Outro"],
		"subtipo_falta": ["Normal", "Vermelha"],
		"subtipo_falta_activo": bool(
			frappe.db.get_single_value("SIGOS Settings", "faltas_normal_vermelha_activo")
		),
		"proxima_accao": [
			"Sem Ação", "Substituto", "Dobra de Turno",
			"Meia Dobra", "Adiantamento de Turno", "Horas Extras",
		],
	}


@frappe.whitelist()
def get_escalados_hoje(posto, data=None):
	"""Roster for ONE posto — the guards actually scheduled there for the current
	período (noon cutoff). This is the only source the SMV app should offer for
	'who can I mark absent' — marcar_ausencia re-checks it server-side too."""
	frappe.only_for((PAPEL_SMV, "System Manager"))
	_get_posto_activo(posto)
	data = data or nowdate()
	periodo = _periodo_actual()

	rows = frappe.db.sql(
		"""
		SELECT
			te.vigilante, v.nome_completo, v.categoria,
			te.turno, COALESCE(NULLIF(te.periodo, ''), t.periodo) AS periodo
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent
		JOIN `tabVigilante` v ON v.name = te.vigilante
		JOIN `tabTurno` t ON t.name = te.turno
		WHERE e.estado = 'Activo' AND te.posto = %(posto)s AND te.data = %(data)s
		  AND (t.e_folga IS NULL OR t.e_folga = 0)
		  AND COALESCE(NULLIF(te.periodo, ''), t.periodo) = %(periodo)s
		ORDER BY v.nome_completo
		""",
		{"posto": posto, "data": data, "periodo": periodo},
		as_dict=True,
	)

	from sigos.api import _marcar_ja_registados
	_marcar_ja_registados(rows, data, periodo)

	return {"periodo_actual": periodo, "escalados": rows}


# ─── Candidate pools for each proxima_accao's companion field ──────────────────
# Mirrors the same pools the Desk pickers use (sigos.api.get_substitutos_disponiveis
# / get_escalados_no_posto_dia / get_vigilantes_de_folga_na_delegacao_dia, and
# ausencias.js's inline Adiantamento filter) but scoped to a single posto instead
# of a grupo_delegados/unsaved-doc context SMV has no concept of, and returned as
# plain dicts (as_dict) rather than the Desk's Link-search tuple format. Only
# SUBMITTED absences are excluded, same as those Desk queries — a same-período
# double-booking across two still-draft SMV calls is a pre-existing gap there too,
# not something introduced here.

@frappe.whitelist()
def get_candidatos(posto, proxima_accao, vigilante=None, data=None, periodo=None):
	"""
	Candidate vigilantes for whichever companion field `proxima_accao` needs on
	marcar_ausencia — call this before showing that picker, with the same
	posto/vigilante/data/periodo you're about to send there. `vigilante` (the
	guard being marked absent) is excluded from every pool so nobody can cover
	their own absence. "Sem Ação" needs no companion field and always returns [].
	"""
	frappe.only_for((PAPEL_SMV, "System Manager"))
	info = _get_posto_activo(posto)
	data = data or nowdate()
	periodo = periodo or _periodo_actual()

	if proxima_accao == "Sem Ação":
		return []
	if proxima_accao == "Substituto":
		return _candidatos_substituto(info.delegacao, vigilante, data, periodo)
	if proxima_accao in ("Dobra de Turno", "Meia Dobra"):
		return _candidatos_dobra(posto, vigilante, data)
	if proxima_accao == "Horas Extras":
		return _candidatos_horas_extras(info.delegacao, vigilante, data)
	if proxima_accao == "Adiantamento de Turno":
		return _candidatos_adiantamento(posto, vigilante)
	frappe.throw(_("Próxima Acção desconhecida: {0}").format(proxima_accao))


def _candidatos_substituto(delegacao, vigilante_ausente, data, periodo):
	"""Reserva pool for 'Substituto' — benched guards in this posto's own
	delegação, minus anyone already absent or already booked as substituto
	elsewhere this data+periodo (submitted docs only — see module note above)."""
	excl = tuple(v for v in [vigilante_ausente] if v) or ("",)
	return frappe.db.sql(
		"""
		SELECT v.name AS vigilante, v.nome_completo, v.categoria
		FROM `tabVigilante` v
		WHERE v.status = 'Reserva' AND v.delegacao = %(delegacao)s
		  AND (v.cobertura_de_posto_activa IS NULL OR v.cobertura_de_posto_activa = '')
		  AND v.name NOT IN %(excl)s
		  AND NOT EXISTS (
			SELECT 1 FROM `tabTabela Ausencia` ta
			JOIN `tabAusencias` a ON a.name = ta.parent
			WHERE a.docstatus = 1 AND a.data = %(data)s
			  AND (ta.vigilante = v.name
			       OR (ta.vigilante_substituto = v.name AND a.periodo = %(periodo)s))
		  )
		ORDER BY v.nome_completo
		""",
		{"delegacao": delegacao, "excl": excl, "data": data, "periodo": periodo},
		as_dict=True,
	)


def _candidatos_dobra(posto, vigilante_ausente, data):
	"""Guards already ESCALADOS at this same posto today — pool for 'Dobra de
	Turno'/'Meia Dobra' (Meia Dobra reuses the same real-world pool, just priced
	for half a shift in payroll)."""
	excl = tuple(v for v in [vigilante_ausente] if v) or ("",)
	return frappe.db.sql(
		"""
		SELECT DISTINCT te.vigilante, v.nome_completo, te.turno
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabVigilante` v ON v.name = te.vigilante
		WHERE te.posto = %(posto)s AND te.data = %(data)s
		  AND te.vigilante NOT IN %(excl)s
		  AND NOT EXISTS (
			SELECT 1 FROM `tabTabela Ausencia` tax
			JOIN `tabAusencias` ax ON ax.name = tax.parent
			WHERE ax.docstatus = 1 AND ax.data = %(data)s AND tax.vigilante = te.vigilante
		  )
		ORDER BY v.nome_completo
		""",
		{"posto": posto, "data": data, "excl": excl},
		as_dict=True,
	)


def _candidatos_horas_extras(delegacao, vigilante_ausente, data):
	"""Guards on FOLGA (day off) today, scoped to this posto's delegação (not the
	posto itself — a folga guard from any posto in the delegação can be called
	in) — pool for 'Horas Extras'."""
	excl = tuple(v for v in [vigilante_ausente] if v) or ("",)
	return frappe.db.sql(
		"""
		SELECT DISTINCT te.vigilante, v.nome_completo, te.turno
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabVigilante` v ON v.name = te.vigilante
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent AND e.estado = 'Activo'
		JOIN `tabTurno` t ON t.name = te.turno
		WHERE v.delegacao = %(delegacao)s AND te.data = %(data)s AND t.e_folga = 1
		  AND te.vigilante NOT IN %(excl)s
		  AND NOT EXISTS (
			SELECT 1 FROM `tabTabela Ausencia` tax
			JOIN `tabAusencias` ax ON ax.name = tax.parent
			WHERE ax.docstatus = 1 AND ax.data = %(data)s AND tax.vigilante = te.vigilante
		  )
		ORDER BY v.nome_completo
		""",
		{"delegacao": delegacao, "data": data, "excl": excl},
		as_dict=True,
	)


def _candidatos_adiantamento(posto, vigilante_ausente):
	"""Activo guards at this SAME posto — pool for 'Adiantamento de Turno' (one
	of them brings their own shift forward to cover the gap)."""
	excl = [v for v in [vigilante_ausente] if v]
	return frappe.get_all(
		"Vigilante",
		filters={
			"posto_de_vigilancia": posto, "status": "Activo",
			"name": ["not in", excl or [""]],
		},
		fields=["name as vigilante", "nome_completo", "categoria"],
		order_by="nome_completo",
	)


@frappe.whitelist()
def marcar_ausencia(
	posto, vigilante, tipo_de_ausencia, data=None, periodo=None,
	subtipo_falta=None, tipo_justificacao=None, jutificativo=None,
	proxima_accao=None,
	vigilante_substituto=None, vigilante_a_dobrar=None, vigilante_a_meia_dobra=None,
	vigilante_a_adiantar=None, vigilante_a_horas_extras=None,
):
	"""Mark one guard absent from `posto`. Always saved as a draft — the SMV
	Integration role has no submit right on Ausencias, enforced by the
	permission grid regardless of what's sent here. CCO submits later.

	Idempotent by vigilante+data+periodo (reuses marcar_ausencia_rapida) — safe
	for SMV to retry on a flaky connection without its own dedup logic."""
	frappe.only_for((PAPEL_SMV, "System Manager"))
	_get_posto_activo(posto)
	data = data or nowdate()
	periodo = periodo or _periodo_actual()

	if not _vigilante_escalado_no_posto(vigilante, posto, data):
		frappe.throw(
			_("O vigilante <b>{0}</b> não está escalado no posto <b>{1}</b> em {2} — "
			  "esta ausência não pode ser registada a partir deste posto.")
			.format(vigilante, posto, data),
			frappe.PermissionError,
		)

	from sigos.api import marcar_ausencia_rapida
	return marcar_ausencia_rapida(
		vigilante=vigilante, data=data, periodo=periodo, tipo_de_ausencia=tipo_de_ausencia,
		subtipo_falta=subtipo_falta, tipo_justificacao=tipo_justificacao, jutificativo=jutificativo,
		proxima_accao=proxima_accao,
		vigilante_substituto=vigilante_substituto, vigilante_a_dobrar=vigilante_a_dobrar,
		vigilante_a_meia_dobra=vigilante_a_meia_dobra, vigilante_a_adiantar=vigilante_a_adiantar,
		vigilante_a_horas_extras=vigilante_a_horas_extras,
	)


@frappe.whitelist()
def remover_marca(posto, ausencia_doc, ausencia_row):
	"""Undo a mark made in error, before CCO has submitted the sheet. Checks the
	ROW belongs to `posto` — an Ausencias sheet is shared by a whole grupo de
	delegados, so this stops one posto's SMV credential use from touching a
	row that came from a different posto on the same sheet."""
	frappe.only_for((PAPEL_SMV, "System Manager"))
	_get_posto_activo(posto)

	row_posto = frappe.db.get_value("Tabela Ausencia", ausencia_row, "posto")
	if row_posto != posto:
		frappe.throw(
			_("Esta linha não pertence ao posto <b>{0}</b>.").format(posto),
			frappe.PermissionError,
		)

	from sigos.api import remover_marca_ausencia
	return remover_marca_ausencia(ausencia_doc, ausencia_row)


# ─── One-time setup (run by a System Manager, not part of the SMV contract) ───

@frappe.whitelist()
def configurar_integracao_smv():
	"""Idempotent one-time setup: creates the smv@integration.sigos.local service
	user (Role + Ausencias permission already live in ausencias.json/hooks.py —
	`bench migrate` creates the Role automatically the first time it syncs).
	Run once, e.g. `bench --site <site> execute sigos.mobile_api.configurar_integracao_smv`.
	Does NOT generate API keys — call gerar_credenciais_smv() next."""
	frappe.only_for("System Manager")

	if not frappe.db.exists("User", SMV_USER):
		frappe.get_doc({
			"doctype": "User",
			"email": SMV_USER,
			"first_name": "SMV Integration",
			"send_welcome_email": 0,
			"user_type": "System User",
			"roles": [{"role": PAPEL_SMV}],
		}).insert(ignore_permissions=True)
	elif not frappe.db.exists("Has Role", {"parent": SMV_USER, "role": PAPEL_SMV}):
		user = frappe.get_doc("User", SMV_USER)
		user.append("roles", {"role": PAPEL_SMV})
		user.save(ignore_permissions=True)

	frappe.db.commit()
	return {"user": SMV_USER, "role": PAPEL_SMV, "proximo_passo": "gerar_credenciais_smv"}


@frappe.whitelist()
def gerar_credenciais_smv():
	"""Generate/rotate the API key+secret for the SMV service user. api_secret is
	only ever returned HERE (Frappe stores it hashed after this) — copy it
	immediately into SMV's backend config. Re-running this rotates the secret
	and invalidates the previous one instantly — the whole 'lost/leaked
	credential' story is just running this again."""
	frappe.only_for("System Manager")
	if not frappe.db.exists("User", SMV_USER):
		frappe.throw(_("Utilizador SMV ainda não existe — corra configurar_integracao_smv() primeiro."))

	from frappe.core.doctype.user.user import generate_keys
	resultado = generate_keys(SMV_USER)
	api_key = frappe.db.get_value("User", SMV_USER, "api_key")
	return {"api_key": api_key, "api_secret": resultado["api_secret"]}
