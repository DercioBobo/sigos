import frappe
from frappe import _
from frappe.utils import cint, flt, get_first_day, get_last_day, getdate


def project_validate(doc, method=None):
	"""
	Contract (Project) tables: one row per regime (+ categoria) in each, and the
	Finance table's line totals + Total Mensal Contratado kept in sync (qty x valor).
	"""
	_regimes_unicos(doc, "custom_faturacao_regimes", _("Faturação por Regime"))
	_regimes_unicos(doc, "custom_regime_rates", _("Salários por Regime"))
	_validar_adicionais(doc)

	# A row without its own price uses the customer's (Tarifas por Regime).
	do_cliente = tarifas_dos_clientes([doc.customer])
	total = 0
	for row in doc.get("custom_faturacao_regimes") or []:
		valor = flt(row.valor) or flt((procurar_tarifa(do_cliente, (doc.customer, row.regime),
			row.get("categoria")) or {}).get("valor"))
		row.total = cint(row.quantidade) * valor
		total += row.total
	if doc.meta.has_field("custom_total_contratual"):
		doc.custom_total_contratual = total


def customer_validate(doc, method=None):
	"""Customer 'Tarifas por Regime': one row per regime (+ categoria)."""
	_regimes_unicos(doc, "custom_tarifas_regime", _("Tarifas por Regime"))
	_validar_adicionais(doc)


def _regimes_unicos(doc, campo, rotulo):
	vistos = set()
	for row in doc.get(campo) or []:
		if not row.regime:
			continue
		chave = (row.regime, row.get("categoria") or "")
		if chave in vistos:
			frappe.throw(
				_("<b>{0}</b> aparece mais de uma vez em <b>{1}</b> (linha {2}).").format(
					" ".join(c for c in chave if c), rotulo, row.idx),
				title=_("Regime Duplicado"),
			)
		vistos.add(chave)


# ─── Billing rate: contract first, then the customer ─────────────────────────
# Rate rows are per regime and, optionally, per guard categoria (H24 Armado vs H24
# Simples). A row without categoria is the regime's price for any categoria.

def procurar_tarifa(tabela, chave, categoria):
	"""The row for chave (e.g. (contrato, regime)) + categoria: the categoria's own
	row, else the regime's row without categoria."""
	return tabela.get(chave + (categoria or "",)) or (tabela.get(chave + ("",)) if categoria else None)


def tarifas_dos_clientes(clientes):
	"""{(cliente, regime, categoria): {valor, descricao}} from each Customer's Tarifas
	por Regime ('' = any categoria)."""
	clientes = [c for c in set(clientes or []) if c]
	if not clientes or not frappe.db.table_exists("Customer Tarifa Regime"):
		return {}
	com_cat = frappe.db.has_column("Customer Tarifa Regime", "categoria")
	return {
		(r.parent, r.regime, r.get("categoria") or ""): r
		for r in frappe.get_all("Customer Tarifa Regime",
			filters={"parenttype": "Customer", "parent": ["in", clientes]},
			fields=["parent", "regime", "valor", "descricao"] + (["categoria"] if com_cat else []))
	}


def linhas_contratadas(projectos):
	"""{(contrato, regime, categoria): row} from the contracts' Finance table."""
	if not projectos:
		return {}
	com_cat = frappe.db.has_column("Project Faturacao Regime", "categoria")
	return {
		(f.parent, f.regime, f.get("categoria") or ""): f
		for f in frappe.get_all("Project Faturacao Regime",
			filters={"parenttype": "Project", "parent": ["in", list(projectos)]},
			fields=["parent", "regime", "quantidade", "valor", "descricao"] + (["categoria"] if com_cat else []),
			order_by="parent, idx")
	}


def resolver_tarifa(linha_contrato, tarifa_cliente):
	"""
	The ONE rule for a contract+regime(+categoria) billing rate, used everywhere
	(billing lines, stale-preview check, contract totals, rate API):
	  1. the contract's own Valor / Vigilante, when set;
	  2. else the customer's Tarifas por Regime;
	  3. else unpriced (0, '') — flagged 'sem tarifa', never billed.
	Returns (valor, origem, descricao) — origem 'Contrato' | 'Cliente' | ''.
	"""
	if linha_contrato and flt(linha_contrato.get("valor")):
		return flt(linha_contrato.get("valor")), "Contrato", (linha_contrato.get("descricao") or "")
	desc_contrato = (linha_contrato or {}).get("descricao") or ""
	if tarifa_cliente and flt(tarifa_cliente.get("valor")):
		return (flt(tarifa_cliente.get("valor")), "Cliente",
			desc_contrato or (tarifa_cliente.get("descricao") or ""))
	return 0.0, "", desc_contrato


def nomes_faturacao_categorias():
	"""{categoria: name on the invoice} — 'Nome na Factura', else the categoria."""
	com_nome = frappe.db.has_column("Categoria Vigilante", "nome_faturacao")
	return {c.name: (c.get("nome_faturacao") or "").strip() or c.name
		for c in frappe.get_all("Categoria Vigilante",
			fields=["name"] + (["nome_faturacao"] if com_nome else []))}


def rotulo_tarifa(regime, categoria, nomes=None):
	"""'H24 Armado' — regime + the categoria's invoice name ('H24' without categoria)."""
	if not categoria:
		return regime or ""
	nome = (nomes if nomes is not None else nomes_faturacao_categorias()).get(categoria) or categoria
	return f"{regime} {nome}".strip()


# ─── Extra invoice lines (arma, rádio, viatura…) ─────────────────────────────
# 'Linhas Adicionais' on the contract, else on its customer. Each row is billed as
# its own line: a fixed quantity, or counted from the active guards (optionally of
# one categoria / regime) or from the postos that have guards.

ADICIONAL_FIXA = "Fixa"
ADICIONAL_VIGILANTES = "Vigilantes"
ADICIONAL_POSTOS = "Postos"


def _validar_adicionais(doc):
	for row in doc.get("custom_linhas_adicionais") or []:
		if row.contar_por == ADICIONAL_FIXA and cint(row.quantidade) <= 0:
			frappe.throw(_("Linhas Adicionais, linha {0}: indique a quantidade.").format(row.idx))
		if row.valido_de and row.valido_ate and getdate(row.valido_de) > getdate(row.valido_ate):
			frappe.throw(_("Linhas Adicionais, linha {0}: 'Válido De' depois de 'Válido Até'.").format(row.idx))


def tabelas_adicionais(projectos, clientes):
	"""{("P", contrato) | ("C", cliente): {idx: row}} — the extra lines of the
	contracts and customers."""
	out = {}
	if not frappe.db.table_exists("Linha Adicional Faturacao"):
		return out
	for tipo, doctype, nomes in (("P", "Project", projectos), ("C", "Customer", clientes)):
		nomes = [n for n in set(nomes or []) if n]
		if not nomes:
			continue
		for r in frappe.get_all("Linha Adicional Faturacao",
				filters={"parenttype": doctype, "parentfield": "custom_linhas_adicionais",
					"parent": ["in", nomes]},
				fields=["parent", "idx", "descricao", "contar_por", "categoria", "regime",
					"quantidade", "valor", "artigo", "valido_de", "valido_ate"],
				order_by="parent, idx"):
			out.setdefault((tipo, r.parent), {})[r.idx] = r
	return out


def adicional_por_ref(tabelas, ref, contrato, cliente):
	"""The row a billing line points at: ref 'P3' = contract row 3, 'C3' = customer row 3."""
	tipo, idx = (ref or " ")[:1], cint((ref or "")[1:])
	return (tabelas.get((tipo, contrato if tipo == "P" else cliente)) or {}).get(idx)


def adicionais_do_contrato(tabelas, contrato, cliente, mes):
	"""[(ref, row)] billed for a contract in the month: its own rows, else the
	customer's; rows outside Válido De / Até are left out."""
	tipo, linhas = "P", tabelas.get(("P", contrato))
	if not linhas:
		tipo, linhas = "C", tabelas.get(("C", cliente)) or {}
	ini, fim = get_first_day(getdate(mes)), get_last_day(getdate(mes))
	return [(f"{tipo}{idx}", r) for idx, r in sorted(linhas.items())
		if (not r.valido_de or getdate(r.valido_de) <= fim)
		and (not r.valido_ate or getdate(r.valido_ate) >= ini)]


# ─── Billing unit: per service or per guard (chosen in the billing profile) ──────

def vigilantes_por_servico_regimes():
	"""{regime: guards per billed service} from the Regime (default 1)."""
	if not frappe.db.has_column("Regime", "vigilantes_por_servico"):
		return {}
	return {r.name: cint(r.vigilantes_por_servico) or 1
		for r in frappe.get_all("Regime", fields=["name", "vigilantes_por_servico"])}


def servicos(vigilantes, perfil, regime, por_regime):
	"""Billed quantity for `vigilantes` guards of one posto in `regime`. Per guard:
	the guard count. Per service: guards ÷ guards-per-service (the profile's
	exception for the regime, else the Regime's), rounded UP — a short-staffed posto
	still bills its whole service."""
	from sigos.perfil_faturacao import FATURAR_SERVICO, vigilantes_por_servico
	vigilantes = cint(vigilantes)
	if perfil.faturar_por != FATURAR_SERVICO or vigilantes <= 0:
		return vigilantes
	return -(-vigilantes // vigilantes_por_servico(perfil, regime, por_regime))


@frappe.whitelist()
def get_tarifas_cliente(customer):
	"""Contract form: the customer's rates, to show live totals for rows without a
	price. {"<regime>|<categoria>": valor} ('<regime>|' = any categoria)."""
	if not customer:
		return {}
	frappe.has_permission("Customer", "read", customer, throw=True)
	return {f"{regime}|{cat}": flt(r.valor)
		for (_c, regime, cat), r in tarifas_dos_clientes([customer]).items()}
