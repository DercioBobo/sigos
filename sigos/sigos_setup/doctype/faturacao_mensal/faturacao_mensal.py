import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, cstr, flt, getdate, get_first_day, get_last_day, formatdate, nowdate, strip_html


class FaturacaoMensal(Document):

	# ─── Preview: count per (contract, regime) x contract tariff ─────────────────

	@frappe.whitelist()
	def preview(self):
		"""Compute the billing lines (see calcular_linhas) and store them on this run."""
		frappe.only_for(PAPEIS_FATURACAO)
		self.set("linhas", [])

		linhas, activos_contratos = calcular_linhas(self.cliente)

		total_geral = 0
		total_vig = 0
		sem_tarifa = []
		for l in linhas:
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
		if (activos_contratos and self.mes_referencia
				and get_last_day(getdate(self.mes_referencia)) < getdate(nowdate())):
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
	def verificar(self):
		"""
		Pre-flight for Gerar Faturas: everything that would make Sales Invoice creation
		(or its later submission) fail, reported up front in one list.
		  erros    -> block the whole run (company/accounting setup, stale preview)
		  clientes -> {cliente: [problemas]} — that customer is skipped, others proceed
		  avisos   -> won't stop the draft, but may stop the submit (or omit IVA)
		"""
		frappe.only_for(PAPEIS_FATURACAO)
		return _verificar(self)

	@frappe.whitelist()
	def gerar_faturas(self):
		# Money-generating action (real draft Sales Invoices via ignore_permissions=True
		# in _gerar) — gate on role explicitly rather than relying on whatever incidental
		# read/write access this doctype happens to grant.
		frappe.only_for(PAPEIS_FATURACAO)

		r = self._gerar()
		if r["erros"]:
			frappe.throw(
				_("Corrija primeiro:<br>{0}").format("<br>".join(f"• {e}" for e in r["erros"])),
				title=_("Verificação Falhou"),
			)

		mes_label = formatdate(self.mes_referencia, "MMMM yyyy")
		ja, problemas, falhas = r["ja"], r["problemas"], r["falhas"]
		if not (r["criadas"] or falhas):
			msg = []
			if ja:
				msg.append(_("Já facturados em {0}:<br>{1}").format(mes_label, _fmt_ja_faturados(ja)))
			if problemas:
				msg.append(_("Com problemas:<br>{0}").format(_fmt_problemas(problemas)))
			frappe.throw("<br><br>".join(msg) or _("Nada a facturar."), title=_("Nada a Facturar"))

		if r["criadas"]:
			frappe.msgprint(
				_("<b>{0}</b> factura(s) criada(s) em rascunho.").format(len(r["criadas"])),
				indicator="green",
				alert=True,
			)

		ignorados = []
		if ja:
			ignorados.append(_("Já facturados em {0}:<br>{1}").format(mes_label, _fmt_ja_faturados(ja)))
		if problemas:
			ignorados.append(_("Problemas de configuração:<br>{0}").format(_fmt_problemas(problemas)))
		if falhas:
			ignorados.append(_("Falharam ao criar a factura:<br>{0}").format(_fmt_problemas(falhas)))
		if ignorados:
			frappe.msgprint(
				"<br><br>".join(ignorados),
				title=_("Clientes Não Facturados"),
				indicator="red" if falhas else "orange",
			)
		return {"faturas": r["criadas"], "falhas": list(falhas)}

	def _gerar(self, submeter=False):
		"""
		Create the run's Sales Invoices without raising — shared by Gerar Faturas (UI)
		and the automatic billing job (sigos.faturacao). Returns what happened:
		  erros          blocking pre-flight errors (nothing was created)
		  ja             {cliente: [SI]} already invoiced this month -> skipped
		  problemas      {cliente: [motivo]} pre-flight customer problems -> skipped
		  falhas         {cliente: [motivo]} invoice insert failed (rolled back)
		  criadas        [SI] created (draft, or submitted — see below)
		  submetidas     [SI] also submitted (submeter=True only)
		  nao_submetidas {cliente: [motivo]} created but the submit failed -> kept as draft
		"""
		res = dict(erros=[], ja={}, problemas={}, falhas={}, criadas=[], submetidas=[],
			nao_submetidas={})
		v = _verificar(self)
		res["erros"], res["problemas"] = v["erros"], v["clientes"]
		if v["erros"]:
			return res

		posting = get_last_day(getdate(self.mes_referencia))
		mes_label = formatdate(self.mes_referencia, "MMMM yyyy")

		por_cliente = _linhas_por_cliente(self)

		# Double-billing guard: a customer already invoiced for this month (by ANY
		# run — e.g. a per-customer run followed by an all-customers run, or an earlier
		# pass of THIS run) is skipped. Drafts count too; cancelled ones don't, so
		# cancel (or delete a draft) to re-bill.
		ja = _clientes_ja_faturados(self.company, self.mes_referencia, set(por_cliente))
		res["ja"] = ja
		for cliente in list(ja) + list(v["clientes"]):
			por_cliente.pop(cliente, None)
		if not por_cliente:
			return res

		# Items first, once per regime (outside the per-customer savepoints).
		itens = {ln.regime: _item_para_regime(ln.regime)
			for lns in por_cliente.values() for ln in lns}
		proj_nomes = {ln.project: frappe.db.get_value("Project", ln.project, "project_name") or ln.project
			for lns in por_cliente.values() for ln in lns}

		# One savepoint per customer: a failure rolls back only that customer's
		# invoice, the others are kept and the failure is reported with its reason.
		for i, (cliente, lns) in enumerate(sorted(por_cliente.items())):
			sp = f"sigos_fat_{i}"
			n_msgs = len(frappe.local.message_log)
			frappe.db.savepoint(sp)
			try:
				si = frappe.new_doc("Sales Invoice")
				si.customer = cliente
				si.company = self.company
				si.set_posting_time = 1
				si.posting_date = posting
				si.due_date = posting
				si.ignore_pricing_rule = 1   # the contract rate is final — no Pricing Rule may alter it
				si.custom_faturacao_mensal = self.name
				si.custom_mes_referencia = get_first_day(getdate(self.mes_referencia))

				total_vig = 0
				for ln in lns:
					texto = ln.descricao or "{0}{1} — {2}".format(
						ln.regime, " [Temporário]" if ln.tipo_posto == "Temporário" else "",
						proj_nomes[ln.project])
					si.append("items", {
						"item_code": itens[ln.regime],
						"qty": ln.quantidade,
						"rate": ln.valor_unitario,
						"description": f"{texto} ({mes_label})",
						"project": ln.project,
					})
					total_vig += ln.quantidade

				if si.meta.has_field("custom_total_vigilantes"):
					si.custom_total_vigilantes = total_vig

				si.insert(ignore_permissions=True)   # DRAFT for review, unless submeter
				res["criadas"].append(si.name)
			except Exception as e:
				frappe.db.rollback(save_point=sp)
				# drop the failed insert's popups; the reason is reported instead
				del frappe.local.message_log[n_msgs:]
				res["falhas"][cliente] = [strip_html(cstr(e)) or e.__class__.__name__]
				frappe.log_error(title=f"Faturacao Mensal {self.name}: {cliente}")
				continue

			if submeter:
				# A failed submit (credit limit, mandatory dimension, ...) keeps the
				# draft — it is still the month's invoice, just waiting for a human.
				sp_sub = f"{sp}_sub"
				n_msgs = len(frappe.local.message_log)
				frappe.db.savepoint(sp_sub)
				try:
					si.flags.ignore_permissions = True
					si.submit()
					res["submetidas"].append(si.name)
				except Exception as e:
					frappe.db.rollback(save_point=sp_sub)
					del frappe.local.message_log[n_msgs:]
					res["nao_submetidas"][cliente] = [strip_html(cstr(e)) or e.__class__.__name__]

		if res["criadas"]:
			anteriores = [f.strip() for f in (self.faturas_geradas or "").split(",") if f.strip()]
			self.faturas_geradas = ", ".join(anteriores + res["criadas"])
			self.save(ignore_permissions=True)
		return res


def calcular_linhas(cliente=None):
	"""
	Billing lines per contract (Project) + regime — shared by the Faturacao Mensal
	preview and the Sales Invoice 'Contratos SIGOS' fetch. Each contract is counted
	with its own método de faturação (Project.custom_metodo_faturacao,
	'Predefinido' -> SIGOS Settings default):
	  - Vigilantes Activos: Activo guards of the contract right now.
	  - Contratual: the Nº de Vigilantes typed in the contract's Finance table.
	The rate always comes from the contract's Finance table (Faturação por Regime).
	Cliente is derived from the Project so it is always authoritative.
	posto_interno / project-less guards are not billable.
	Returns (linhas, activos_contratos); each linha has cliente/total filled in.
	"""
	filtros = {"customer": ["is", "set"]}
	if cliente:
		filtros["customer"] = cliente
	contratos = frappe.get_all(
		"Project", filters=filtros,
		fields=["name", "project_name", "customer", "status", "custom_metodo_faturacao"],
	)
	padrao = (frappe.db.get_single_value("SIGOS Settings", "metodo_faturacao_padrao")
		or "Vigilantes Activos")
	metodo = {
		c.name: (c.custom_metodo_faturacao
			if c.custom_metodo_faturacao not in (None, "", "Predefinido") else padrao)
		for c in contratos
	}
	cliente_de = {c.name: c.customer for c in contratos}
	proj_nome = {c.name: c.project_name or c.name for c in contratos}
	estado_de = {c.name: c.status for c in contratos}
	detalhe = _detalhe_por_cliente(set(cliente_de.values()))

	def por_posto(proj):
		return detalhe.get(cliente_de.get(proj)) == "Por Posto"

	# Contracted qty + rate + invoice text per (contract, regime), from the Finance table.
	contratado = {}
	if contratos:
		for f in frappe.get_all(
			"Project Faturacao Regime",
			filters={"parenttype": "Project", "parent": ["in", list(metodo)]},
			fields=["parent", "regime", "quantidade", "valor", "descricao"],
			order_by="parent, idx",
		):
			contratado[(f.parent, f.regime)] = f

	def texto(proj, regime, alvo=None, tipo_posto=None):
		"""
		Invoice line text (the month is appended at generation). The contract's
		'Descrição na Factura' replaces the regime label when set:
		  Por Contrato: '<descrição>'  or  '<regime> — <contrato>'
		  Por Posto:    '<descrição or regime> — <nome financeiro / lista de postos>'
		"""
		c = contratado.get((proj, regime))
		base = ((c.descricao if c else "") or "").strip()
		if alvo:
			t = f"{base or regime} — {alvo}"
		else:
			t = base or f"{regime} — {proj_nome.get(proj, proj)}"
		if tipo_posto == "Temporário":
			t += " [Temporário]"
		return t

	linhas = []

	# ── Vigilantes Activos ──
	# ALL active guards with a contract+regime — permanent AND temporary postos
	# alike, grouped on posto type so temporary deployments show as their own,
	# clearly-labelled, auditable lines (and on the posto itself for customers
	# invoiced Por Posto).
	# Active Cobridor shadows are excluded: they co-locate with the colleague
	# they're covering (both Activo, same posto/regime) — billing only the
	# covered guard's own row avoids double-charging the customer for one slot.
	activos_contratos = [p for p, m in metodo.items() if m == "Vigilantes Activos"]
	vistos = set()
	if activos_contratos:
		rows = frappe.db.sql("""
			SELECT v.projecto AS project, v.regime_do_vigilante AS regime,
			       COALESCE(pv.tipo_de_posto, 'Permanente') AS tipo_posto,
			       v.posto_de_vigilancia AS posto,
			       COALESCE(NULLIF(pv.nome_financeiro, ''), pv.nome_do_posto) AS nome_posto,
			       COUNT(*) AS qtd
			FROM `tabVigilante` v
			LEFT JOIN `tabPosto De Vigilancia` pv ON pv.name = v.posto_de_vigilancia
			WHERE v.status = 'Activo'
			  AND v.projecto IN %(projectos)s
			  AND v.regime_do_vigilante IS NOT NULL AND v.regime_do_vigilante != ''
			  AND (v.cobertura_de_posto_activa IS NULL OR v.cobertura_de_posto_activa = '')
			GROUP BY v.projecto, v.regime_do_vigilante, COALESCE(pv.tipo_de_posto, 'Permanente'),
			         v.posto_de_vigilancia
		""", {"projectos": tuple(activos_contratos)}, as_dict=True)

		agrupado = {}
		for r in rows:
			posto = r.posto if por_posto(r.project) else None
			k = (r.project, r.regime, r.tipo_posto, posto)
			if k not in agrupado:
				c = contratado.get((r.project, r.regime))
				agrupado[k] = dict(
					project=r.project, regime=r.regime, tipo_posto=r.tipo_posto, posto=posto,
					descricao=texto(r.project, r.regime, r.nome_posto if posto else None, r.tipo_posto),
					metodo="Vigilantes Activos", quantidade=0,
					quantidade_contratada=c.quantidade if c else 0,
					valor_unitario=c.valor if c else 0,
				)
			agrupado[k]["quantidade"] += r.qtd
			vistos.add((r.project, r.regime))
		linhas.extend(agrupado.values())

		# Contracted regimes with nobody active: a 0-qty line so the shortfall is
		# visible in the preview (never invoiced — gerar_faturas skips qty 0).
		for (proj, regime), c in contratado.items():
			if (metodo.get(proj) == "Vigilantes Activos" and (proj, regime) not in vistos
					and c.quantidade and cliente_de.get(proj)
					and estado_de.get(proj) not in ("Completed", "Cancelled")):
				linhas.append(dict(
					project=proj, regime=regime, tipo_posto="", posto=None,
					descricao=texto(proj, regime), metodo="Vigilantes Activos",
					quantidade=0, quantidade_contratada=c.quantidade, valor_unitario=c.valor,
				))

	# ── Contratual ── open contracts only; qty straight from the Finance table.
	# The contracted qty is per regime, not per posto, so Por Posto customers get
	# one line per regime listing the contract's active postos by nome financeiro.
	contratuais = [p for p, m in metodo.items()
		if m == "Contratual" and estado_de.get(p) not in ("Completed", "Cancelled")]
	postos_de = {}
	if any(por_posto(p) for p in contratuais):
		for pv in frappe.get_all(
			"Posto De Vigilancia",
			filters={"project": ["in", contratuais], "estado": "Activo", "posto_interno": 0},
			fields=["project", "nome_financeiro", "nome_do_posto"],
			order_by="nome_financeiro, nome_do_posto",
		):
			postos_de.setdefault(pv.project, []).append(pv.nome_financeiro or pv.nome_do_posto)
	for (proj, regime), c in contratado.items():
		if proj not in contratuais or not c.quantidade:
			continue
		alvo = None
		if por_posto(proj) and postos_de.get(proj):
			alvo = _("Postos: {0}").format(", ".join(postos_de[proj]))
		linhas.append(dict(
			project=proj, regime=regime, tipo_posto="", posto=None,
			descricao=texto(proj, regime, alvo), metodo="Contratual",
			quantidade=c.quantidade, quantidade_contratada=c.quantidade,
			valor_unitario=c.valor,
		))

	linhas.sort(key=lambda l: (cliente_de.get(l["project"]) or "", l["project"],
		l["regime"], l["tipo_posto"] or "", l["descricao"] or ""))
	for l in linhas:
		l["cliente"] = cliente_de.get(l["project"])
		l["valor_unitario"] = flt(l["valor_unitario"])
		l["total"] = (l["quantidade"] or 0) * l["valor_unitario"]
	return linhas, activos_contratos


PAPEIS_FATURACAO = ("System Manager", "SIGOS Manager", "Accounts Manager")
ITEM_GROUP_FATURACAO = "Services"
UOM_FATURACAO = "Unit"


# ─── Pre-flight ──────────────────────────────────────────────────────────────

def _linhas_por_cliente(doc):
	por_cliente = {}
	for ln in doc.linhas:
		if ln.cliente and ln.quantidade and ln.valor_unitario:
			por_cliente.setdefault(ln.cliente, []).append(ln)
	return por_cliente


def _verificar(doc):
	erros, avisos, clientes = [], [], {}

	if not doc.company:
		erros.append(_("Defina a <b>Empresa</b>."))
	if not doc.mes_referencia:
		erros.append(_("Defina o <b>Mês de Referência</b>."))
	if not doc.linhas:
		erros.append(_("Pré-visualize primeiro — não há linhas para facturar."))
	if erros:
		return {"erros": erros, "avisos": avisos, "clientes": clientes}

	por_cliente = _linhas_por_cliente(doc)
	if not por_cliente:
		erros.append(_("Nenhuma linha facturável (cliente, quantidade e tarifa em falta)."))
		return {"erros": erros, "avisos": avisos, "clientes": clientes}

	company = doc.company
	posting = get_last_day(getdate(doc.mes_referencia))
	comp = frappe.db.get_value("Company", company,
		["default_currency", "default_income_account", "cost_center"], as_dict=True) or frappe._dict()

	# ── Stale preview: the lines must still match the contracts ──
	desactualizadas = []
	contratado = {}
	projectos = list({ln.project for ln in doc.linhas if ln.project})
	if projectos:
		for f in frappe.get_all("Project Faturacao Regime",
				filters={"parenttype": "Project", "parent": ["in", projectos]},
				fields=["parent", "regime", "quantidade", "valor"]):
			contratado[(f.parent, f.regime)] = f
	cliente_actual = {p.name: p.customer for p in frappe.get_all("Project",
		filters={"name": ["in", projectos or [""]]}, fields=["name", "customer"])}
	for ln in doc.linhas:
		if not ln.quantidade:
			continue
		c = contratado.get((ln.project, ln.regime))
		mudou = (
			not c
			or flt(c.valor) != flt(ln.valor_unitario)
			or cliente_actual.get(ln.project) != ln.cliente
			or (ln.metodo == "Contratual" and cint(c.quantidade) != cint(ln.quantidade))
		)
		if mudou:
			desactualizadas.append(f"{ln.project} / {ln.regime}")
	if desactualizadas:
		erros.append(_("O contrato mudou desde a pré-visualização ({0}). Clique em "
			"<b>Pré-visualizar</b> novamente.").format(", ".join(sorted(set(desactualizadas)))))

	# ── Accounting setup (company-wide) ──
	try:
		from erpnext.accounts.utils import get_fiscal_year
		get_fiscal_year(posting, company=company)
	except Exception:
		erros.append(_("Não existe <b>Ano Fiscal</b> para {0} na empresa {1}.").format(
			formatdate(posting), company))

	if not comp.cost_center:
		erros.append(_("A empresa {0} não tem <b>Centro de Custo</b> predefinido.").format(company))

	try:
		fechado = frappe.db.sql("""
			SELECT ap.name FROM `tabAccounting Period` ap
			JOIN `tabClosed Document` cd ON cd.parent = ap.name
			WHERE ap.company = %s AND %s BETWEEN ap.start_date AND ap.end_date
			  AND cd.document_type = 'Sales Invoice' AND cd.closed = 1
			LIMIT 1
		""", (company, posting))
		if fechado:
			erros.append(_("O período contabilístico <b>{0}</b> está fechado para Sales Invoice.").format(
				fechado[0][0]))
	except Exception:
		pass

	# ── Items (one per regime) ──
	for regime in sorted({ln.regime for lns in por_cliente.values() for ln in lns}):
		code = f"VIG-{regime}"
		item = frappe.db.get_value("Item", code, ["disabled", "is_sales_item", "item_group"], as_dict=True)
		if item:
			if item.disabled or not item.is_sales_item:
				erros.append(_("O artigo <b>{0}</b> está desactivado ou não é de venda.").format(code))
			grupo = item.item_group
		else:
			grupo = ITEM_GROUP_FATURACAO
			if not frappe.db.exists("Item Group", {"name": ITEM_GROUP_FATURACAO, "is_group": 0}):
				erros.append(_("Falta o Grupo de Artigos <b>{0}</b> (não-grupo) para criar {1}.").format(
					ITEM_GROUP_FATURACAO, code))
			if not frappe.db.exists("UOM", {"name": UOM_FATURACAO, "enabled": 1}):
				erros.append(_("Falta a Unidade de Medida <b>{0}</b> para criar {1}.").format(UOM_FATURACAO, code))
		if not (comp.default_income_account or _conta_receita_definida(code, grupo, company)):
			erros.append(_("Sem <b>Conta de Receita</b> para {0}: defina a conta de receita "
				"predefinida da empresa {1} (ou no artigo/grupo).").format(code, company))

	# ── Customers ──
	for cliente, lns in sorted(por_cliente.items()):
		probs = []
		cust = frappe.db.get_value("Customer", cliente,
			["disabled", "is_frozen", "default_currency"], as_dict=True)
		if not cust:
			clientes[cliente] = [_("cliente não existe")]
			continue
		if cust.disabled:
			probs.append(_("cliente desactivado"))
		if cust.is_frozen:
			probs.append(_("cliente congelado"))
		try:
			from erpnext.accounts.party import get_party_account
			if not get_party_account("Customer", cliente, company):
				raise ValueError
		except Exception:
			probs.append(_("sem Conta a Receber (defina no cliente ou a predefinida da empresa)"))
		if probs:
			clientes[cliente] = probs

		if cust.default_currency and comp.default_currency and cust.default_currency != comp.default_currency:
			avisos.append(_("{0} factura em {1} (empresa em {2}) — é preciso câmbio para {3}.").format(
				frappe.bold(cliente), cust.default_currency, comp.default_currency, formatdate(posting)))

		try:
			limite = frappe.get_all("Customer Credit Limit",
				filters={"parent": cliente, "parenttype": "Customer", "company": company},
				fields=["credit_limit", "bypass_credit_limit_check"], limit=1)
			if limite and flt(limite[0].credit_limit) > 0 and not limite[0].bypass_credit_limit_check:
				from erpnext.selling.doctype.customer.customer import get_customer_outstanding
				total = sum(flt(ln.total) for ln in lns)
				em_divida = flt(get_customer_outstanding(cliente, company))
				if em_divida + total > flt(limite[0].credit_limit):
					avisos.append(_("{0} ultrapassa o limite de crédito ({1} em dívida + {2} > {3}) "
						"— a submissão será bloqueada.").format(
						frappe.bold(cliente), frappe.format(em_divida, {"fieldtype": "Currency"}),
						frappe.format(total, {"fieldtype": "Currency"}),
						frappe.format(limite[0].credit_limit, {"fieldtype": "Currency"})))
		except Exception:
			pass

	# ── Submit-time / content warnings ──
	if not frappe.db.exists("Sales Taxes and Charges Template",
			{"company": company, "is_default": 1, "disabled": 0}):
		avisos.append(_("Sem modelo de impostos (IVA) predefinido para {0} — as facturas "
			"serão criadas sem IVA.").format(company))

	try:
		dims = frappe.db.sql("""
			SELECT ad.label FROM `tabAccounting Dimension` ad
			JOIN `tabAccounting Dimension Detail` d ON d.parent = ad.name
			WHERE ad.disabled = 0 AND d.company = %s
			  AND (d.mandatory_for_pl = 1 OR d.mandatory_for_bs = 1)
			  AND ad.document_type NOT IN ('Project', 'Cost Center')
		""", company)
		if dims:
			avisos.append(_("Dimensões contabilísticas obrigatórias ({0}) não são preenchidas "
				"automaticamente — preencha-as antes de submeter.").format(", ".join(d[0] for d in dims)))
	except Exception:
		pass

	return {"erros": erros, "avisos": avisos, "clientes": clientes}


def _detalhe_por_cliente(clientes):
	"""
	Invoice line detail per customer: the Customer's own 'Detalhe da Factura', or
	the SIGOS Settings default when it is 'Predefinido'/unset.
	  Por Contrato: one line per contract x regime
	  Por Posto:    one line per posto x regime, labelled by the posto's nome financeiro
	"""
	padrao = frappe.db.get_single_value("SIGOS Settings", "detalhe_fatura_padrao") or "Por Contrato"
	clientes = [c for c in clientes if c]
	if not clientes:
		return {}
	proprio = {}
	if frappe.db.has_column("Customer", "custom_detalhe_fatura"):
		proprio = dict(frappe.get_all("Customer", filters={"name": ["in", clientes]},
			fields=["name", "custom_detalhe_fatura"], as_list=True))
	return {
		c: (proprio.get(c) if proprio.get(c) not in (None, "", "Predefinido") else padrao)
		for c in clientes
	}


def _conta_receita_definida(item_code, item_group, company):
	return bool(
		frappe.db.get_value("Item Default",
			{"parent": item_code, "parenttype": "Item", "company": company}, "income_account")
		or frappe.db.get_value("Item Default",
			{"parent": item_group, "parenttype": "Item Group", "company": company}, "income_account")
	)


def _fmt_problemas(por_cliente):
	return "<br>".join(f"{frappe.bold(c)}: {'; '.join(p)}" for c, p in sorted(por_cliente.items()))


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _clientes_ja_faturados(company, mes_referencia, clientes, excluir=None):
	"""
	{cliente: [Sales Invoice]} for customers that already have a non-cancelled SIGOS
	invoice for the same company + month — made by a Faturacao Mensal run or
	directly on the Sales Invoice ('Contratos SIGOS'). Both stamp
	custom_mes_referencia; older run invoices (before that field) are matched by
	custom_faturacao_mensal + posting month. Manual invoices are not counted.
	"""
	clientes = [c for c in clientes if c]
	if not (company and mes_referencia and clientes):
		return {}
	mes = getdate(mes_referencia)
	rows = frappe.db.sql("""
		SELECT name, customer FROM `tabSales Invoice`
		WHERE company = %(company)s AND customer IN %(clientes)s
		  AND docstatus < 2 AND name != %(excluir)s
		  AND (custom_mes_referencia = %(mes)s
		       OR (IFNULL(custom_faturacao_mensal, '') != ''
		           AND posting_date BETWEEN %(mes)s AND %(fim)s))
		ORDER BY name
	""", {
		"company": company, "clientes": tuple(clientes), "excluir": excluir or "",
		"mes": get_first_day(mes), "fim": get_last_day(mes),
	}, as_dict=True)
	out = {}
	for r in rows:
		out.setdefault(r.customer, []).append(r.name)
	return out


def _fmt_ja_faturados(ja):
	return "<br>".join(
		f"{frappe.bold(cli)}: {', '.join(nomes)}" for cli, nomes in sorted(ja.items()))


def _item_para_regime(regime):
	"""
	Get or create the non-stock service Item for a regime (e.g. 'VIG-H24').
	insert(set_name=code) forces the item code even when Stock Settings names Items
	by naming series — otherwise the item would be saved as e.g. STO-ITEM-0001, the
	invoice would point at a non-existent VIG-<regime> and every run would add a
	duplicate. _verificar guarantees the group/UOM exist before we get here.
	"""
	code = f"VIG-{regime}"
	if frappe.db.exists("Item", code):
		return code

	item = frappe.get_doc({
		"doctype": "Item",
		"item_code": code,
		"item_name": f"Vigilância {regime}",
		"item_group": ITEM_GROUP_FATURACAO,
		"stock_uom": UOM_FATURACAO,
		"is_stock_item": 0,
		"is_sales_item": 1,
		"is_purchase_item": 0,
		"include_item_in_manufacturing": 0,
		"description": f"Serviço de vigilância — regime {regime} (por vigilante/mês).",
	})
	item.flags.ignore_permissions = True
	item.insert(set_name=code)
	return code


@frappe.whitelist()
def faturar_cliente(cliente, mes_referencia=None):
	"""
	'Faturar Mês' shortcut (Customer / Project forms): open the customer's billing
	run for that month, previewed and ready to review. Reuses the customer's run
	for the month that hasn't generated invoices yet (so repeated clicks don't pile
	up drafts); otherwise starts a new one. Runs are per CUSTOMER — all its
	contracts together — because the double-billing guard is per customer + month.
	"""
	frappe.only_for(PAPEIS_FATURACAO)
	if not frappe.db.exists("Customer", cliente):
		frappe.throw(_("Cliente {0} não existe.").format(cliente))

	mes = getdate(mes_referencia or nowdate())
	company = empresa_faturacao()
	if not company:
		frappe.throw(_("Defina a <b>Empresa Padrão</b> nas Definições SIGOS."))

	nome = frappe.db.get_value("Faturacao Mensal", {
		"cliente": cliente,
		"company": company,
		"mes_referencia": ["between", [get_first_day(mes), get_last_day(mes)]],
		"faturas_geradas": ["is", "not set"],
	}, "name", order_by="modified desc")

	if nome:
		doc = frappe.get_doc("Faturacao Mensal", nome)
	else:
		doc = frappe.new_doc("Faturacao Mensal")
		doc.cliente = cliente
		doc.company = company
		doc.mes_referencia = mes
		doc.insert(ignore_permissions=True)

	doc.preview()
	return doc.name


def empresa_faturacao():
	"""Billing company: SIGOS Settings > user default > Global Defaults."""
	return (frappe.db.get_single_value("SIGOS Settings", "empresa_padrao")
		or frappe.defaults.get_user_default("Company")
		or frappe.db.get_single_value("Global Defaults", "default_company"))
