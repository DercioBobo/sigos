import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, getdate, get_first_day, get_last_day, formatdate, nowdate


class FaturacaoMensal(Document):

	# ─── Preview: count per (contract, regime) x contract tariff ─────────────────

	@frappe.whitelist()
	def preview(self):
		"""
		Build the billing lines per contract (Project) + regime. Each contract is
		counted with its own método de faturação (Project.custom_metodo_faturacao,
		'Predefinido' -> SIGOS Settings default):
		  - Vigilantes Activos: Activo guards of the contract right now.
		  - Contratual: the Nº de Vigilantes typed in the contract's Finance table.
		The rate always comes from the contract's Finance table (Faturação por Regime).
		Cliente is derived from the Project so it is always authoritative.
		posto_interno / project-less guards are not billable.
		"""
		frappe.only_for(("System Manager", "SIGOS Manager", "Accounts Manager"))
		self.set("linhas", [])

		filtros = {"customer": ["is", "set"]}
		if self.cliente:
			filtros["customer"] = self.cliente
		contratos = frappe.get_all(
			"Project", filters=filtros,
			fields=["name", "customer", "status", "custom_metodo_faturacao"],
		)
		padrao = frappe.db.get_single_value("SIGOS Settings", "metodo_faturacao_padrao") 			or "Vigilantes Activos"
		metodo = {
			c.name: (c.custom_metodo_faturacao
				if c.custom_metodo_faturacao not in (None, "", "Predefinido") else padrao)
			for c in contratos
		}
		cliente_de = {c.name: c.customer for c in contratos}

		# Contracted qty + rate per (contract, regime), from the Finance table.
		contratado = {}
		if contratos:
			for f in frappe.get_all(
				"Project Faturacao Regime",
				filters={"parenttype": "Project", "parent": ["in", list(metodo)]},
				fields=["parent", "regime", "quantidade", "valor"],
				order_by="parent, idx",
			):
				contratado[(f.parent, f.regime)] = f

		linhas = []

		# ── Vigilantes Activos ──
		# ALL active guards with a contract+regime — permanent AND temporary postos
		# alike, grouped on posto type so temporary deployments show as their own,
		# clearly-labelled, auditable lines.
		# Active Cobridor shadows are excluded: they co-locate with the colleague
		# they're covering (both Activo, same posto/regime) — billing only the
		# covered guard's own row avoids double-charging the customer for one slot.
		activos_contratos = [p for p, m in metodo.items() if m == "Vigilantes Activos"]
		vistos = set()
		if activos_contratos:
			rows = frappe.db.sql("""
				SELECT v.projecto AS project, v.regime_do_vigilante AS regime,
				       COALESCE(pv.tipo_de_posto, 'Permanente') AS tipo_posto,
				       COUNT(*) AS qtd
				FROM `tabVigilante` v
				LEFT JOIN `tabPosto De Vigilancia` pv ON pv.name = v.posto_de_vigilancia
				WHERE v.status = 'Activo'
				  AND v.projecto IN %(projectos)s
				  AND v.regime_do_vigilante IS NOT NULL AND v.regime_do_vigilante != ''
				  AND (v.cobertura_de_posto_activa IS NULL OR v.cobertura_de_posto_activa = '')
				GROUP BY v.projecto, v.regime_do_vigilante, COALESCE(pv.tipo_de_posto, 'Permanente')
			""", {"projectos": tuple(activos_contratos)}, as_dict=True)
			for r in rows:
				c = contratado.get((r.project, r.regime))
				linhas.append(dict(
					project=r.project, regime=r.regime, tipo_posto=r.tipo_posto,
					metodo="Vigilantes Activos", quantidade=r.qtd,
					quantidade_contratada=c.quantidade if c else 0,
					valor_unitario=c.valor if c else 0,
				))
				vistos.add((r.project, r.regime))
			# Contracted regimes with nobody active: a 0-qty line so the shortfall is
			# visible in the preview (never invoiced — gerar_faturas skips qty 0).
			for (proj, regime), c in contratado.items():
				if metodo.get(proj) == "Vigilantes Activos" and (proj, regime) not in vistos 						and c.quantidade and cliente_de.get(proj):
					st = next((x.status for x in contratos if x.name == proj), None)
					if st in ("Completed", "Cancelled"):
						continue
					linhas.append(dict(
						project=proj, regime=regime, tipo_posto="", metodo="Vigilantes Activos",
						quantidade=0, quantidade_contratada=c.quantidade, valor_unitario=c.valor,
					))

		# ── Contratual ── open contracts only; qty straight from the Finance table.
		abertos = {c.name for c in contratos if c.status not in ("Completed", "Cancelled")}
		for (proj, regime), c in contratado.items():
			if metodo.get(proj) != "Contratual" or proj not in abertos or not c.quantidade:
				continue
			linhas.append(dict(
				project=proj, regime=regime, tipo_posto="", metodo="Contratual",
				quantidade=c.quantidade, quantidade_contratada=c.quantidade,
				valor_unitario=c.valor,
			))

		linhas.sort(key=lambda l: (cliente_de.get(l["project"]) or "", l["project"],
			l["regime"], l["tipo_posto"]))

		total_geral = 0
		total_vig = 0
		sem_tarifa = []
		for l in linhas:
			l["cliente"] = cliente_de.get(l["project"])
			l["valor_unitario"] = flt(l["valor_unitario"])
			l["total"] = (l["quantidade"] or 0) * l["valor_unitario"]
			if l["quantidade"] and not l["valor_unitario"]:
				sem_tarifa.append(f"{l['cliente'] or '?'} / {l['project']} / {l['regime']}")
			self.append("linhas", l)
			total_geral += l["total"]
			total_vig += (l["quantidade"] or 0)

		self.total_geral = total_geral
		self.total_vigilantes = total_vig
		self.save(ignore_permissions=True)

		# Vigilantes Activos is a count of TODAY's headcount — say so when billing a
		# month that has already closed.
		if activos_contratos and self.mes_referencia 				and get_last_day(getdate(self.mes_referencia)) < getdate(nowdate()):
			frappe.msgprint(
				_("Os contratos em <b>Vigilantes Activos</b> foram contados com o efectivo "
				  "<b>de hoje</b>, não o de {0}. Confirme as quantidades antes de gerar.").format(
					formatdate(self.mes_referencia, "MMMM yyyy")),
				title=_("Mês Já Encerrado"),
				indicator="orange",
			)

		ja = _clientes_ja_faturados(self.company, self.mes_referencia, {l["cliente"] for l in linhas})
		if ja:
			frappe.msgprint(
				_("Estes clientes já têm factura de {0} e serão <b>ignorados</b> ao gerar:<br>{1}").format(
					formatdate(self.mes_referencia, "MMMM yyyy"), _fmt_ja_faturados(ja)),
				title=_("Já Facturados"),
				indicator="orange",
			)

		if sem_tarifa:
			frappe.msgprint(
				_("Sem tarifa definida (valor 0) para: <br>{0}<br><br>"
				  "Defina a <b>Faturação por Regime</b> no contrato (Projecto).").format(
					"<br>".join(sem_tarifa)),
				title=_("Tarifas em Falta"),
				indicator="orange",
			)

		return {"linhas": len(self.linhas), "total": total_geral, "vigilantes": total_vig}

	# ─── Generate: one DRAFT Sales Invoice per customer ──────────────────────────

	@frappe.whitelist()
	def gerar_faturas(self):
		# Money-generating action (real draft Sales Invoices via ignore_permissions=True
		# below) — gate on role explicitly rather than relying on whatever incidental
		# read/write access this doctype happens to grant.
		frappe.only_for(("System Manager", "SIGOS Manager", "Accounts Manager"))
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
		if not self.mes_referencia:
			frappe.throw(_("Defina o <b>Mês de Referência</b>."))

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

		# Double-billing guard: a customer already invoiced for this month (by ANY
		# run — e.g. a per-customer run followed by an all-customers run) is skipped.
		# Drafts count too; cancelled ones don't, so cancel (or delete a draft) to re-bill.
		ja = _clientes_ja_faturados(self.company, self.mes_referencia, set(por_cliente))
		for cliente in ja:
			por_cliente.pop(cliente, None)
		if not por_cliente:
			frappe.throw(
				_("Todos os clientes desta execução já foram facturados em {0}:<br>{1}<br><br>"
				  "Para refacturar, cancele (ou apague, se ainda em rascunho) a factura existente.").format(
					mes_label, _fmt_ja_faturados(ja)),
				title=_("Já Facturados"),
			)

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
		if ja:
			frappe.msgprint(
				_("Ignorados por já estarem facturados em {0}:<br>{1}").format(
					mes_label, _fmt_ja_faturados(ja)),
				title=_("Clientes Ignorados"),
				indicator="orange",
			)
		return {"faturas": criadas}


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _clientes_ja_faturados(company, mes_referencia, clientes):
	"""
	{cliente: [Sales Invoice]} for customers that already have a non-cancelled
	invoice generated by a Faturacao Mensal run for the same company + month.
	Manual Sales Invoices (no custom_faturacao_mensal) are not counted.
	"""
	clientes = [c for c in clientes if c]
	if not (company and mes_referencia and clientes):
		return {}
	mes = getdate(mes_referencia)
	rows = frappe.get_all(
		"Sales Invoice",
		filters={
			"company": company,
			"customer": ["in", clientes],
			"docstatus": ["<", 2],
			"custom_faturacao_mensal": ["is", "set"],
			"posting_date": ["between", [get_first_day(mes), get_last_day(mes)]],
		},
		fields=["name", "customer"],
		order_by="name",
	)
	out = {}
	for r in rows:
		out.setdefault(r.customer, []).append(r.name)
	return out


def _fmt_ja_faturados(ja):
	return "<br>".join(
		f"{frappe.bold(cli)}: {', '.join(nomes)}" for cli, nomes in sorted(ja.items()))


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
