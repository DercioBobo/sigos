"""
Self-contained smoke test for the whole Rotatividade arc.

Run on the server:
    bench --site erpnext-site execute sigos.tests.smoke_rotatividade.run

It creates isolated SMOKE-* data, exercises the keystone cascade, the operation
master, the preview endpoint and the on_submit engine across TPV / APV / DEM, asserts
every cascade, prints a PASS/FAIL report, then deletes everything it created.
Safe to re-run — it cleans up leftovers from a previous run first.
"""
import frappe
from frappe.utils import today, add_days

PFX = "SMOKE-ROT"
_created = []          # (doctype, name) in creation order — torn down in reverse
_checks = []           # (label, ok, detail)


# ─── helpers ──────────────────────────────────────────────────────────────────

def _ok(label, cond, detail=""):
	_checks.append((label, bool(cond), detail))


def _track(doc):
	_created.append((doc.doctype, doc.name))
	return doc


def _first_or_make_company():
	c = frappe.get_all("Company", limit=1)
	if c:
		return c[0].name
	doc = frappe.get_doc({"doctype": "Company", "company_name": f"{PFX} Co", "default_currency": "MZN",
	                      "country": "Mozambique", "abbr": "SMK"}).insert(ignore_permissions=True)
	return _track(doc).name


def _first_or_make_customer():
	c = frappe.get_all("Customer", limit=1)
	if c:
		return c[0].name
	doc = frappe.get_doc({"doctype": "Customer", "customer_name": f"{PFX} Client",
	                      "customer_type": "Company"}).insert(ignore_permissions=True)
	return _track(doc).name


def _make_delegacao():
	name = f"{PFX}-DEL"
	if frappe.db.exists("Delegacao", name):
		return name
	# Delegacao autoname — try common field names
	doc = frappe.new_doc("Delegacao")
	for f in ("nome", "delegacao", "nome_da_delegacao"):
		if doc.meta.has_field(f):
			doc.set(f, name)
	doc.insert(ignore_permissions=True)
	return _track(doc).name


def _make_posto(suffix, cliente, delegacao, vagas=10):
	doc = frappe.new_doc("Posto De Vigilancia")
	doc.nome_do_posto = f"{PFX}-{suffix}"
	doc.estado = "Activo"
	doc.tipo_de_posto = "Permanente"
	doc.data_de_abertura = today()
	doc.numero_de_vagas = vagas
	doc.cliente = cliente
	doc.delegacao = delegacao
	doc.insert(ignore_permissions=True)
	return _track(doc).name


def _make_vigilante(suffix, posto, regime, categoria, delegacao, empresa):
	doc = frappe.new_doc("Vigilante")
	doc.nome_completo = f"{PFX} {suffix}"
	doc.sexo = "Masculino"
	doc.data_de_nascimento = "1990-01-01"
	doc.data_admissao = add_days(today(), -200)   # past the 3-month rule
	doc.empresa = empresa
	doc.delegacao = delegacao
	doc.categoria = categoria
	doc.regime_do_vigilante = regime
	doc.posto_de_vigilancia = posto
	doc.status = "Activo"
	doc.insert(ignore_permissions=True)
	return _track(doc).name


def _escala_do_par(posto, regime):
	return frappe.db.get_value(
		"Escala Do Vigilante",
		{"posto_de_vigilancia": posto, "regime_do_vigilante": regime, "estado": ["!=", "Arquivado"]},
		"name",
	)


def _guard_in_escala(escala, vigilante):
	return bool(escala and frappe.db.exists(
		"Tab Vigilante Do Posto", {"parent": escala, "vigilante": vigilante}))


def _submit_rotatividade(**kw):
	doc = frappe.get_doc(dict(doctype="Rotatividade", data=today(), **kw))
	doc.insert(ignore_permissions=True)
	_track(doc)
	doc.submit()
	return doc


# ─── cleanup ──────────────────────────────────────────────────────────────────

def _cleanup_previous():
	# Remove anything left from an earlier run, in safe order.
	for dt in ["Rotatividade", "Demissao", "Escala Do Vigilante", "Vigilante",
	           "Posto De Vigilancia", "Delegacao"]:
		field = "nome_do_posto" if dt == "Posto De Vigilancia" else (
			"nome_completo" if dt == "Vigilante" else "name")
		try:
			rows = frappe.get_all(dt, filters=[[field, "like", f"%{PFX}%"]], pluck="name") \
				if dt in ("Posto De Vigilancia", "Vigilante") else \
				frappe.get_all(dt, filters=[["name", "like", f"%{PFX}%"]], pluck="name")
		except Exception:
			rows = []
		for n in rows:
			_force_delete(dt, n)
	# Employees created for smoke vigilantes
	for n in frappe.get_all("Employee", filters=[["employee_name", "like", f"%{PFX}%"]], pluck="name"):
		_force_delete("Employee", n)
	frappe.db.commit()


def _force_delete(dt, name):
	try:
		doc = frappe.get_doc(dt, name)
		if doc.docstatus == 1:
			doc.flags.ignore_permissions = True
			doc.cancel()
		frappe.delete_doc(dt, name, force=True, ignore_permissions=True, delete_permanently=True)
	except Exception:
		pass


def _teardown():
	# Unlink vigilantes from postos/escala first so deletes don't get blocked
	for dt, name in reversed(_created):
		_force_delete(dt, name)
	# Also clean any escalas auto-created during the run
	for n in frappe.get_all("Escala Do Vigilante",
	                        filters=[["posto_de_vigilancia", "like", f"%{PFX}%"]], pluck="name"):
		_force_delete("Escala Do Vigilante", n)
	for n in frappe.get_all("Employee", filters=[["employee_name", "like", f"%{PFX}%"]], pluck="name"):
		_force_delete("Employee", n)
	frappe.db.commit()


# ─── the test ─────────────────────────────────────────────────────────────────

def run():
	import traceback
	frappe.flags.in_test = True
	try:
		_cleanup_previous()
	except Exception as e:
		_ok("setup: cleanup previous run", False, str(e))
	try:
		_run_scenarios()
	except Exception:
		frappe.db.rollback()
		_ok("scenarios completed without error", False, traceback.format_exc().splitlines()[-1])
	finally:
		try:
			_teardown()
		except Exception as e:
			print("teardown error:", e)
		_report()


def _run_scenarios():
	from sigos.api import preview_rotatividade

	company  = _first_or_make_company()
	customer = _first_or_make_customer()
	deleg    = _make_delegacao()

	posto_a = _make_posto("A", customer, deleg)
	posto_b = _make_posto("B", customer, deleg)
	posto_c = _make_posto("C", customer, deleg)

	# Guards
	main = _make_vigilante("MAIN", posto_a, "H24", "Vigilante Normal", deleg, company)
	subv = _make_vigilante("SUB",  posto_c, "H24", "Vigilante Normal", deleg, company)
	demv = _make_vigilante("DEMV", posto_b, "H24", "Vigilante Normal", deleg, company)
	frappe.db.commit()

	# Keystone sanity: creating an active guard auto-builds the (posto,regime) escala
	esc_a = _escala_do_par(posto_a, "H24")
	_ok("Keystone: escala auto-created for new guard's posto", esc_a and _guard_in_escala(esc_a, main),
	    f"esc_a={esc_a}")

	# ── PREVIEW (dry-run, no write) ──
	pv = preview_rotatividade(vigilante=main, abreviatura_op="TPV",
	                          novo_posto=posto_b, novo_regime="TDU")
	_ok("Preview: returns change rows", len(pv.get("mudancas", [])) >= 2, str(pv.get("mudancas")))
	_ok("Preview: escala move computed", pv.get("escala") and pv["escala"].get("entra_criada") in (True, False),
	    str(pv.get("escala")))
	_ok("Preview: no write happened (guard still at posto A)",
	    frappe.db.get_value("Vigilante", main, "posto_de_vigilancia") == posto_a)

	# ── TPV: posto + regime change ──
	_submit_rotatividade(vigilante=main, abreviatura_op="TPV", delegacao=deleg,
	                     regime="H24", categoria_vigilante="Vigilante Normal",
	                     novo_posto=posto_b, novo_regime="TDU", motivo="Transferência")
	frappe.db.commit()

	_ok("TPV: guard moved to posto B", frappe.db.get_value("Vigilante", main, "posto_de_vigilancia") == posto_b)
	_ok("TPV: guard regime is TDU", frappe.db.get_value("Vigilante", main, "regime_do_vigilante") == "TDU")
	old_pair = _escala_do_par(posto_a, "H24")
	_ok("TPV: removed from old (A,H24) escala", not _guard_in_escala(old_pair, main), f"old={old_pair}")
	new_pair = _escala_do_par(posto_b, "TDU")
	_ok("TPV: added to new (B,TDU) escala", _guard_in_escala(new_pair, main), f"new={new_pair}")
	_ok("TPV: new escala has generated day-rows",
	    new_pair and frappe.db.count("Tabela De Escala De Vigilante", {"parent": new_pair, "vigilante": main}) > 0)

	# ── APV: swap — move main B→C, substituto takes vacated B ──
	_submit_rotatividade(vigilante=main, abreviatura_op="APV", delegacao=deleg,
	                     regime="TDU", categoria_vigilante="Vigilante Normal",
	                     novo_posto=posto_c, novo_vigilante=subv, alocado_ao_posto=posto_b,
	                     alocar_vigilante_substituto="Sim", motivo="Transferência")
	frappe.db.commit()

	_ok("APV: main moved to posto C", frappe.db.get_value("Vigilante", main, "posto_de_vigilancia") == posto_c)
	_ok("APV: substituto took vacated posto B",
	    frappe.db.get_value("Vigilante", subv, "posto_de_vigilancia") == posto_b)

	# ── DEM: demissão via rotatividade ──
	_submit_rotatividade(vigilante=demv, abreviatura_op="DEM", delegacao=deleg,
	                     regime="H24", categoria_vigilante="Vigilante Normal",
	                     motivo="Demissão", motiv_demi="Fim de Contrato", uniforme="Sim")
	frappe.db.commit()

	_ok("DEM: guard status is Demitido", frappe.db.get_value("Vigilante", demv, "status") == "Demitido")
	_ok("DEM: Demissao document created", frappe.db.exists("Demissao", {"vigilante": demv}))
	esc_demv = _escala_do_par(posto_b, "H24")
	_ok("DEM: removed from escala", not _guard_in_escala(esc_demv, demv), f"esc={esc_demv}")


def _report():
	print("\n" + "=" * 60)
	print("  SIGOS — Rotatividade smoke test")
	print("=" * 60)
	passed = sum(1 for _, ok, _ in _checks if ok)
	for label, ok, detail in _checks:
		mark = "PASS" if ok else "FAIL"
		line = f"  [{mark}] {label}"
		if not ok and detail:
			line += f"   ({detail})"
		print(line)
	print("-" * 60)
	print(f"  {passed}/{len(_checks)} checks passed")
	print("=" * 60 + "\n")
