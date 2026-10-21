"""
Saúde SIGOS — one page (security_ops/page/saude_sigos) listing what needs attention
across the system: postos desfalcados, guards over the faltas limit, missing
salaries, overdue invoices…

Each check is one registered function (sigos/saude/verificacoes.py) returning rows:

	@verificacao("chave", "grupo", "Título", CRITICO, papeis=(...), descricao="...")
	def chave():
		return [linha("Vigilante", v.name, v.nome_completo, ...), ...]

and may declare fixes, run on one row or in bulk:

	@correcao("chave", "accao", "Rótulo", papeis=(...), em_massa=True, confirmar="...", campos=[...])
	def _accao(nome, params):
		... call the EXISTING domain function (never raw DB writes) ...
		return "texto do resultado"

Rules:
  - a check is visible only to its `papeis`; a fix needs its own `papeis` too, and the
    server re-checks both on every call;
  - a fix only acts on rows the check flags right now (re-computed, not trusted from
    the browser);
  - each row runs in its own savepoint — one failure never undoes the others; more
    than LOTE_SINCRONO rows go to a background job (result via realtime + bell);
  - rows are cached CACHE_SEGUNDOS per check (global, filtered per request);
  - a row can be ignored (forever or until a date) with a reason: Excecao De Saude.
"""

import json

import frappe
from frappe import _
from frappe.utils import cint, getdate, strip_html_tags, today

CRITICO, AVISO, INFO = "critico", "aviso", "info"
_PESO = {CRITICO: 3, AVISO: 2, INFO: 1}

GRUPOS = (
	("operacoes", "Operações"),
	("abandono", "Abandono"),
	("doenca", "Doença e Suspensões"),
	("disciplinar", "Disciplinar"),
	("salarios", "Salários"),
	("rh", "RH e Cadastro"),
	("armamento", "Armamento e Material"),
	("faturacao", "Faturação"),
)

CACHE_SEGUNDOS = 300
LOTE_SINCRONO = 25
EXCECAO = "Excecao De Saude"

_VERIFICACOES = {}


# ─── Registry ───────────────────────────────────────────────────────────────────

def verificacao(chave, grupo, titulo, severidade, papeis, descricao=None):
	def deco(fn):
		_VERIFICACOES[chave] = frappe._dict(
			chave=chave, grupo=grupo, titulo=titulo, severidade=severidade,
			papeis=set(papeis) | {"System Manager"}, descricao=descricao or "",
			fn=fn, correcoes={}, ordem=len(_VERIFICACOES),
		)
		return fn
	return deco


def correcao(verif, chave, rotulo, papeis, em_massa=True, confirmar=None, campos=None, perigosa=False):
	"""`campos`: Frappe dialog fields asked once for the whole run (passed as params)."""
	def deco(fn):
		_VERIFICACOES[verif].correcoes[chave] = frappe._dict(
			chave=chave, rotulo=rotulo, papeis=set(papeis) | {"System Manager"},
			em_massa=em_massa, confirmar=confirmar or "", campos=campos or [],
			perigosa=perigosa, fn=fn,
		)
		return fn
	return deco


def linha(doctype, name, titulo, codigo=None, detalhe="", delegacao=None, dias=None, nivel=None,
		link=None):
	"""One flagged row. `name` is the key the fixes act on; `link` = (doctype, name)
	when the record to open differs from it; `nivel` overrides the check severity."""
	return frappe._dict(
		doctype=doctype, name=name, titulo=titulo or name, codigo=codigo or "",
		detalhe=detalhe or "", delegacao=delegacao, dias=dias, nivel=nivel,
		link_doctype=(link or (doctype, name))[0], link_name=(link or (doctype, name))[1],
	)


# ─── Engine ─────────────────────────────────────────────────────────────────────

def _papeis():
	return set(frappe.get_roles())


def _visivel(v, papeis=None):
	return bool((papeis or _papeis()) & v.papeis)


def _obter(chave):
	v = _VERIFICACOES.get(chave)
	if not v or not _visivel(v):
		frappe.throw(_("Verificação não encontrada ou sem permissão."), frappe.PermissionError)
	return v


def _chave_cache(chave):
	return f"sigos_saude:{chave}"


def _calcular(v, forcar=False):
	"""Rows of a check (cached). Raises on a broken check — callers decide."""
	if not forcar:
		em_cache = frappe.cache().get_value(_chave_cache(v.chave))
		if em_cache is not None:
			return [frappe._dict(r) for r in em_cache]
	linhas = v.fn() or []
	vistos, unicas = set(), []
	for r in linhas:
		if r.name not in vistos:
			vistos.add(r.name)
			unicas.append(r)
	# Most urgent first: row level, then `dias` (age / days overdue).
	unicas.sort(key=lambda r: (-_PESO[r.nivel or v.severidade], -(r.dias if r.dias is not None else -10**6)))
	frappe.cache().set_value(_chave_cache(v.chave), [dict(r) for r in unicas],
		expires_in_sec=CACHE_SEGUNDOS)
	return unicas


def limpar_cache():
	for chave in _VERIFICACOES:
		frappe.cache().delete_value(_chave_cache(chave))


def _excecoes(chave=None):
	"""{(verificacao, referencia): excecao} still in force (no end date, or not past it)."""
	if not frappe.db.table_exists(EXCECAO):
		return {}
	filtros = {"verificacao": chave} if chave else {}
	hoje = getdate(today())
	return {
		(e.verificacao, e.referencia): e
		for e in frappe.get_all(EXCECAO, filters=filtros,
			fields=["name", "verificacao", "referencia", "ate", "motivo", "owner", "creation"])
		if not e.ate or getdate(e.ate) >= hoje
	}


def _filtrar(linhas, delegacao):
	# Rows without a delegação (contracts, invoices…) are company-wide: always shown.
	if not delegacao:
		return linhas
	return [r for r in linhas if not r.get("delegacao") or r.get("delegacao") == delegacao]


def _nivel(v, linhas):
	if not linhas:
		return None
	return max((r.get("nivel") or v.severidade for r in linhas), key=lambda n: _PESO[n])


def _meta(v, papeis):
	return dict(
		chave=v.chave, grupo=v.grupo, titulo=_(v.titulo), descricao=_(v.descricao),
		severidade=v.severidade,
		correcoes=[
			dict(chave=c.chave, rotulo=_(c.rotulo), em_massa=c.em_massa, confirmar=_(c.confirmar),
				campos=c.campos, perigosa=c.perigosa)
			for c in v.correcoes.values() if papeis & c.papeis
		],
	)


# ─── API ────────────────────────────────────────────────────────────────────────

@frappe.whitelist()
def resumo(delegacao=None, actualizar=0):
	"""Sidebar + counts: every check the user may see, with its open rows count."""
	papeis = _papeis()
	visiveis = sorted((v for v in _VERIFICACOES.values() if _visivel(v, papeis)),
		key=lambda v: v.ordem)
	if not visiveis:
		frappe.throw(_("Sem permissão para a Saúde SIGOS."), frappe.PermissionError)
	if cint(actualizar):
		limpar_cache()
	excecoes = _excecoes()
	verifs, delegacoes = [], set()
	for v in visiveis:
		m = _meta(v, papeis)
		try:
			todas = _calcular(v)
			delegacoes.update(r.delegacao for r in todas if r.get("delegacao"))
			linhas = _filtrar(todas, delegacao)
			abertas = [r for r in linhas if (v.chave, r.name) not in excecoes]
			m.update(total=len(abertas), ignorados=len(linhas) - len(abertas),
				nivel=_nivel(v, abertas), erro=None)
		except Exception as e:
			frappe.log_error(f"Saúde SIGOS — {v.chave}: {frappe.get_traceback()}", "SIGOS Saúde")
			m.update(total=0, ignorados=0, nivel=None, erro=strip_html_tags(str(e))[:200])
		verifs.append(m)
	return dict(
		grupos=[dict(chave=g, titulo=_(t)) for g, t in GRUPOS if any(m["grupo"] == g for m in verifs)],
		verificacoes=verifs,
		delegacoes=sorted(delegacoes),
		hoje=today(),
	)


@frappe.whitelist()
def linhas(chave, delegacao=None, ignorados=0):
	"""Rows of one check. ignorados=1 returns the ignored ones (with who/why/until)."""
	v = _obter(chave)
	excecoes = _excecoes(chave)
	todas = _filtrar(_calcular(v), delegacao)
	if cint(ignorados):
		out = []
		for r in todas:
			e = excecoes.get((chave, r.name))
			if e:
				out.append(dict(r, excecao=dict(motivo=e.motivo, ate=e.ate, por=e.owner,
					em=e.creation)))
		return out
	return [r for r in todas if (chave, r.name) not in excecoes]


@frappe.whitelist()
def executar(chave, correcao, nomes, params=None):
	v = _obter(chave)
	c = v.correcoes.get(correcao)
	if not c or not (_papeis() & c.papeis):
		frappe.throw(_("Sem permissão para esta acção."), frappe.PermissionError)
	nomes = _lista(nomes)
	params = frappe._dict(json.loads(params) if isinstance(params, str) else (params or {}))
	if not nomes:
		frappe.throw(_("Seleccione pelo menos uma linha."))
	if len(nomes) > 1 and not c.em_massa:
		frappe.throw(_("Esta acção é feita uma linha de cada vez."))
	for campo in c.campos:
		if campo.get("reqd") and not params.get(campo["fieldname"]):
			frappe.throw(_("Preencha {0}.").format(_(campo.get("label") or campo["fieldname"])))

	# Only rows the check flags right now — never trust the list from the browser.
	validos = {r.name for r in _calcular(v, forcar=True)}
	fora = [n for n in nomes if n not in validos]
	nomes = [n for n in nomes if n in validos]
	if not nomes:
		limpar_cache()
		return dict(ok=[], falhas=[], fora=fora)

	if len(nomes) > LOTE_SINCRONO:
		frappe.enqueue("sigos.saude._executar_lote", queue="long", timeout=3600,
			chave=chave, correcao=correcao, nomes=nomes, params=params, em_fundo=True)
		return dict(enfileirado=len(nomes), fora=fora)

	res = _executar_lote(chave, correcao, nomes, params)
	res["fora"] = fora
	return res


def _executar_lote(chave, correcao, nomes, params, em_fundo=False):
	v = _VERIFICACOES[chave]
	c = v.correcoes[correcao]
	ok, falhas = [], []
	for nome in nomes:
		frappe.db.savepoint("sigos_saude")
		try:
			r = c.fn(nome, frappe._dict(params or {}))
			if isinstance(r, dict):
				ok.append(dict(name=nome, msg=strip_html_tags(r.get("msg") or ""), rota=r.get("rota")))
			else:
				ok.append(dict(name=nome, msg=strip_html_tags(str(r or ""))))
			if em_fundo:
				frappe.db.commit()
		except Exception as e:
			frappe.db.rollback(save_point="sigos_saude")
			erro = strip_html_tags(str(e)) or e.__class__.__name__
			falhas.append(dict(name=nome, erro=erro[:300]))
			if not isinstance(e, frappe.ValidationError):
				frappe.log_error(f"Saúde SIGOS {chave}/{correcao} {nome}: {frappe.get_traceback()}",
					"SIGOS Saúde")
		# Domain functions msgprint as they go; the page shows its own summary.
		frappe.local.message_log = []
	limpar_cache()

	if em_fundo:
		resultado = dict(chave=chave, correcao=c.rotulo, ok=len(ok), falhas=falhas[:50])
		frappe.publish_realtime("sigos_saude_lote", resultado, user=frappe.session.user)
		try:
			frappe.get_doc({
				"doctype": "Notification Log",
				"subject": _("Saúde SIGOS: {0} — {1} feito(s), {2} com erro").format(
					_(c.rotulo), len(ok), len(falhas)),
				"email_content": "<br>".join(f"{f['name']}: {f['erro']}" for f in falhas[:30]),
				"for_user": frappe.session.user, "type": "Alert",
			}).insert(ignore_permissions=True)
			frappe.db.commit()
		except Exception:
			frappe.log_error(frappe.get_traceback(), "SIGOS Saúde")
	return dict(ok=ok, falhas=falhas)


@frappe.whitelist()
def ignorar(chave, nomes, motivo, ate=None):
	v = _obter(chave)
	motivo = (motivo or "").strip()
	if not motivo:
		frappe.throw(_("Indique o motivo."))
	if ate and getdate(ate) < getdate(today()):
		frappe.throw(_("A data tem de ser hoje ou depois."))
	titulos = {r.name: r.titulo for r in _calcular(v)}
	ja = _excecoes(chave)
	n = 0
	for nome in _lista(nomes):
		if (chave, nome) in ja:
			continue
		frappe.get_doc({
			"doctype": EXCECAO, "verificacao": chave, "titulo_verificacao": v.titulo,
			"referencia": nome, "descricao": titulos.get(nome) or nome,
			"ate": ate or None, "motivo": motivo,
		}).insert(ignore_permissions=True)
		n += 1
	return n


@frappe.whitelist()
def restaurar(chave, nomes):
	_obter(chave)
	nomes = _lista(nomes)
	for nome in frappe.get_all(EXCECAO, filters={"verificacao": chave, "referencia": ["in", nomes]},
			pluck="name"):
		frappe.delete_doc(EXCECAO, nome, ignore_permissions=True)
	return len(nomes)


def _lista(nomes):
	if isinstance(nomes, str):
		nomes = json.loads(nomes) if nomes.strip().startswith("[") else [nomes]
	return list(dict.fromkeys(n for n in (nomes or []) if n))


def limpar_excecoes_expiradas():
	"""Daily: drop exceptions past their end date (the row shows up again)."""
	if not frappe.db.table_exists(EXCECAO):
		return
	for nome in frappe.get_all(EXCECAO, filters={"ate": ["<", today()]}, pluck="name"):
		frappe.delete_doc(EXCECAO, nome, ignore_permissions=True)


from sigos.saude import verificacoes  # noqa: E402,F401  (registers the checks)
