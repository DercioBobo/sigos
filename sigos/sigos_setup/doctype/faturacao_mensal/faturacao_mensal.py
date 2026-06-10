import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate, get_last_day, formatdate

from sigos.api import get_regime_rate


class FaturacaoMensal(Document):

	# ─── Preview: snapshot of active headcount per (contract, regime) ─────────────

	@frappe.whitelist()
	def preview(self):
		"""
		Snapshot every Activo vigilante grouped by contract (Project) + regime, priced
		with the contract's per-regime tariff. Cliente is derived from the Project so it
		is always authoritative. posto_interno / project-less guards are not billable.
		"""
		self.set("linhas", [])

		cond = ""
		params = {}
		if self.cliente:
			cond = "AND p.customer = %(cliente)s"
			params["cliente"] = self.cliente

		# Snapshot ALL active guards with a contract+regime — permanent AND temporary
		# postos alike (no posto-type filter). We also group on posto type so temporary
		# deployments show as their own, clearly-labelled, auditable lines.
		rows = frappe.db.sql(f"""
			SELECT v.projecto AS project, p.customer AS cliente,
			       v.regime_do_vigilante AS regime,
			       COALESCE(pv.tipo_de_posto, 'Permanente') AS tipo_posto,
			       COUNT(*) AS qtd
			FROM `tabVigilante` v
			JOIN `tabProject` p ON p.name = v.projecto
			LEFT JOIN `tabPosto De Vigilancia` pv ON pv.name = v.posto_de_vigilancia
			WHERE v.status = 'Activo'
			  AND v.regime_do_vigilante IS NOT NULL AND v.regime_do_vigilante != ''
			  {cond}
			GROUP BY v.projecto, p.customer, v.regime_do_vigilante, COALESCE(pv.tipo_de_posto, 'Permanente')
			ORDER BY p.customer, v.projecto, v.regime_do_vigilante, tipo_posto
		""", params, as_dict=True)

		total_geral = 0
		total_vig = 0
		sem_tarifa = []
		for r in rows:
			rate = get_regime_rate(r.project, r.regime) or 0
			total = (r.qtd or 0) * rate
			if not rate:
				sem_tarifa.append(f"{r.cliente or '?'} / {r.project} / {r.regime}")
			self.append("linhas", {
				"cliente": r.cliente,
				"project": r.project,
				"regime": r.regime,
				"tipo_posto": r.tipo_posto,
				"quantidade": r.qtd,
				"valor_unitario": rate,
				"total": total,
			})
			total_geral += total
			total_vig += (r.qtd or 0)

		self.total_geral = total_geral
		self.total_vigilantes = total_vig
		self.save(ignore_permissions=True)

		if sem_tarifa:
			frappe.msgprint(
				_("Sem tarifa definida (valor 0) para: <br>{0}<br><br>"
				  "Defina as <b>Tarifas por Regime</b> no contrato (Projecto).").format(
					"<br>".join(sem_tarifa)),
				title=_("Tarifas em Falta"),
				indicator="orange",
			)

		return {"linhas": len(self.linhas), "total": total_geral, "vigilantes": total_vig}

	# ─── Generate: one DRAFT Sales Invoice per customer ──────────────────────────

	@frappe.whitelist()
	def gerar_faturas(self):
		if self.faturas_geradas:
			frappe.throw(
				_("Esta execução já gerou facturas (<b>{0}</b>). Crie uma nova execução "
				  "de Faturação para refacturar.").format(self.faturas_geradas),
				title=_("Facturas Já Geradas"),
			)
		if not self.linhas:
			frappe.throw(_("Pré-visualize primeiro — não há linhas para facturar."))
		if not self.company:
			frappe.throw(_("Defina a <b>Empresa</b>."))

		posting = get_last_day(getdate(self.mes_referencia))
		mes_label = formatdate(self.mes_referencia, "MMMM yyyy")

		# Group the preview lines by customer
		por_cliente = {}
		for ln in self.linhas:
			if not (ln.cliente and ln.quantidade and ln.valor_unitario):
				continue
			por_cliente.setdefault(ln.cliente, []).append(ln)

		if not por_cliente:
			frappe.throw(_("Nenhuma linha facturável (cliente, quantidade e tarifa em falta)."))

		criadas = []
		for cliente, lns in por_cliente.items():
			si = frappe.new_doc("Sales Invoice")
			si.customer = cliente
			si.company = self.company
			si.set_posting_time = 1
			si.posting_date = posting
			si.due_date = posting
			si.custom_faturacao_mensal = self.name

			total_vig = 0
			for ln in lns:
				item_code = _item_para_regime(ln.regime)
				proj_nome = frappe.db.get_value("Project", ln.project, "project_name") or ln.project
				tipo = f" [{ln.tipo_posto}]" if ln.tipo_posto == "Temporário" else ""
				si.append("items", {
					"item_code": item_code,
					"qty": ln.quantidade,
					"rate": ln.valor_unitario,
					"description": f"{ln.regime}{tipo} — {proj_nome} ({mes_label})",
					"project": ln.project,
				})
				total_vig += ln.quantidade

			if hasattr(si, "custom_total_vigilantes"):
				si.custom_total_vigilantes = total_vig

			si.insert(ignore_permissions=True)   # left as DRAFT for review
			criadas.append(si.name)

		self.faturas_geradas = ", ".join(criadas)
		self.save(ignore_permissions=True)

		frappe.msgprint(
			_("<b>{0}</b> factura(s) criada(s) em rascunho.").format(len(criadas)),
			indicator="green",
			alert=True,
		)
		return {"faturas": criadas}


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _item_para_regime(regime):
	"""Get or create a non-stock service Item for a regime (e.g. 'Vigilância H24')."""
	code = f"VIG-{regime}"
	if frappe.db.exists("Item", code):
		return code

	grupo = "Services" if frappe.db.exists("Item Group", "Services") \
		else frappe.db.get_value("Item Group", {"is_group": 0}, "name")
	uom = "Nos" if frappe.db.exists("UOM", "Nos") else frappe.db.get_value("UOM", {}, "name")

	item = frappe.get_doc({
		"doctype": "Item",
		"item_code": code,
		"item_name": f"Vigilância {regime}",
		"item_group": grupo,
		"stock_uom": uom,
		"is_stock_item": 0,
		"is_sales_item": 1,
		"is_purchase_item": 0,
		"include_item_in_manufacturing": 0,
		"description": f"Serviço de vigilância — regime {regime} (por vigilante/mês).",
	})
	item.flags.ignore_permissions = True
	item.insert()
	return code
