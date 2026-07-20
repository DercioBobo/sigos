import frappe

# Same set as vigilante.CAMPOS_OPERACIONAIS_RESERVA — kept as plain strings here
# (patches must survive independently of later refactors to the doctype module).
CAMPOS_VIG = (
	"posto_de_vigilancia", "nome_do_posto", "tipo_de_posto",
	"regime_do_vigilante", "delegacao", "tipo_de_vigilante",
	"projecto", "cliente", "nome_do_projecto",
)

# Vigilante field -> mirrored Employee field, for the subset of CAMPOS_VIG that
# sync._OPS_MIRROR actually mirrors (nome_do_posto/tipo_de_posto/nome_do_projecto
# have no Employee counterpart).
CAMPOS_EMP = {
	"posto_de_vigilancia": "custom_posto",
	"regime_do_vigilante": "custom_regime",
	"delegacao":           "custom_delegacao",
	"projecto":            "custom_project",
	"cliente":             "custom_cliente",
	"tipo_de_vigilante":   "custom_tipo_de_vigilante",
}


def execute():
	"""
	One-time backfill (2026-07-20) for guards already sitting in Reserva before
	vigilante.limpar_campos_operacionais existed — their posto/regime/delegação/
	tipo/contract fields (and the mirrored Employee copies) were left stale from
	whatever they were doing right before being benched. Categoria is
	deliberately left alone, matching the ongoing behavior.

	Direct DB writes rather than doc.save(): these guards already left their
	posto/escala long ago, so there's nothing to re-cascade (escala migration,
	occupation recount, timeline entries) — only the leftover field values need
	clearing.
	"""
	vigilantes = frappe.get_all(
		"Vigilante", filters={"status": "Reserva"}, fields=["name", "funcionario"],
	)

	for v in vigilantes:
		frappe.db.set_value(
			"Vigilante", v.name,
			{f: None for f in CAMPOS_VIG},
			update_modified=False,
		)
		if v.funcionario:
			frappe.db.set_value(
				"Employee", v.funcionario,
				{emp_f: None for emp_f in CAMPOS_EMP.values()},
				update_modified=False,
			)

	frappe.db.commit()
