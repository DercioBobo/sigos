import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, cstr, flt, getdate, get_first_day, get_last_day, formatdate, nowdate, strip_html

from sigos.contrato import (ADICIONAL_FIXA, ADICIONAL_POSTOS, ADICIONAL_VIGILANTES,
	adicional_por_ref, adicionais_do_contrato, linhas_contratadas, nomes_faturacao_categorias,
	procurar_tarifa, resolver_tarifa, rotulo_tarifa, servicos, tabelas_adicionais,
	tarifas_dos_clientes, vigilantes_por_servico_regimes)
from sigos.perfil_faturacao import (DETALHE_POR_POSTO, DETALHE_UMA_LINHA, FATURAR_SERVICO,
	PREDEFINIDO, perfis_dos_clientes, vigilantes_por_servico)


class FaturacaoMensal(Document):

	# ─── Preview: count per (contract, regime, categoria) x contract tariff ──────

	@frappe.whitelist()
	def preview(self):
		"""Compute the billing lines (see calcular_linhas) and store them on this run."""
		frappe.only_for(PAPEIS_FATURACAO)
		self.set("linhas", [])

		linhas, activos_contratos = calcular_linhas(self.cliente, self.mes_referencia)
		nomes = nomes_faturacao_categorias()

		total_geral = 0
		total_vig = 0
		sem_tarifa = []
		for l in linhas:
			if l["quantidade"] and not l["valor_unitario"]:
				sem_tarifa.append(f"{l['cliente'] or '?'} / {l['project']} / "
					f"{rotulo_tarifa(l['regime'], l.get('categoria'), nomes)}")
			self.append("linhas", l)
			total_geral += l["total"]
			total_vig += (l.get("vigilantes") or 0)

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

		dif = diferencas_contratuais(linhas)
		if dif:
			frappe.msgprint(
				_("Contratos facturados pela quantidade do contrato que diferem dos vigilantes "
				  "activos (não impede a facturação):<br>{0}").format("<br>".join(dif)),
				title=_("Contratual vs Activos"),
				indicator="blue",
			)

		if sem_tarifa:
			frappe.msgprint(
				_("Sem tarifa definida (valor 0) para: <br>{0}<br><br>"
				  "Defina o preço no contrato (<b>Faturação por Regime</b>) ou no Cliente (<b>Tarifas por Regime</b>).").format(
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
		itens = {codigo_item(ln): _item_para_linha(ln)
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
				si = self._montar_fatura(cliente, lns, itens, proj_nomes)
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

	def _montar_fatura(self, cliente, lns, itens, proj_nomes):
		"""The customer's Sales Invoice for this run, not yet inserted."""
		posting = get_last_day(getdate(self.mes_referencia))
		mes_label = formatdate(self.mes_referencia, "MMMM yyyy")
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
			# the template already carries the month; the fallback adds it
			texto = ln.descricao or "{0}{1} — {2} ({3})".format(
				ln.regime, " [Temporário]" if ln.tipo_posto == "Temporário" else "",
				proj_nomes[ln.project], mes_label)
			si.append("items", {
				"item_code": itens[codigo_item(ln)],
				"qty": 1 if ln.linha_unica else ln.quantidade,
				"rate": ln.valor_unitario,
				"description": texto,
				"project": ln.project,
			})
			if not ln.adicional:
				total_vig += ln.vigilantes or ln.quantidade

		if si.meta.has_field("custom_total_vigilantes"):
			si.custom_total_vigilantes = total_vig
		return si

	@frappe.whitelist()
	def pre_visualizar_impressao(self, cliente):
		"""The customer's invoice as it would print (see _previa_impressao)."""
		frappe.only_for(PAPEIS_FATURACAO)
		return _previa_impressao(self, cliente)


def _previa_impressao(run, cliente):
	"""
	The customer's invoice exactly as it would print: built and inserted like Gerar
	Faturas does (so taxes and totals are real), rendered with the Sales Invoice
	DEFAULT print format, then rolled back — nothing is kept. It is shown as a
	preview only: the number reads PRÉ-VISUALIZAÇÃO and the page can't be printed
	(only a real Sales Invoice is printed).
	"""
	from frappe.www.printview import get_print_format_doc, get_print_style, get_rendered_template

	lns = _linhas_por_cliente(run).get(cliente)
	if not lns:
		frappe.throw(_("Sem linhas facturáveis para {0}.").format(cliente))

	sp = "sigos_fat_pre_visualizar"
	n_msgs = len(frappe.local.message_log)
	frappe.db.savepoint(sp)
	try:
		itens = {codigo_item(ln): _item_para_linha(ln) for ln in lns}
		proj_nomes = {ln.project: frappe.db.get_value("Project", ln.project, "project_name") or ln.project
			for ln in lns}
		si = run._montar_fatura(cliente, lns, itens, proj_nomes)
		si.insert(ignore_permissions=True)
		si.name = _("PRÉ-VISUALIZAÇÃO")   # never show the number a real invoice would take
		meta = frappe.get_meta("Sales Invoice")
		pf = get_print_format_doc(meta.default_print_format or "Standard", meta=meta)
		frappe.flags.ignore_print_permissions = True
		html = get_rendered_template(si, print_format=pf, meta=meta)
		style = get_print_style(print_format=pf)
	finally:
		frappe.flags.ignore_print_permissions = False
		frappe.db.rollback(save_point=sp)
		del frappe.local.message_log[n_msgs:]
	return {"html": html, "style": style, "total": si.grand_total, "moeda": si.currency,
		"formato": meta.default_print_format or "Standard"}


@frappe.whitelist()
def pre_visualizar_fatura_cliente(cliente, mes_referencia=None):
	"""Previsão de Faturação: the customer's invoice for the month as it would print,
	from an unsaved run (nothing is created)."""
	frappe.only_for(PAPEIS_FATURACAO)
	mes = getdate(mes_referencia or nowdate())
	run = frappe.new_doc("Faturacao Mensal")
	run.company = empresa_faturacao()
	run.cliente = cliente
	run.mes_referencia = get_first_day(mes)
	if not run.company:
		frappe.throw(_("Defina a <b>Empresa Padrão</b> nas Definições SIGOS."))
	for l in calcular_linhas(cliente, run.mes_referencia)[0]:
		run.append("linhas", l)
	return _previa_impressao(run, cliente)


def calcular_linhas(cliente=None, mes=None, perfil=None):
	"""
	Billing lines per contract (Project) + regime + guard categoria — shared by the Faturacao Mensal
	preview and the Sales Invoice 'Contratos SIGOS' fetch. Each contract is counted
	with its own método de faturação (Project.custom_metodo_faturacao,
	'Predefinido' -> the customer's billing profile, sigos.perfil_faturacao):
	  - Vigilantes Activos: Activo guards of the contract right now — per service
	    customers (faturar_por 'Serviço') get, per posto, guards ÷ the regime's
	    Vigilantes por Serviço rounded up (H24 with 3 guards = 1); per guard
	    customers get the guard count.
	  - Contratual: the Quantidade typed in the contract's Finance table.
	Rates are per regime and optionally per categoria (H24 Armado / H24 Simples): a
	guard's categoria uses its own row, else the regime's row without categoria
	(procurar_tarifa). Active guards are always split by categoria; a Contratual
	line takes the categoria of its contract row.
	Linhas Adicionais (arma, rádio…) are added per contract (sigos.contrato) and,
	on 'Por Posto (uma linha)', folded into the posto's line.
	The rate comes from the contract's Finance table (Faturação por Regime), or — for a
	row without a price, or a regime the contract doesn't list — from the customer's
	Tarifas por Regime (resolver_tarifa). Each line says which (origem_tarifa).
	Cliente is derived from the Project so it is always authoritative.
	posto_interno / project-less guards are not billable.
	Line text: the profile's template (sigos.descricao_fatura), for the billed month
	`mes` (default: this month). `perfil` previews an unsaved profile choice for
	`cliente` ('' = the default profile).
	Returns (linhas, activos_contratos); each linha has cliente/total filled in.
	"""
	filtros = {"customer": ["is", "set"]}
	if cliente:
		filtros["customer"] = cliente
	contratos = frappe.get_all(
		"Project", filters=filtros,
		fields=["name", "project_name", "customer", "status", "custom_metodo_faturacao"],
	)
	cliente_de = {c.name: c.customer for c in contratos}
	perfis = perfis_dos_clientes(cliente_de.values(),
		{cliente: perfil} if cliente and perfil is not None else None)
	sem_perfil = frappe._dict(PREDEFINIDO)

	def pf(proj):
		return perfis.get(cliente_de.get(proj)) or sem_perfil

	metodo = {
		c.name: (c.custom_metodo_faturacao
			if c.custom_metodo_faturacao not in (None, "", "Predefinido") else pf(c.name).metodo_faturacao)
		for c in contratos
	}
	proj_nome = {c.name: c.project_name or c.name for c in contratos}
	estado_de = {c.name: c.status for c in contratos}
	por_regime = vigilantes_por_servico_regimes()

	def por_posto(proj):
		return pf(proj).detalhe_fatura in (DETALHE_POR_POSTO, DETALHE_UMA_LINHA)

	def uma_linha(proj):
		return pf(proj).detalhe_fatura == DETALHE_UMA_LINHA

	# Contracted qty + rate + invoice text per (contract, regime, categoria), from the
	# Finance table ('' categoria = any).
	contratado = linhas_contratadas(list(metodo))
	do_cliente = tarifas_dos_clientes(cliente_de.values())
	nomes_cat = nomes_faturacao_categorias()

	def linha_contrato(proj, regime, cat):
		"""(key, row) of the contract row that bills this regime + categoria."""
		for k in ((proj, regime, cat or ""), (proj, regime, "")):
			if k in contratado:
				return k, contratado[k]
		return None, None

	def tarifa(proj, regime, cat):
		"""(valor, origem, descricao) — contract first, then the customer."""
		return resolver_tarifa(linha_contrato(proj, regime, cat)[1],
			procurar_tarifa(do_cliente, (cliente_de.get(proj), regime), cat))

	# Postos of these contracts: details for the line text, and the active ones per
	# contract ({postos}, and {posto}/{nome_financeiro} on lines without one posto).
	info_posto, postos_de = {}, {}
	if contratos:
		for pv in frappe.get_all(
			"Posto De Vigilancia",
			filters={"project": ["in", list(metodo)]},
			fields=["name", "project", "nome_do_posto", "nome_financeiro", "indicativo",
				"localizacao", "delegacao", "estado", "posto_interno"],
			order_by="nome_financeiro, nome_do_posto",
		):
			info_posto[pv.name] = pv
			if pv.estado == "Activo" and not pv.posto_interno:
				postos_de.setdefault(pv.project, []).append(pv.nome_financeiro or pv.nome_do_posto)

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
	pendentes = []   # per-posto lines, merged below for 'Por Posto (uma linha)'
	if activos_contratos:
		rows = _activos_por_posto(activos_contratos)

		agrupado = {}
		for r in rows:
			modo = pf(r.project).faturar_por
			# rows are per posto, so a service is rounded up per posto
			qtd = servicos(r.qtd, pf(r.project), r.regime, por_regime)
			posto = r.posto if por_posto(r.project) else None
			cat = r.categoria or ""
			k = (r.project, r.regime, cat, r.tipo_posto, posto)
			ck, c = linha_contrato(r.project, r.regime, cat)
			if k not in agrupado:
				valor, origem, _desc = tarifa(r.project, r.regime, cat)
				agrupado[k] = dict(
					project=r.project, regime=r.regime, categoria=cat, tipo_posto=r.tipo_posto,
					posto=posto, metodo="Vigilantes Activos", quantidade=0, vigilantes=0,
					faturar_por=modo, quantidade_contratada=c.quantidade if c else 0,
					valor_unitario=valor, origem_tarifa=origem,
				)
			agrupado[k]["quantidade"] += qtd
			agrupado[k]["vigilantes"] += r.qtd
			if ck:
				vistos.add(ck)

		pendentes.extend(agrupado.values())

		# Contracted regimes with nobody active: a 0-qty line so the shortfall is
		# visible in the preview (never invoiced — gerar_faturas skips qty 0).
		for (proj, regime, cat), c in contratado.items():
			if (metodo.get(proj) == "Vigilantes Activos" and (proj, regime, cat) not in vistos
					and c.quantidade and cliente_de.get(proj)
					and estado_de.get(proj) not in ("Completed", "Cancelled")):
				valor, origem, _desc = tarifa(proj, regime, cat)
				linhas.append(dict(
					project=proj, regime=regime, categoria=cat, tipo_posto="", posto=None,
					metodo="Vigilantes Activos",
					quantidade=0, vigilantes=0, faturar_por=pf(proj).faturar_por,
					quantidade_contratada=c.quantidade,
					valor_unitario=valor, origem_tarifa=origem,
				))

	# ── Contratual ── open contracts only; qty straight from the Finance table.
	# The contracted qty is per regime, not per posto, so Por Posto customers get
	# one line per regime listing the contract's active postos by nome financeiro.
	contratuais = [p for p, m in metodo.items()
		if m == "Contratual" and estado_de.get(p) not in ("Completed", "Cancelled")]
	# For information only: what the active guards would bill (same per-posto rule
	# as Vigilantes Activos), so a contracted qty above/below reality is visible.
	# Guards count against the contract row that bills their categoria (its own row,
	# else the regime's row without categoria).
	real = {}
	if contratuais:
		for r in _activos_por_posto(contratuais):
			q = servicos(r.qtd, pf(r.project), r.regime, por_regime)
			ck = (linha_contrato(r.project, r.regime, r.categoria)[0]
				or (r.project, r.regime, r.categoria or ""))
			acc = real.setdefault(ck, [0, 0])
			acc[0] += q
			acc[1] += r.qtd
	for (proj, regime, cat), c in contratado.items():
		if proj not in contratuais or not c.quantidade:
			continue
		valor, origem, _desc = tarifa(proj, regime, cat)
		q_real, v_real = real.pop((proj, regime, cat), (0, 0))
		linhas.append(dict(
			project=proj, regime=regime, categoria=cat, tipo_posto="", posto=None,
			metodo="Contratual",
			quantidade=c.quantidade, quantidade_contratada=c.quantidade,
			quantidade_real=q_real, vigilantes_reais=v_real,
			faturar_por=pf(proj).faturar_por,
			vigilantes=_vigilantes_contratuais(c.quantidade, pf(proj), regime, por_regime),
			valor_unitario=valor, origem_tarifa=origem,
		))
	# Active guards in a regime the contract doesn't bill: a 0-qty line (never
	# invoiced) so it shows up in the comparison.
	for (proj, regime, cat), (q_real, v_real) in real.items():
		valor, origem, _desc = tarifa(proj, regime, cat)
		linhas.append(dict(
			project=proj, regime=regime, categoria=cat, tipo_posto="", posto=None, metodo="Contratual",
			quantidade=0, quantidade_contratada=0, quantidade_real=q_real, vigilantes_reais=v_real,
			faturar_por=pf(proj).faturar_por, vigilantes=0,
			valor_unitario=valor, origem_tarifa=origem,
		))

	# ── Linhas Adicionais (arma, rádio, viatura…) ── the contract's own, else its
	# customer's, valid in the billed month. Only contracts billing something get
	# them: Fixa needs a billed line; Vigilantes / Postos count the active guards
	# (per posto for Por Posto customers on Vigilantes Activos).
	tabelas = tabelas_adicionais(list(metodo), cliente_de.values())
	desc_adicional = {}
	if tabelas:
		mes_ref = getdate(mes or nowdate())
		faturados = {l["project"] for l in linhas + pendentes
			if l["quantidade"] and flt(l["valor_unitario"])}
		com_adicionais = {}
		for proj in metodo:
			if cliente_de.get(proj) and estado_de.get(proj) not in ("Completed", "Cancelled"):
				ads = adicionais_do_contrato(tabelas, proj, cliente_de[proj], mes_ref)
				if ads:
					com_adicionais[proj] = ads
		rows_de = {}
		for r in (_activos_por_posto(list(com_adicionais)) if com_adicionais else []):
			rows_de.setdefault(r.project, []).append(r)
		for proj, ads in com_adicionais.items():
			separar = por_posto(proj) and metodo[proj] == "Vigilantes Activos"
			tipo_de = {r.posto: r.tipo_posto for r in rows_de.get(proj, [])}
			for ref, ad in ads:
				desc_adicional[(proj, ref)] = ad.descricao
				contagem = {}
				if ad.contar_por == ADICIONAL_FIXA:
					if proj in faturados:
						contagem[None] = cint(ad.quantidade)
				else:
					for r in rows_de.get(proj, []):
						if ad.contar_por == ADICIONAL_VIGILANTES and (
								(ad.categoria and r.categoria != ad.categoria)
								or (ad.regime and r.regime != ad.regime)):
							continue
						posto = r.posto if separar else None
						if ad.contar_por == ADICIONAL_POSTOS:
							contagem.setdefault(posto, set()).add(r.posto)
						else:
							contagem[posto] = contagem.get(posto, 0) + cint(r.qtd)
				for posto, q in contagem.items():
					q = len(q) if isinstance(q, set) else q
					if not q:
						continue
					(pendentes if posto else linhas).append(dict(
						project=proj, regime="", categoria="", posto=posto,
						tipo_posto=tipo_de.get(posto, "") if posto else "",
						metodo="Adicional", quantidade=q, vigilantes=0,
						faturar_por=pf(proj).faturar_por, quantidade_contratada=0,
						valor_unitario=flt(ad.valor),
						origem_tarifa="Contrato" if ref.startswith("P") else "Cliente",
						adicional=1, artigo=ad.artigo or "", composicao=f"@{ref}:{q}",
					))

	# 'Por Posto (uma linha)': each posto's priced lines (regimes + extras) become ONE
	# line, billed 1 x the posto's total, its make-up in the text and in `composicao`
	# (machine-readable, re-priced by the stale-preview check). An unpriced part
	# stays its own line so it is still flagged 'sem tarifa', never hidden.
	juntas = {}
	for l in pendentes:
		if not (l["posto"] and uma_linha(l["project"]) and l["quantidade"] and flt(l["valor_unitario"])):
			linhas.append(l)
			continue
		juntas.setdefault((l["project"], l["posto"]), []).append(l)
	for (proj, posto), partes in juntas.items():
		partes.sort(key=lambda x: (x.get("adicional") or 0, x["regime"], x["categoria"],
			x.get("composicao") or ""))
		servico = [x for x in partes if not x.get("adicional")]
		origens = {x["origem_tarifa"] for x in partes}
		temp = any(x["tipo_posto"] == "Temporário" for x in partes)
		linhas.append(dict(
			project=proj, regime="", categoria="", posto=posto,
			tipo_posto="Temporário" if temp else partes[0]["tipo_posto"],
			metodo="Vigilantes Activos",
			quantidade=sum(x["quantidade"] for x in servico),
			vigilantes=sum(x["vigilantes"] for x in servico),
			faturar_por=partes[0]["faturar_por"],
			quantidade_contratada=0,
			valor_unitario=sum(x["quantidade"] * flt(x["valor_unitario"]) for x in partes),
			origem_tarifa=origens.pop() if len(origens) == 1 else "Contrato + Cliente",
			linha_unica=1,
			composicao=",".join(x["composicao"] if x.get("adicional")
				else f"{x['regime']}:{x['categoria']}:{x['quantidade']}" for x in partes),
		))

	# ── Line text from the template ──
	from sigos.descricao_fatura import modelo_para, render, variaveis_do_mes
	nome_cliente = dict(frappe.get_all("Customer",
		filters={"name": ["in", list(set(cliente_de.values())) or [""]]},
		fields=["name", "customer_name"], as_list=True))
	do_mes = variaveis_do_mes(mes or nowdate())
	for l in linhas:
		proj, cli = l["project"], cliente_de.get(l["project"])
		if l.get("linha_unica"):
			partes = partes_composicao(l["composicao"])
			composicao = " + ".join(
				f"{q} × {desc_adicional.get((proj, cat), '') if reg == '@' else rotulo_tarifa(reg, cat, nomes_cat)}"
				for reg, cat, q in partes)
			regime_txt = " + ".join(dict.fromkeys(reg for reg, _c, _q in partes if reg != "@"))
			categoria_txt = " + ".join(dict.fromkeys(nomes_cat.get(c, c) for r, c, _q in partes
				if c and r != "@"))
			desc_regime = composicao
			chave = DETALHE_UMA_LINHA
		elif l.get("adicional"):
			desc_regime = desc_adicional.get((proj, partes_composicao(l["composicao"])[0][1]), "")
			composicao = f"{l['quantidade']} × {desc_regime}"
			regime_txt = categoria_txt = ""
			chave = DETALHE_POR_POSTO if l.get("posto") else "Por Contrato"
		else:
			cat = l.get("categoria") or ""
			rotulo = rotulo_tarifa(l["regime"], cat, nomes_cat)
			composicao = f"{l['quantidade']} × {rotulo}"
			regime_txt = l["regime"]
			categoria_txt = nomes_cat.get(cat, cat)
			desc_regime = (tarifa(proj, l["regime"], cat)[2] or "").strip() or rotulo
			chave = DETALHE_POR_POSTO if por_posto(proj) else "Por Contrato"
		pv = info_posto.get(l.get("posto")) if l.get("posto") else None
		lista = ", ".join(postos_de.get(proj, []))
		valores = dict(do_mes,
			regime=regime_txt, categoria=categoria_txt, descricao=desc_regime, composicao=composicao,
			quantidade=l["quantidade"], vigilantes=l.get("vigilantes"),
			nome_financeiro=(pv.nome_financeiro or pv.nome_do_posto) if pv else lista,
			posto=pv.nome_do_posto if pv else lista,
			indicativo=pv.indicativo if pv else "",
			localizacao=pv.localizacao if pv else "",
			delegacao=pv.delegacao if pv else "",
			tipo_posto=l.get("tipo_posto") or "",
			temporario="[Temporário]" if l.get("tipo_posto") == "Temporário" else "",
			postos=lista, contrato=proj_nome.get(proj, proj),
			cliente=nome_cliente.get(cli) or cli or "",
		)
		l["descricao"] = render(modelo_para(pf(proj), chave), valores)

	linhas.sort(key=lambda l: (cliente_de.get(l["project"]) or "", l["project"], l.get("adicional") or 0,
		l["regime"], l.get("categoria") or "", l["tipo_posto"] or "", l["descricao"] or ""))
	for l in linhas:
		l["cliente"] = cliente_de.get(l["project"])
		l["valor_unitario"] = flt(l["valor_unitario"])
		# a merged posto line is billed once at the posto total; quantidade stays the
		# guard count (totals, KPIs), not the invoice qty
		l["total"] = l["valor_unitario"] if l.get("linha_unica") else (l["quantidade"] or 0) * l["valor_unitario"]
	return linhas, activos_contratos


def partes_composicao(composicao):
	"""[(regime, categoria, qtd)] of a merged posto line's composicao
	('H24:Vigilante Armado:1,TDN::2'; older lines: 'H24:1'). An extra line part
	'@P3:2' comes back as ('@', 'P3', 2)."""
	out = []
	for x in (composicao or "").split(","):
		p = x.split(":")
		if p[0].startswith("@") and len(p) == 2:
			out.append(("@", p[0][1:], cint(p[1])))
		elif len(p) == 2:
			out.append((p[0], "", cint(p[1])))
		elif len(p) == 3:
			out.append((p[0], p[1], cint(p[2])))
	return out


def _activos_por_posto(projectos):
	"""Activo guards per contract x regime x categoria x posto (Cobridor shadows excluded)."""
	return frappe.db.sql("""
		SELECT v.projecto AS project, v.regime_do_vigilante AS regime,
		       IFNULL(v.categoria, '') AS categoria,
		       COALESCE(pv.tipo_de_posto, 'Permanente') AS tipo_posto,
		       v.posto_de_vigilancia AS posto,
		       COUNT(*) AS qtd
		FROM `tabVigilante` v
		LEFT JOIN `tabPosto De Vigilancia` pv ON pv.name = v.posto_de_vigilancia
		WHERE v.status = 'Activo'
		  AND v.projecto IN %(projectos)s
		  AND v.regime_do_vigilante IS NOT NULL AND v.regime_do_vigilante != ''
		  AND (v.cobertura_de_posto_activa IS NULL OR v.cobertura_de_posto_activa = '')
		GROUP BY v.projecto, v.regime_do_vigilante, IFNULL(v.categoria, ''),
		         COALESCE(pv.tipo_de_posto, 'Permanente'), v.posto_de_vigilancia
	""", {"projectos": tuple(projectos)}, as_dict=True)


def diferencas_contratuais(linhas):
	"""Contratual lines whose billed qty differs from the active guards — info only."""
	out = []
	nomes = None
	for l in linhas:
		if l.get("metodo") != "Contratual":
			continue
		q, real = cint(l.get("quantidade")), cint(l.get("quantidade_real"))
		if q == real:
			continue
		if nomes is None:
			nomes = nomes_faturacao_categorias()
		unidade = _("serviços") if l.get("faturar_por") == FATURAR_SERVICO else _("vigilantes")
		out.append(_("{0} / {1}: facturado <b>{2}</b>, activos <b>{3}</b> {4} ({5} {6})").format(
			l.get("project"), rotulo_tarifa(l.get("regime"), l.get("categoria"), nomes), q, real, unidade,
			_("a mais") if q > real else _("a menos"), abs(q - real)))
	return out


def _vigilantes_contratuais(quantidade, perfil, regime, por_regime):
	"""Guards behind a contracted quantity (per service: × guards per service)."""
	if perfil.faturar_por != FATURAR_SERVICO:
		return cint(quantidade)
	return cint(quantidade) * vigilantes_por_servico(perfil, regime, por_regime)


PAPEIS_FATURACAO = ("System Manager", "SIGOS Manager", "Accounts Manager")
ITEM_GROUP_FATURACAO = "Services"
UOM_FATURACAO = "Unit"
ITEM_POSTO = "VIG-POSTO"
ITEM_ADICIONAL = "VIG-ADICIONAL"


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
	projectos = list({ln.project for ln in doc.linhas if ln.project})
	contratado = linhas_contratadas(projectos)
	cliente_actual = {p.name: p.customer for p in frappe.get_all("Project",
		filters={"name": ["in", projectos or [""]]}, fields=["name", "customer"])}
	do_cliente = tarifas_dos_clientes(cliente_actual.values())
	adicionais = tabelas_adicionais(projectos, cliente_actual.values())

	def preco(proj, cli, reg, cat):
		if reg == "@":   # extra line: cat is its ref (P3 / C3)
			return flt((adicional_por_ref(adicionais, cat, proj, cli) or {}).get("valor"))
		return resolver_tarifa(procurar_tarifa(contratado, (proj, reg), cat),
			procurar_tarifa(do_cliente, (cli, reg), cat))[0]

	for ln in doc.linhas:
		if not ln.quantidade:
			continue
		cli = cliente_actual.get(ln.project)
		if ln.linha_unica or ln.adicional:
			partes = partes_composicao(ln.composicao)
			valor = (sum(q * preco(ln.project, cli, reg, cat) for reg, cat, q in partes) if ln.linha_unica
				else preco(ln.project, cli, "@", partes[0][1] if partes else ""))
			if flt(valor) != flt(ln.valor_unitario) or cli != ln.cliente:
				desactualizadas.append(f"{ln.project} / {ln.descricao or ln.posto}")
			continue
		cat = ln.get("categoria") or ""
		c = procurar_tarifa(contratado, (ln.project, ln.regime), cat)
		valor = resolver_tarifa(c, procurar_tarifa(do_cliente, (cli, ln.regime), cat))[0]
		mudou = (
			flt(valor) != flt(ln.valor_unitario)
			or cliente_actual.get(ln.project) != ln.cliente
			or (ln.metodo == "Contratual" and (not c or cint(c.quantidade) != cint(ln.quantidade)))
		)
		if mudou:
			desactualizadas.append(f"{ln.project} / {rotulo_tarifa(ln.regime, cat)}")
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

	# ── Items (one per regime, + VIG-POSTO for merged posto lines) ──
	for code in sorted({codigo_item(ln) for lns in por_cliente.values() for ln in lns}):
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


def codigo_item(ln):
	"""Item code of a billing line: VIG-<regime>, VIG-POSTO for a merged posto line,
	an extra line's own Artigo or VIG-ADICIONAL."""
	if ln.get("linha_unica"):
		return ITEM_POSTO
	if ln.get("adicional"):
		return ln.get("artigo") or ITEM_ADICIONAL
	return f"VIG-{ln.get('regime')}"


def _item_para_linha(ln):
	"""Get or create the line's Item (see codigo_item)."""
	if ln.get("adicional"):
		if ln.get("artigo"):
			return ln.get("artigo")
		return _criar_item(ITEM_ADICIONAL, "Serviços Adicionais",
			"Serviço adicional à vigilância (descrição na linha).")
	if ln.get("linha_unica"):
		return _criar_item(ITEM_POSTO, "Vigilância por Posto",
			"Serviço de vigilância — total mensal do posto (composição na descrição da linha).")
	return _item_para_regime(ln.get("regime"))


def _item_para_regime(regime):
	return _criar_item(f"VIG-{regime}", f"Vigilância {regime}",
		f"Serviço de vigilância — regime {regime} (por vigilante/mês).")


def _criar_item(code, nome, descricao):
	"""
	Get or create a non-stock service Item (e.g. 'VIG-H24', 'VIG-POSTO').
	insert(set_name=code) forces the item code even when Stock Settings names Items
	by naming series — otherwise the item would be saved as e.g. STO-ITEM-0001, the
	invoice would point at a non-existent VIG-<regime> and every run would add a
	duplicate. _verificar guarantees the group/UOM exist before we get here.
	"""
	if frappe.db.exists("Item", code):
		return code

	item = frappe.get_doc({
		"doctype": "Item",
		"item_code": code,
		"item_name": nome,
		"item_group": ITEM_GROUP_FATURACAO,
		"stock_uom": UOM_FATURACAO,
		"is_stock_item": 0,
		"is_sales_item": 1,
		"is_purchase_item": 0,
		"include_item_in_manufacturing": 0,
		"description": descricao,
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
