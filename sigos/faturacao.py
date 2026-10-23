"""
SIGOS billing on Sales Invoice — the direct route, without a Faturacao Mensal run.

'Contratos SIGOS' (Get Items From, on a draft Sales Invoice) fills the items from
the customer's contracts with the same lines Faturacao Mensal would build
(calcular_linhas). Both routes stamp custom_mes_referencia, and the Sales Invoice
validate hook below is the single double-billing guard for either of them.

Also here: the per-customer billing schedule (SIGOS Settings defaults + Customer
overrides), the Previsão de Faturação page data, and the daily automatic billing
job that creates Faturacao Mensal runs on each customer's billing day.
"""
import frappe
from frappe import _
from frappe.utils import (
	add_days, add_months, cint, cstr, flt, formatdate, get_first_day, get_last_day, getdate,
	nowdate, strip_html,
)

from sigos.contrato import nomes_faturacao_categorias, rotulo_tarifa
from sigos.perfil_faturacao import DESVIO_MES, MES_CORRENTE, perfis_dos_clientes
from sigos.sigos_setup.doctype.faturacao_mensal.faturacao_mensal import (
	ITEM_GROUP_FATURACAO,
	PAPEIS_FATURACAO,
	UOM_FATURACAO,
	_clientes_ja_faturados,
	_fmt_problemas,
	_item_para_linha,
	_verificar,
	calcular_linhas,
	codigo_item,
	diferencas_contratuais,
	empresa_faturacao,
)


def sales_invoice_po(doc, method=None):
	"""Nr da PO (custom_nr_po) is mirrored into ERPNext's own Customer's Purchase Order
	(po_no), so standard reports and print formats that use it see the same number."""
	if not doc.meta.has_field("custom_nr_po"):
		return
	doc.custom_nr_po = (doc.custom_nr_po or "").strip() or None
	antes = doc.get_doc_before_save()
	if not doc.custom_nr_po and doc.po_no and not (antes and antes.get("custom_nr_po")):
		doc.custom_nr_po = doc.po_no   # PO already set the ERPNext way (e.g. from a Sales Order)
	doc.po_no = doc.custom_nr_po


def sales_invoice_po_apos_submeter(doc, method=None):
	"""The PO often arrives after the invoice is submitted (Nr da PO is editable then)."""
	if doc.meta.has_field("custom_nr_po") and (doc.custom_nr_po or None) != (doc.po_no or None):
		doc.db_set("po_no", doc.custom_nr_po or None, update_modified=False)


def sales_invoice_validate(doc, method=None):
	"""One SIGOS invoice per customer + company + month (drafts count, cancelled don't)."""
	if not doc.get("custom_mes_referencia"):
		return
	mes = get_first_day(getdate(doc.custom_mes_referencia))
	doc.custom_mes_referencia = mes
	ja = _clientes_ja_faturados(doc.company, mes, {doc.customer}, excluir=doc.name)
	if ja:
		frappe.throw(
			_("O cliente <b>{0}</b> já tem factura SIGOS de {1}: {2}.<br><br>"
			  "Para refacturar, cancele (ou apague, se ainda em rascunho) a factura existente.<br>"
			  "Para facturar <b>serviços extra</b>, crie uma factura normal (sem <b>Contratos SIGOS</b>) "
			  "— essas não contam como a factura do mês.").format(
				doc.customer, formatdate(mes, "MMMM yyyy"), ", ".join(ja[doc.customer])),
			title=_("Já Facturado"),
		)


@frappe.whitelist()
def obter_linhas_contrato(doc, mes_referencia, substituir=1):
	"""
	Fill a draft Sales Invoice with the customer's SIGOS contract lines for a month.
	Takes the (possibly unsaved) invoice from the form and returns it with the items
	added, for frappe.model.sync on the client — the same round-trip ERPNext's own
	'Get Items From' mapping uses, so item details/accounts/totals come from ERPNext.
	"""
	frappe.only_for(PAPEIS_FATURACAO)
	si = frappe.get_doc(frappe.parse_json(doc))
	if si.doctype != "Sales Invoice" or si.docstatus != 0:
		frappe.throw(_("Só é possível em facturas de venda em rascunho."))
	if si.get("is_return"):
		frappe.throw(_("Não disponível em notas de crédito."))
	if not (si.customer and si.company):
		frappe.throw(_("Defina primeiro o <b>Cliente</b> e a <b>Empresa</b>."))

	mes = get_first_day(getdate(mes_referencia))
	mes_label = formatdate(mes, "MMMM yyyy")

	excluir = None if si.get("__islocal") else si.name
	ja = _clientes_ja_faturados(si.company, mes, {si.customer}, excluir=excluir)
	if ja:
		frappe.throw(
			_("O cliente <b>{0}</b> já tem factura SIGOS de {1}: {2}.").format(
				si.customer, mes_label, ", ".join(ja[si.customer])),
			title=_("Já Facturado"),
		)

	linhas, activos_contratos = calcular_linhas(si.customer, mes)
	dif = diferencas_contratuais(linhas)
	nomes_cat = nomes_faturacao_categorias()
	sem_tarifa = [f"{l['project']} / {rotulo_tarifa(l['regime'], l.get('categoria'), nomes_cat)}"
		for l in linhas if l["quantidade"] and not l["valor_unitario"]]
	linhas = [l for l in linhas if l["quantidade"] and l["valor_unitario"]]
	if not linhas:
		frappe.throw(
			_("Nada a facturar para <b>{0}</b>: sem contratos com vigilantes e tarifa "
			  "(Faturação por Regime no Projecto, ou Tarifas por Regime no Cliente).").format(si.customer),
			title=_("Sem Linhas"),
		)

	if any(not frappe.db.exists("Item", codigo_item(l)) for l in linhas):
		erros = []
		if not frappe.db.exists("Item Group", {"name": ITEM_GROUP_FATURACAO, "is_group": 0}):
			erros.append(_("Falta o Grupo de Artigos <b>{0}</b>.").format(ITEM_GROUP_FATURACAO))
		if not frappe.db.exists("UOM", {"name": UOM_FATURACAO, "enabled": 1}):
			erros.append(_("Falta a Unidade de Medida <b>{0}</b>.").format(UOM_FATURACAO))
		if erros:
			frappe.throw("<br>".join(erros), title=_("Configuração em Falta"))
	itens = {codigo_item(l): _item_para_linha(l) for l in linhas}

	if cint(substituir):
		si.set("items", [])
	proj_nomes = {p: frappe.db.get_value("Project", p, "project_name") or p
		for p in {l["project"] for l in linhas}}
	for l in linhas:
		# the template already carries the month; the fallback adds it
		texto = l.get("descricao") or "{0}{1} — {2} ({3})".format(
			l["regime"], " [Temporário]" if l["tipo_posto"] == "Temporário" else "",
			proj_nomes[l["project"]], mes_label)
		si.append("items", {
			"item_code": itens[codigo_item(l)],
			"qty": 1 if l.get("linha_unica") else l["quantidade"],
			"rate": l["valor_unitario"],
			"description": texto,
			"project": l["project"],
		})

	si.ignore_pricing_rule = 1   # the contract rate is final — no Pricing Rule may alter it
	si.custom_mes_referencia = mes
	if si.meta.has_field("custom_total_vigilantes"):
		si.custom_total_vigilantes = sum(cint(l.get("vigilantes", l["quantidade"])) for l in linhas)

	si.set_missing_values()
	si.calculate_taxes_and_totals()

	if sem_tarifa:
		frappe.msgprint(
			_("Sem tarifa (não incluídos): {0}. Defina o preço no contrato (Faturação por Regime) ou no Cliente (Tarifas por Regime).").format(
				", ".join(sem_tarifa)),
			title=_("Tarifas em Falta"), indicator="orange")
	if dif:
		frappe.msgprint(
			_("Quantidade do contrato diferente dos vigilantes activos (não impede a facturação):<br>{0}").format(
				"<br>".join(dif)),
			title=_("Contratual vs Activos"), indicator="blue")
	if activos_contratos and get_last_day(mes) < getdate(nowdate()):
		frappe.msgprint(
			_("Contratos em <b>Vigilantes Activos</b> foram contados com o efectivo <b>de hoje</b>, "
			  "não o de {0}. Confirme as quantidades.").format(mes_label),
			title=_("Mês Já Encerrado"), indicator="orange")

	return si.as_dict()


# ─── Agenda: when each customer is billed ────────────────────────────────────
# SIGOS Settings holds the master switch; the customer's billing profile says
# whether it is billed automatically, on which day and which month. Invoices are
# per customer, so the schedule is too.

_LOCK_AUTO = "sigos:faturacao_automatica:lock"


def _agenda_clientes(clientes):
	"""{cliente: _dict(automatica, opt_in, dia, mes_faturado, perfil, perfil_proprio)}."""
	geral = cint(frappe.db.get_single_value("SIGOS Settings", "faturacao_automatica"))
	out = {}
	for c, p in perfis_dos_clientes(clientes).items():
		out[c] = frappe._dict(
			opt_in=bool(p.faturacao_automatica),
			automatica=bool(geral and p.faturacao_automatica),
			dia=p.dia_faturacao,
			mes_faturado=p.mes_faturado if p.mes_faturado in DESVIO_MES else MES_CORRENTE,
			perfil=p.nome or "",
			perfil_proprio=p.proprio,
		)
	return out


def _clientes_automaticos():
	"""Enabled customers with a contract whose billing profile bills automatically."""
	clientes = frappe.get_all("Project", filters={"customer": ["is", "set"]},
		pluck="customer", distinct=True)
	activos = set(frappe.get_all("Customer",
		filters={"name": ["in", clientes or [""]], "disabled": 0}, pluck="name"))
	return sorted(c for c, p in perfis_dos_clientes(activos).items() if p.faturacao_automatica)


def _dia_no_mes(data_no_mes, dia):
	"""Day `dia` of that month, clamped to its last day (31 -> always the last day)."""
	inicio = get_first_day(data_no_mes)
	return min(getdate(add_days(inicio, dia - 1)), get_last_day(inicio))


def _mes_da_execucao(data_execucao, mes_faturado):
	"""Month billed by a run on this date: the one before, its own, or the next."""
	inicio = get_first_day(data_execucao)
	return getdate(add_months(inicio, DESVIO_MES.get(mes_faturado, 0)))


def _data_da_execucao(mes_referencia, ag):
	"""Date the automatic run bills this month: the next month's day when in arrears,
	the previous month's day when billed a month ahead."""
	mes_exec = getdate(add_months(get_first_day(mes_referencia), -DESVIO_MES.get(ag.mes_faturado, 0)))
	return _dia_no_mes(mes_exec, ag.dia)


def _runs_automaticos(company, mes, clientes):
	"""Latest automatic Faturacao Mensal run per customer for that month."""
	if not (company and clientes):
		return {}
	out = {}
	for r in frappe.get_all("Faturacao Mensal",
			filters={"automatica": 1, "company": company, "cliente": ["in", list(clientes)],
				"mes_referencia": ["between", [get_first_day(mes), get_last_day(mes)]]},
			fields=["name", "cliente", "faturas_geradas", "registo_automatico", "modified"],
			order_by="modified desc"):
		out.setdefault(r.cliente, r)
	return out


# ─── Previsão de Faturação (page) ────────────────────────────────────────────

@frappe.whitelist()
def get_previsao_faturacao(mes_referencia=None):
	"""
	What each customer will be billed for a month, with its schedule and status.
	Same lines as Faturacao Mensal / the Sales Invoice fetch (calcular_linhas) and the
	same pre-flight (_verificar), so what is shown here is what will be invoiced.
	"""
	frappe.only_for(PAPEIS_FATURACAO)
	hoje = getdate(nowdate())
	mes = get_first_day(getdate(mes_referencia or hoje))
	company = empresa_faturacao()

	linhas, activos_contratos = calcular_linhas(mes=mes)
	por_cliente = {}
	for l in linhas:
		if l["cliente"]:
			por_cliente.setdefault(l["cliente"], []).append(l)
	# Customers set to bill automatically show up even with nothing to bill.
	for c in _clientes_automaticos():
		por_cliente.setdefault(c, [])

	clientes = sorted(por_cliente)
	agenda = _agenda_clientes(clientes)
	nomes = dict(frappe.get_all("Customer", filters={"name": ["in", clientes or [""]]},
		fields=["name", "customer_name"], as_list=True))

	# Invoices of this month (same matching as the double-billing guard) + last month.
	ja = _clientes_ja_faturados(company, mes, clientes) if company else {}
	ant = _clientes_ja_faturados(company, add_months(mes, -1), clientes) if company else {}
	nomes_si = [n for ns in ja.values() for n in ns] + [n for ns in ant.values() for n in ns]
	detalhe_si = {}
	if nomes_si:
		for si in frappe.get_all("Sales Invoice", filters={"name": ["in", nomes_si]},
				fields=["name", "docstatus", "net_total", "grand_total"]):
			detalhe_si[si.name] = si
	runs = _runs_automaticos(company, mes, clientes)
	extras = _faturas_extra(company, mes, clientes)

	faturaveis =[frappe._dict(l) for l in linhas
		if l["cliente"] and l["quantidade"] and l["valor_unitario"]]
	verif = {"erros": [], "avisos": [], "clientes": {}}
	if not company:
		verif["erros"].append(_("Defina a <b>Empresa Padrão</b> nas Definições SIGOS."))
	elif faturaveis:
		verif = _verificar(frappe._dict(company=company, mes_referencia=mes, linhas=faturaveis))

	nomes_cat = nomes_faturacao_categorias()
	out = []
	for c in clientes:
		lns = por_cliente[c]
		ag = agenda[c]
		billable = [l for l in lns if l["quantidade"] and l["valor_unitario"]]
		sem_tarifa = sorted({f"{l['project']} / {rotulo_tarifa(l['regime'], l.get('categoria'), nomes_cat)}"
			for l in lns if l["quantidade"] and not l["valor_unitario"]})
		em_falta = sum(max(cint(l["quantidade_contratada"]) - cint(l["quantidade"]), 0)
			for l in lns if l["metodo"] == "Vigilantes Activos")
		faturas = [detalhe_si[n] for n in ja.get(c, []) if n in detalhe_si]
		anterior = sum(flt(detalhe_si[n].net_total) for n in ant.get(c, []) if n in detalhe_si)
		problemas = list(verif["clientes"].get(c, []))
		run = runs.get(c)
		data_exec = _data_da_execucao(mes, ag)

		if faturas:
			estado = "faturado"
		elif run and run.faturas_geradas:
			estado = "cancelado"   # its automatic invoice was cancelled/deleted: never re-created
		elif not billable:
			estado = "sem_linhas"
		elif problemas:
			estado = "problemas"
		elif ag.automatica:
			if get_first_day(data_exec) < get_first_day(hoje):
				estado = "em_falta"   # its run month is over: the job no longer catches up
			elif data_exec <= hoje:
				estado = "pendente"   # due: picked up by the next daily run
			else:
				estado = "agendado"
		else:
			estado = "manual"

		out.append(dict(
			cliente=c,
			nome=nomes.get(c) or c,
			contratos=len({l["project"] for l in lns}),
			vigilantes=sum(cint(l.get("vigilantes", l["quantidade"])) for l in billable),
			total=sum(flt(l["total"]) for l in billable),
			anterior=anterior,
			em_falta=em_falta,
			sem_tarifa=sem_tarifa,
			problemas=problemas,
			estado=estado,
			agenda=dict(ag, data=data_exec),
			faturas=[dict(name=f.name, docstatus=f.docstatus, net_total=f.net_total,
				grand_total=f.grand_total) for f in faturas],
			run=run and dict(name=run.name, registo=run.registo_automatico),
			extras=extras.get(c, []),
			linhas=[dict(project=l["project"], regime=l["regime"], categoria=l.get("categoria") or "",
				descricao=l["descricao"],
				metodo=l["metodo"], quantidade=l["quantidade"], vigilantes=l.get("vigilantes"),
				quantidade_contratada=l["quantidade_contratada"],
				valor_unitario=l["valor_unitario"], origem_tarifa=l.get("origem_tarifa") or "",
				linha_unica=l.get("linha_unica") or 0,
				total=l["total"]) for l in lns],
		))

	return dict(
		mes=mes,
		hoje=hoje,
		company=company,
		automatica_geral=bool(cint(frappe.db.get_single_value("SIGOS Settings", "faturacao_automatica"))),
		submeter=bool(cint(frappe.db.get_single_value("SIGOS Settings", "submeter_faturas_automaticas"))),
		snapshot_activos=bool(activos_contratos),
		erros=verif["erros"],
		avisos=verif["avisos"],
		clientes=out,
	)


def _faturas_extra(company, mes, clientes):
	"""
	{cliente: [SI]} — the month's other invoices: no SIGOS stamp (extra services,
	one-offs), posted in the month, not cancelled, not credit notes. They never
	count for the double-billing guard; listed only so the month is complete.
	"""
	if not (company and clientes):
		return {}
	out = {}
	for si in frappe.db.sql("""
		SELECT name, customer, docstatus, net_total, grand_total, posting_date
		FROM `tabSales Invoice`
		WHERE company = %(company)s AND customer IN %(clientes)s
		  AND docstatus < 2 AND is_return = 0
		  AND custom_mes_referencia IS NULL
		  AND IFNULL(custom_faturacao_mensal, '') = ''
		  AND posting_date BETWEEN %(mes)s AND %(fim)s
		ORDER BY posting_date, name
	""", {"company": company, "clientes": tuple(clientes),
			"mes": get_first_day(mes), "fim": get_last_day(mes)}, as_dict=True):
		out.setdefault(si.customer, []).append(dict(name=si.name, docstatus=si.docstatus,
			net_total=si.net_total, grand_total=si.grand_total, posting_date=si.posting_date))
	return out


@frappe.whitelist()
def executar_faturacao_automatica_agora():
	"""'Executar Agora' on the page: run today's automatic billing in the background."""
	frappe.only_for(("System Manager", "SIGOS Manager"))
	if not cint(frappe.db.get_single_value("SIGOS Settings", "faturacao_automatica")):
		frappe.throw(_("A Faturação Automática está desactivada nas Definições SIGOS."))
	frappe.enqueue("sigos.faturacao.executar_faturacao_automatica", queue="long", timeout=3600)
	return True


# ─── Automatic billing job (daily) ───────────────────────────────────────────

def executar_faturacao_automatica(data=None):
	"""
	Bill every opted-in customer whose billing day has arrived this month and that
	has no SIGOS invoice yet for the month it bills. Each attempt is a Faturacao
	Mensal run flagged `automatica` (audit trail + what the page shows):
	  - a run that already generated invoices is never repeated — so an automatic
	    invoice someone CANCELLED stays cancelled instead of coming back the next day;
	  - a run blocked by a problem is reused and retried on the following days
	    (catch-up) until the month ends; after that the month must be billed by hand.
	Drafts by default; submitted when SIGOS Settings asks for it.
	"""
	if not cint(frappe.db.get_single_value("SIGOS Settings", "faturacao_automatica")):
		return
	if frappe.cache().get_value(_LOCK_AUTO):
		return   # a run is already in progress (daily job vs. 'Executar Agora')
	frappe.cache().set_value(_LOCK_AUTO, 1, expires_in_sec=3600)
	try:
		_executar_faturacao_automatica(getdate(data or nowdate()))
	finally:
		frappe.cache().delete_value(_LOCK_AUTO)


def _executar_faturacao_automatica(hoje):
	company = empresa_faturacao()
	if not company:
		frappe.log_error("Faturação automática: defina a Empresa Padrão nas Definições SIGOS.",
			"SIGOS Faturação Automática")
		return

	clientes = _clientes_automaticos()
	agenda = _agenda_clientes(clientes)
	submeter = cint(frappe.db.get_single_value("SIGOS Settings", "submeter_faturas_automaticas"))

	resumo = dict(criadas=[], submetidas=[], nao_submetidas={}, problemas={}, runs=[])
	for cliente in clientes:
		ag = agenda[cliente]
		if hoje < _dia_no_mes(hoje, ag.dia):
			continue
		mes = _mes_da_execucao(hoje, ag.mes_faturado)
		run = _runs_automaticos(company, mes, [cliente]).get(cliente)
		if run and run.faturas_geradas:
			continue
		if _clientes_ja_faturados(company, mes, {cliente}):
			continue   # billed by hand (or another route) already

		linhas, activos = calcular_linhas(cliente, mes)
		if not any(l["quantidade"] and l["valor_unitario"] for l in linhas):
			continue   # nothing billable — the page shows it as 'Sem linhas'

		n_msgs = len(frappe.local.message_log)
		try:
			doc = frappe.get_doc("Faturacao Mensal", run.name) if run else frappe.get_doc({
				"doctype": "Faturacao Mensal",
				"cliente": cliente,
				"company": company,
				"mes_referencia": mes,
				"automatica": 1,
			}).insert(ignore_permissions=True)
			doc.preview()
			r = doc._gerar(submeter=submeter)
			del frappe.local.message_log[n_msgs:]   # preview/insert popups mean nothing here

			motivos = r["erros"] + r["problemas"].get(cliente, []) + r["falhas"].get(cliente, [])
			registo = [_("{0}: execução automática ({1}).").format(
				formatdate(hoje), formatdate(mes, "MMMM yyyy"))]
			if r["criadas"]:
				registo.append(_("Criada(s): {0}{1}").format(", ".join(r["criadas"]),
					_(" — submetida(s)") if r["submetidas"] else ""))
			if r["criadas"] and activos and get_last_day(mes) < hoje:
				registo.append(_("Atenção: contratos em Vigilantes Activos contados com o efectivo de "
					"hoje, não o de {0} — confirme as quantidades.").format(formatdate(mes, "MMMM yyyy")))
			for m in r["nao_submetidas"].get(cliente, []):
				registo.append(_("Não submetida (fica em rascunho): {0}").format(m))
			for m in motivos:
				registo.append(_("Não facturado: {0}").format(strip_html(cstr(m))))
			doc.db_set("registo_automatico", "\n".join(registo), update_modified=False)
			frappe.db.commit()

			resumo["runs"].append(doc.name)
			resumo["criadas"] += r["criadas"]
			resumo["submetidas"] += r["submetidas"]
			resumo["nao_submetidas"].update(r["nao_submetidas"])
			if motivos:
				resumo["problemas"][cliente] = [strip_html(cstr(m)) for m in motivos]
		except Exception as e:
			frappe.db.rollback()
			del frappe.local.message_log[n_msgs:]
			resumo["problemas"][cliente] = [strip_html(cstr(e)) or e.__class__.__name__]
			frappe.log_error(title=f"SIGOS Faturação Automática: {cliente}")

	_notificar_faturacao_automatica(hoje, resumo)


def _notificar_faturacao_automatica(hoje, resumo):
	"""One Notification Log per billing user summarising the day's automatic run."""
	if not (resumo["criadas"] or resumo["problemas"] or resumo["nao_submetidas"]):
		return
	partes = []
	if resumo["criadas"]:
		estado = _("submetida(s)") if resumo["submetidas"] else _("em rascunho")
		partes.append(_("<b>{0}</b> factura(s) criada(s) {1}: {2}").format(
			len(resumo["criadas"]), estado, ", ".join(resumo["criadas"])))
	if resumo["nao_submetidas"]:
		partes.append(_("Ficaram em rascunho (submissão falhou):<br>{0}").format(
			_fmt_problemas(resumo["nao_submetidas"])))
	if resumo["problemas"]:
		partes.append(_("<b>Não facturados</b> — corrija e a tarefa tenta de novo amanhã:<br>{0}").format(
			_fmt_problemas(resumo["problemas"])))
	partes.append(_('Ver a <a href="/app/previsao-de-faturacao">Previsão de Faturação</a>.'))

	if resumo["problemas"]:
		assunto = _("Faturação automática {0}: {1} criada(s), {2} com problemas").format(
			formatdate(hoje), len(resumo["criadas"]), len(resumo["problemas"]))
	else:
		assunto = _("Faturação automática {0}: {1} factura(s) criada(s)").format(
			formatdate(hoje), len(resumo["criadas"]))

	utilizadores = set(frappe.get_all("Has Role",
		filters={"role": ["in", list(PAPEIS_FATURACAO)], "parenttype": "User"}, pluck="parent"))
	utilizadores = [u for u in utilizadores if u not in ("Administrator", "Guest")
		and frappe.db.get_value("User", u, "enabled")]
	um_run = resumo["runs"][0] if len(resumo["runs"]) == 1 else None
	for user in utilizadores:
		try:
			frappe.get_doc({
				"doctype": "Notification Log",
				"subject": assunto,
				"email_content": "<br><br>".join(partes),
				"for_user": user,
				"type": "Alert",
				"document_type": "Faturacao Mensal" if um_run else None,
				"document_name": um_run,
			}).insert(ignore_permissions=True)
		except Exception:
			frappe.log_error(title="SIGOS Faturação Automática: notificação")
	frappe.db.commit()
