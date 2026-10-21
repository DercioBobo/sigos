import frappe
from frappe.utils import cint


def execute():
	"""
	Move the billing choices that lived on SIGOS Settings and on each Customer into
	billing profiles (Perfil De Faturacao), keeping every customer's billing exactly
	as it is:
	  - the Settings defaults become the 'Padrão' profile (= Settings default profile);
	  - customers whose own choices differ get a profile per distinct combination
	    (customers with the same choices share it);
	  - per-customer 'Vigilantes por Serviço' overrides (Tarifas por Regime) become
	    the profile's exceptions.
	The old Customer fields are then removed. Idempotent: skipped once any profile exists.
	"""
	from sigos.install import _load_custom_fields
	from sigos.perfil_faturacao import PERFIL, PERFIL_PADRAO
	from sigos.utils import valor_settings_bruto

	frappe.reload_doc("sigos_setup", "doctype", "perfil_faturacao_regime")
	frappe.reload_doc("sigos_setup", "doctype", "perfil_de_faturacao")
	if frappe.db.count(PERFIL):
		return
	_load_custom_fields()   # custom_perfil_faturacao must exist before customers point at it

	def bruto(campo, validos, padrao):
		v = valor_settings_bruto(campo)
		return v if v in validos else padrao

	detalhes = ("Por Contrato", "Por Posto", "Por Posto (uma linha)")
	meses = ("Mês Anterior", "Mês Corrente", "Mês Seguinte")
	modelos = {
		"Por Contrato": (valor_settings_bruto("modelo_descricao_contrato") or "").strip(),
		"Por Posto": (valor_settings_bruto("modelo_descricao_posto") or "").strip(),
		"Por Posto (uma linha)": (valor_settings_bruto("modelo_descricao_uma_linha") or "").strip(),
	}
	base = dict(
		faturar_por=bruto("faturar_por_padrao", ("Serviço", "Vigilante"), "Serviço"),
		metodo_faturacao=bruto("metodo_faturacao_padrao", ("Vigilantes Activos", "Contratual"),
			"Vigilantes Activos"),
		detalhe_fatura=bruto("detalhe_fatura_padrao", detalhes, "Por Contrato"),
		faturacao_automatica=0,
		dia_faturacao=min(max(cint(valor_settings_bruto("dia_faturacao_padrao")) or 25, 1), 31),
		mes_faturado=bruto("mes_faturado_padrao", meses, "Mês Corrente"),
	)
	base["modelo_descricao"] = modelos[base["detalhe_fatura"]]
	_criar(PERFIL_PADRAO, base, {}, "Perfil de origem (Definições SIGOS).")
	frappe.db.set_single_value("SIGOS Settings", "perfil_faturacao_padrao", PERFIL_PADRAO)

	# ── customers ──
	colunas = [c for c in ("custom_detalhe_fatura", "custom_faturar_por", "custom_modelo_descricao",
		"custom_faturacao_automatica", "custom_dia_faturacao", "custom_mes_faturado")
		if frappe.db.has_column("Customer", c)]
	excecoes = {}
	if frappe.db.has_column("Customer Tarifa Regime", "vigilantes_por_servico"):
		for r in frappe.db.sql("""
			SELECT parent, regime, vigilantes_por_servico FROM `tabCustomer Tarifa Regime`
			WHERE parenttype = 'Customer' AND IFNULL(vigilantes_por_servico, 0) > 0
		""", as_dict=True):
			excecoes.setdefault(r.parent, {})[r.regime] = cint(r.vigilantes_por_servico)

	grupos = {}
	if colunas or excecoes:
		sel = ", ".join(["name"] + colunas)
		for c in frappe.db.sql(f"SELECT {sel} FROM `tabCustomer`", as_dict=True):
			det = c.get("custom_detalhe_fatura")
			det = det if det in detalhes else base["detalhe_fatura"]
			fp = c.get("custom_faturar_por")
			fp = fp if fp in ("Serviço", "Vigilante") else base["faturar_por"]
			mes = c.get("custom_mes_faturado")
			mes = mes if mes in meses else base["mes_faturado"]
			dia = cint(c.get("custom_dia_faturacao"))
			valores = dict(
				faturar_por=fp, metodo_faturacao=base["metodo_faturacao"], detalhe_fatura=det,
				modelo_descricao=(c.get("custom_modelo_descricao") or "").strip() or modelos[det],
				faturacao_automatica=cint(c.get("custom_faturacao_automatica")),
				dia_faturacao=min(dia, 31) if dia > 0 else base["dia_faturacao"],
				mes_faturado=mes,
			)
			if not valores["faturacao_automatica"]:   # day/month only matter when automatic
				valores.update(dia_faturacao=base["dia_faturacao"], mes_faturado=base["mes_faturado"])
			reg = excecoes.get(c.name, {})
			if valores == base and not reg:
				continue
			chave = (tuple(sorted(valores.items())), tuple(sorted(reg.items())))
			grupos.setdefault(chave, (valores, reg, []))[2].append(c.name)

	usados = {PERFIL_PADRAO}
	for valores, reg, clientes in grupos.values():
		nome = _nome(valores, reg, base, clientes, usados)
		_criar(nome, valores, reg, "Criado na migração para perfis.")
		for c in clientes:
			frappe.db.set_value("Customer", c, "custom_perfil_faturacao", nome, update_modified=False)

	# ── old Customer fields ──
	for campo in ("custom_detalhe_fatura", "custom_faturar_por", "custom_modelo_descricao",
			"custom_modelo_descricao_preview", "custom_sec_fat_auto_cliente",
			"custom_faturacao_automatica", "custom_col_fat_auto_cliente", "custom_dia_faturacao",
			"custom_mes_faturado"):
		nome = frappe.db.get_value("Custom Field", {"dt": "Customer", "fieldname": campo})
		if nome:
			frappe.delete_doc("Custom Field", nome, ignore_permissions=True, force=True)
	frappe.clear_cache(doctype="Customer")


def _criar(nome, valores, regimes, nota):
	doc = frappe.get_doc(dict(valores, doctype="Perfil De Faturacao", nome=nome, descricao=nota))
	for regime, n in sorted(regimes.items()):
		if frappe.db.exists("Regime", regime):
			doc.append("regimes", {"regime": regime, "vigilantes_por_servico": n})
	doc.insert(ignore_permissions=True)


def _nome(valores, regimes, base, clientes, usados):
	"""Readable name from what differs from Padrão, e.g. 'Uma linha por posto · Automático dia 25'."""
	partes = []
	if valores["detalhe_fatura"] != base["detalhe_fatura"]:
		partes.append({"Por Contrato": "Por contrato", "Por Posto": "Por posto",
			"Por Posto (uma linha)": "Uma linha por posto"}[valores["detalhe_fatura"]])
	if valores["faturar_por"] != base["faturar_por"]:
		partes.append("Por vigilante" if valores["faturar_por"] == "Vigilante" else "Por serviço")
	if valores["faturacao_automatica"]:
		auto = f"Automático dia {valores['dia_faturacao']}"
		if valores["mes_faturado"] != "Mês Corrente":
			auto += " · " + ("mês anterior" if valores["mes_faturado"] == "Mês Anterior" else "mês seguinte")
		partes.append(auto)
	if valores["modelo_descricao"] != base["modelo_descricao"] or regimes:
		partes.append("Personalizado" if len(clientes) > 1 else clientes[0])
	nome = (" · ".join(partes) or "Perfil")[:120]
	final, n = nome, 2
	while final in usados or frappe.db.exists("Perfil De Faturacao", final):
		final, n = f"{nome} ({n})", n + 1
	usados.add(final)
	return final
