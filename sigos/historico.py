"""
Histórico do Vigilante — everything that happened with a guard, as one typed,
chronological feed for the "Histórico do Vigilante" page (and the Diretório tab).

Built from the SOURCE documents (not the timeline Comments): every event has a
category, its real date, a state and a link — so the UI can filter, and records
older than the Comment log show up too. The summary on top of the page comes from
sigos.disciplinar.dossie.dossie_vigilante (same numbers as the PD's Ficha).

High-volume sources are grouped per month (faltas, coberturas feitas, turnos
extras) with the individual lines in `itens`, so a long career stays readable.
Salary categories are only returned to salary roles (dossie.PAPEIS_DOSSIE_SALARIO).
"""

import frappe
from frappe import _
from frappe.utils import add_months, flt, getdate, nowdate

from sigos.disciplinar.dossie import PAPEIS_DOSSIE, PAPEIS_DOSSIE_SALARIO

LIMITE = 500  # per source; plenty for a guard, keeps the page fast
MESES = ["", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto",
	"Setembro", "Outubro", "Novembro", "Dezembro"]

CATEGORIAS = [
	("operacoes", "Operações"),
	("assiduidade", "Assiduidade"),
	("disciplinar", "Disciplinar"),
	("carreira", "Carreira"),
	("salario", "Salário"),
	("material", "Material"),
]


@frappe.whitelist()
def historico_vigilante(vigilante, de=None, ate=None, incluir_cancelados=0):
	frappe.only_for(PAPEIS_DOSSIE)
	if not vigilante or not frappe.db.exists("Vigilante", vigilante):
		frappe.throw(_("Vigilante não encontrado."))
	h = _Historico(vigilante, de, ate, frappe.utils.cint(incluir_cancelados))
	h.recolher()
	return h.resultado()


@frappe.whitelist()
def hoje_vigilante(vigilante):
	"""Header chip: the guard's escala today (active escalas) — turno, período, posto,
	folga — plus an absence already registered for today (submitted Ausências)."""
	frappe.only_for(PAPEIS_DOSSIE)
	hoje = getdate(nowdate())
	turnos = frappe.db.sql("""
		SELECT te.turno, COALESCE(NULLIF(te.periodo, ''), t.periodo) AS periodo,
		       COALESCE(t.e_folga, 0) AS e_folga, te.posto, p.nome_do_posto
		FROM `tabTabela De Escala De Vigilante` te
		JOIN `tabEscala Do Vigilante` e ON e.name = te.parent AND e.estado = 'Activo'
		LEFT JOIN `tabTurno` t ON t.name = te.turno
		LEFT JOIN `tabPosto De Vigilancia` p ON p.name = te.posto
		WHERE te.vigilante = %(v)s AND te.data = %(d)s
		ORDER BY t.e_folga, te.turno""", {"v": vigilante, "d": hoje}, as_dict=True)
	ausencia = frappe.db.sql("""
		SELECT ta.tipo_de_ausencia AS tipo, a.name AS doc
		FROM `tabTabela Ausencia` ta JOIN `tabAusencias` a ON a.name = ta.parent
		WHERE a.docstatus = 1 AND a.data = %(d)s AND ta.vigilante = %(v)s
		ORDER BY a.creation DESC LIMIT 1""", {"v": vigilante, "d": hoje}, as_dict=True)
	return {"data": str(hoje), "turnos": turnos, "ausencia": ausencia[0] if ausencia else None}


@frappe.whitelist()
def vigilante_do_employee(employee):
	frappe.only_for(PAPEIS_DOSSIE)
	return frappe.db.get_value("Employee", employee, "custom_vigilante")


class _Historico:
	def __init__(self, vigilante, de, ate, incluir_cancelados):
		self.vig = vigilante
		self.v = frappe.db.get_value("Vigilante", vigilante,
			["name", "funcionario", "data_admissao", "nome_completo"], as_dict=True)
		self.emp = self.v.funcionario
		self.de = getdate(de) if de else None
		self.ate = getdate(ate) if ate else getdate(nowdate())
		self.cancelados = incluir_cancelados
		self.salario = bool(set(frappe.get_roles()) & set(PAPEIS_DOSSIE_SALARIO))
		self.eventos = []

	# ─── plumbing ────────────────────────────────────────────────────────────

	def _docs(self, doctype, filtros, campos, campo_data, order=None):
		"""Rows of `doctype` in the period, with docstatus/workflow_state added."""
		meta = frappe.get_meta(doctype)
		campos = list(dict.fromkeys(["name", campo_data] + campos))
		if meta.is_submittable:
			campos.append("docstatus")
			if not self.cancelados:
				filtros = dict(filtros, docstatus=["<", 2])
		if meta.has_field("workflow_state"):
			campos.append("workflow_state")
		filtros = dict(filtros)
		if self.de:
			filtros[campo_data] = ["between", [self.de, self.ate]]
		else:
			filtros[campo_data] = ["<=", self.ate]
		return frappe.get_all(doctype, filters=filtros, fields=campos,
			order_by=order or f"{campo_data} desc", limit=LIMITE)

	def add(self, cat, tipo, data, titulo, doctype=None, name=None, sub=None, detalhe=None,
			estado=None, tom=None, valor=None, itens=None, row=None, resumo=None):
		if not data:
			return
		rascunho = cancelado = False
		if row is not None and "docstatus" in row:
			rascunho, cancelado = row.docstatus == 0, row.docstatus == 2
			if not estado:
				wf = row.get("workflow_state")
				if cancelado:
					estado, tom = _("Cancelado"), "neutral"
				elif rascunho:
					estado, tom = wf or _("Rascunho"), "amber"
				elif wf and wf not in ("Aprovado",):
					estado = wf
		self.eventos.append({
			"cat": cat, "tipo": tipo, "data": str(getdate(data)), "titulo": titulo,
			"sub": sub, "detalhe": detalhe, "estado": estado, "tom": tom,
			"doctype": doctype, "name": name, "valor": valor, "itens": itens, "resumo": resumo,
			"rascunho": rascunho, "cancelado": cancelado,
		})

	@staticmethod
	def _txt(*partes):
		return " · ".join(p for p in partes if p)

	@staticmethod
	def _d(d):
		return frappe.format_value(d, {"fieldtype": "Date"}) if d else ""

	def _mes(self, d):
		d = getdate(d)
		return f"{MESES[d.month]} {d.year}"

	# ─── sources ─────────────────────────────────────────────────────────────

	def recolher(self):
		for fn in (self._carreira, self._operacoes, self._coberturas_feitas, self._faltas,
				self._assiduidade, self._disciplinar, self._material):
			try:
				fn()
			except Exception:
				frappe.log_error(frappe.get_traceback(), f"SIGOS Histórico {self.vig}: {fn.__name__}")
		if self.salario and self.emp:
			try:
				self._salario()
			except Exception:
				frappe.log_error(frappe.get_traceback(), f"SIGOS Histórico {self.vig}: _salario")

	def _carreira(self):
		adm = self.v.data_admissao
		if adm and (not self.de or getdate(adm) >= self.de) and getdate(adm) <= self.ate:
			self.add("carreira", "admissao", adm, _("Admissão"), "Vigilante", self.vig,
				sub=_("Início de funções"), tom="good")
		for r in self._docs("Troca De Categoria", {"vigilante": self.vig},
				["categoria_atual", "categoria_nova", "motivo"], "data"):
			self.add("carreira", "categoria", r.data, _("Troca de Categoria"), "Troca De Categoria", r.name,
				sub=f"{r.categoria_atual or '—'} → {r.categoria_nova or '—'}", detalhe=r.motivo, row=r)
		for r in self._docs("Troca De Regime", {"vigilante": self.vig},
				["regime_atual", "novo_regime", "motivo"], "data"):
			self.add("carreira", "regime", r.data, _("Troca de Regime"), "Troca De Regime", r.name,
				sub=f"{r.regime_atual or '—'} → {r.novo_regime or '—'}", detalhe=r.motivo, row=r)
		for r in self._docs("Demissao", {"vigilante": self.vig},
				["motivo", "observacoes", "uniforme"], "data_de_demissao"):
			self.add("carreira", "demissao", r.data_de_demissao, _("Demissão"), "Demissao", r.name,
				sub=self._txt(r.motivo, _("Uniforme: {0}").format(r.uniforme) if r.uniforme else None),
				detalhe=r.observacoes, tom="bad", row=r)
		for r in self._docs("Readimissao", {"vigilante": self.vig},
				["motivo_readimissao", "motivo_ultima_demissao"], "data"):
			self.add("carreira", "readmissao", r.data, _("Readmissão"), "Readimissao", r.name,
				sub=_("Última demissão: {0}").format(r.motivo_ultima_demissao or "—"),
				detalhe=r.motivo_readimissao, tom="good", row=r)

	def _operacoes(self):
		for r in self._docs("Rotatividade", {"vigilante": self.vig},
				["abreviatura_op", "motivo", "antigo_posto_nome", "novo_posto_nome", "novo_posto_do_reserva_nome",
				 "motivo_rotatividade", "novo_regime"], "data"):
			destino = r.novo_posto_nome or r.novo_posto_do_reserva_nome or (_("Novo regime {0}").format(r.novo_regime)
				if r.novo_regime else None)
			self.add("operacoes", "rotatividade", r.data, _("Rotatividade — {0}").format(r.abreviatura_op or "—"),
				"Rotatividade", r.name,
				sub=self._txt(f"{r.antigo_posto_nome or '—'} → {destino}" if destino else r.antigo_posto_nome, r.motivo),
				detalhe=r.motivo_rotatividade, row=r)
		for r in self._docs("Rotatividade", {"novo_vigilante": self.vig},
				["abreviatura_op", "vigilante", "alocado_ao_posto_nome", "antigo_posto_nome"], "data"):
			self.add("operacoes", "rotatividade", r.data, _("Alocado ao posto (substituto)"), "Rotatividade", r.name,
				sub=self._txt(r.alocado_ao_posto_nome or r.antigo_posto_nome,
					_("no lugar de {0}").format(r.vigilante) if r.vigilante else None), row=r)

		for r in self._docs("Cobertura De Posto", {"vigilante_coberto": self.vig},
				["tipo_cobertura", "estado", "vigilante_cobridor", "data_fim_prevista", "data_fim_real",
				 "posto_de_vigilancia"], "data_inicio_prevista"):
			self.add("operacoes", "cobertura", r.data_inicio_prevista, _("Posto coberto por outro vigilante"),
				"Cobertura De Posto", r.name,
				sub=self._txt(r.tipo_cobertura, r.vigilante_cobridor and _("cobridor {0}").format(r.vigilante_cobridor),
					_("até {0}").format(self._d(r.data_fim_real or r.data_fim_prevista)) if (r.data_fim_real or r.data_fim_prevista) else None),
				estado=r.estado, tom=_tom_estado(r.estado))
		for r in self._docs("Cobertura De Posto", {"vigilante_cobridor": self.vig},
				["tipo_cobertura", "estado", "vigilante_coberto", "posto_de_vigilancia", "data_fim_prevista"],
				"data_inicio_prevista"):
			self.add("operacoes", "cobertura", r.data_inicio_prevista, _("Cobriu um posto"), "Cobertura De Posto", r.name,
				sub=self._txt(r.posto_de_vigilancia, r.vigilante_coberto and _("de {0}").format(r.vigilante_coberto),
					r.tipo_cobertura),
				estado=r.estado, tom=_tom_estado(r.estado))

		# Turnos Extras — grouped per month
		grupos = {}
		for r in self._docs("Turnos Extras", {"vigilante": self.vig},
				["posto_nome", "posto", "turno", "periodo", "motivo"], "data"):
			grupos.setdefault((getdate(r.data).year, getdate(r.data).month), []).append(r)
		for (_a, _m), linhas in grupos.items():
			ultima = max(getdate(l.data) for l in linhas)
			self.add("operacoes", "turno_extra", ultima,
				_("Turnos extras — {0}").format(self._mes(ultima)),
				sub=_("{0} turno(s) extra(s)").format(len(linhas)),
				itens=[{"data": str(l.data), "texto": self._txt(l.posto_nome or l.posto, l.turno, l.periodo, l.motivo),
					"doctype": "Turnos Extras", "name": l.name,
					"estado": _("Cancelado") if l.get("docstatus") == 2 else (_("Rascunho") if l.get("docstatus") == 0 else None)}
					for l in sorted(linhas, key=lambda x: x.data, reverse=True)])

		# Ocorrências where the guard is involved (child table)
		ocs = frappe.db.sql("""
			SELECT DISTINCT o.name, o.data, o.assunto, o.estado, o.tipo, o.gravidade, o.posto_nome
			FROM `tabOcorrencia` o JOIN `tabOcorrencia Vigilante` c ON c.parent = o.name AND c.parenttype = 'Ocorrencia'
			WHERE c.vigilante = %(v)s AND o.data <= %(ate)s {de}
			ORDER BY o.data DESC LIMIT {lim}
		""".format(de="AND o.data >= %(de)s" if self.de else "", lim=LIMITE),
			{"v": self.vig, "ate": self.ate, "de": self.de}, as_dict=True)
		for r in ocs:
			self.add("operacoes", "ocorrencia", r.data, _("Ocorrência — {0}").format(r.assunto or r.tipo or ""),
				"Ocorrencia", r.name, sub=self._txt(r.tipo, r.posto_nome, r.gravidade and _("gravidade {0}").format(r.gravidade)),
				estado=r.estado, tom=_tom_estado(r.estado))

	def _coberturas_feitas(self):
		"""Shifts the guard covered for absent colleagues (substitute / dobra / meia
		dobra / adiantamento / horas extra), from Ausências — grouped per month."""
		accoes = (("vigilante_substituto", _("Substituição")), ("vigilante_a_dobrar", _("Dobra")),
			("vigilante_a_meia_dobra", _("Meia Dobra")), ("vigilante_a_adiantar", _("Adiantamento")),
			("vigilante_a_horas_extras", _("Horas Extra")))
		cond = " OR ".join(f"ta.{c} = %(v)s" for c, _l in accoes)
		rows = frappe.db.sql("""
			SELECT a.name AS ausencia, a.data, ta.vigilante, ta.nome_do_vigilante, ta.posto, ta.turno,
			       {cols}
			FROM `tabTabela Ausencia` ta JOIN `tabAusencias` a ON a.name = ta.parent
			WHERE a.docstatus = 1 AND ({cond}) AND a.data <= %(ate)s {de}
			ORDER BY a.data DESC LIMIT {lim}
		""".format(cols=", ".join(f"ta.{c}" for c, _l in accoes), cond=cond,
			de="AND a.data >= %(de)s" if self.de else "", lim=LIMITE),
			{"v": self.vig, "ate": self.ate, "de": self.de}, as_dict=True)
		grupos = {}
		for r in rows:
			r["accao"] = next((l for c, l in accoes if r.get(c) == self.vig), "")
			grupos.setdefault((getdate(r.data).year, getdate(r.data).month), []).append(r)
		for linhas in grupos.values():
			ultima = max(getdate(l.data) for l in linhas)
			cont = {}
			for l in linhas:
				cont[l.accao] = cont.get(l.accao, 0) + 1
			self.add("operacoes", "cobertura_feita", ultima, _("Coberturas feitas — {0}").format(self._mes(ultima)),
				sub=" · ".join(f"{n} {k.lower()}" for k, n in cont.items()), tom="good",
				itens=[{"data": str(l.data), "texto": self._txt(l.accao, _("por {0}").format(l.nome_do_vigilante or l.vigilante),
					l.posto, l.turno), "doctype": "Ausencias", "name": l.ausencia} for l in linhas])

	def _faltas(self):
		"""Monthly faltas card. "Justificada" = covered by an APPROVED Justificação De
		Faltas (what payroll takes off); the Ausência's own Tipo de Justificação is only
		the reason noted at registration and is shown as such."""
		from sigos.utils import calcular_faltas_detalhado
		inicio = self.de or getdate(self.v.data_admissao or "2000-01-01")
		linhas = calcular_faltas_detalhado(self.vig, inicio, self.ate)
		self.justificacoes = justificacoes_do_vigilante(self.vig)
		self.faltas_por_justificacao = {}
		grupos = {}
		for r in linhas:
			grupos.setdefault((r["data"].year, r["data"].month), []).append(r)
		for linhas_mes in grupos.values():
			ultima = max(l["data"] for l in linhas_mes)
			e_falta = lambda l: (l.get("tipo_de_ausencia") or "Falta") in ("Falta", "Falta de Reserva", "Abandono de Posto")
			total = just = pend = 0
			vermelhas = 0
			tipos, itens = {}, []
			for l in sorted(linhas_mes, key=lambda x: x["data"], reverse=True):
				falta = e_falta(l)
				n = l["n_de_faltas"] or 0
				ok, espera = cobertura_da_falta(l["data"], self.justificacoes) if falta else (None, None)
				if falta:
					total += n
					if ok:
						just += n
						self.faltas_por_justificacao.setdefault(ok.name, []).append(l)
					elif espera:
						pend += n
						self.faltas_por_justificacao.setdefault(espera.name, []).append(l)
				else:
					tipos[l.get("tipo_de_ausencia")] = tipos.get(l.get("tipo_de_ausencia"), 0) + 1
				vermelha = l.get("subtipo_falta") == "Vermelha"
				vermelhas += 1 if vermelha else 0
				if not falta:
					pill, ptom = None, None
				elif ok:
					pill, ptom = _("Justificada"), "good"
				elif espera:
					pill, ptom = _("Justificação pendente"), "amber"
				else:
					pill, ptom = _("Por justificar"), "bad"
				itens.append({
					"data": str(l["data"]),
					"titulo": (l.get("tipo_de_ausencia") or _("Falta")) + (" " + _("Vermelha") if vermelha else ""),
					"valor": n if falta else None,
					"meta": [x for x in (l.get("turno"), l.get("posto")) if x],
					"nota": _("Motivo indicado: {0}").format(l["tipo_justificacao"]) if l.get("tipo_justificacao") else None,
					"estado": pill, "estado_tom": ptom,
					"doctype": "Ausencias", "name": l.get("ausencia"),
					"links": [{"doctype": "Justificacao De Faltas", "name": (ok or espera).name}] if (ok or espera) else [],
					"tom": "bad" if vermelha else None,
				})
			por = total - just - pend
			sub = self._txt(
				_("{0} falta(s) em {1} dia(s)").format(total, len({l["data"] for l in linhas_mes if e_falta(l)})) if total else None,
				_("{0} vermelha(s)").format(vermelhas) if vermelhas else None,
				*[f"{n} {(t or '').lower()}" for t, n in tipos.items()])
			self.add("assiduidade", "faltas", ultima, _("Ausências — {0}").format(self._mes(ultima)), sub=sub,
				tom="bad" if por >= 3 or vermelhas else ("amber" if por else None), valor=total,
				resumo=[x for x in (
					{"n": just, "label": _("justificada(s)"), "tom": "good"} if just else None,
					{"n": pend, "label": _("em aprovação"), "tom": "amber"} if pend else None,
					{"n": por, "label": _("por justificar"), "tom": "bad"} if por else None,
				) if x] if total else None,
				itens=itens)

	def _assiduidade(self):
		for r in self._docs("Justificacao De Faltas", {"vigilante": self.vig},
				["dia_de_inicio", "dia_de_fim", "numero", "doenca", "observacoes", "fora_de_prazo",
				 "justificacao_fora_de_prazo", "dias_de_atraso"], "data_do_justificativo"):
			cobertas = sorted((getattr(self, "faltas_por_justificacao", {}) or {}).get(r.name, []),
				key=lambda x: x["data"], reverse=True)
			self.add("assiduidade", "justificacao", r.data_do_justificativo, _("Justificação de Faltas"),
				"Justificacao De Faltas", r.name,
				itens=[{"data": str(l["data"]), "titulo": l.get("tipo_de_ausencia") or _("Falta"),
					"valor": l["n_de_faltas"], "meta": [x for x in (l.get("turno"), l.get("posto")) if x],
					"doctype": "Ausencias", "name": l.get("ausencia")} for l in cobertas],
				sub=self._txt(_("{0} a {1}").format(self._d(r.dia_de_inicio), self._d(r.dia_de_fim)),
					_("{0} falta(s)").format(r.numero) if r.numero else None, _("doença") if r.doenca else None,
					_("fora de prazo (+{0} dia(s))").format(r.dias_de_atraso or 0) if r.fora_de_prazo else None),
				detalhe=self._txt(r.observacoes, r.fora_de_prazo and _("Motivo fora de prazo: {0}").format(
					r.justificacao_fora_de_prazo or "-")),
				estado=_("Fora de prazo") if r.fora_de_prazo and r.docstatus == 1 else None,
				tom="amber" if r.fora_de_prazo else ("good" if r.docstatus == 1 else None), row=r)
		pedidos_la = set()
		for r in self._docs("Pedido De Licenca", {"vigilante": self.vig},
				["tipo_de_licenca", "data_inicio", "data_fim", "dias_aprovados", "motivo", "leave_application_ref"],
				"data_pedido"):
			if r.leave_application_ref:
				pedidos_la.add(r.leave_application_ref)
			self.add("assiduidade", "licenca", r.data_inicio or r.data_pedido, _("Licença — {0}").format(r.tipo_de_licenca or ""),
				"Pedido De Licenca", r.name,
				sub=self._txt(_("{0} a {1}").format(self._d(r.data_inicio), self._d(r.data_fim)),
					_("{0} dia(s)").format(flt(r.dias_aprovados, 1)) if r.dias_aprovados else None),
				detalhe=r.motivo, row=r)
		if self.emp:
			for r in self._docs("Leave Application", {"employee": self.emp},
					["leave_type", "from_date", "to_date", "total_leave_days", "status", "description"], "from_date"):
				if r.name in pedidos_la:
					continue
				self.add("assiduidade", "licenca", r.from_date, _("Licença — {0}").format(r.leave_type or ""),
					"Leave Application", r.name,
					sub=self._txt(_("{0} a {1}").format(self._d(r.from_date), self._d(r.to_date)),
						_("{0} dia(s)").format(flt(r.total_leave_days, 1)) if r.total_leave_days else None),
					detalhe=r.description,
					estado=r.status if r.status != "Approved" else None, tom=_tom_estado(r.status), row=r)
		for r in self._docs("Baixa Medica", {"vigilante": self.vig},
				["data_regresso", "dias", "estado", "pago_por", "observacoes"], "data_inicio"):
			self.add("assiduidade", "baixa", r.data_inicio, _("Baixa Médica"), "Baixa Medica", r.name,
				sub=self._txt(_("regresso {0}").format(self._d(r.data_regresso)) if r.data_regresso else _("em curso"),
					_("{0} dia(s)").format(r.dias) if r.dias else None, r.pago_por and _("paga por {0}").format(r.pago_por)),
				detalhe=r.observacoes, estado=r.estado, tom="amber" if r.estado == "Em Curso" else None)
		for r in self._docs("Presuncao De Abandono", {"vigilante": self.vig},
				["estado", "primeira_falta", "total_faltas", "total_dias", "posto_de_vigilancia", "processo_disciplinar"],
				"data_deteccao"):
			self.add("assiduidade", "abandono", r.data_deteccao, _("Presunção de Abandono"), "Presuncao De Abandono", r.name,
				sub=self._txt(_("ausente desde {0}").format(self._d(r.primeira_falta)) if r.primeira_falta else None,
					_("{0} falta(s)").format(r.total_faltas) if r.total_faltas else None, r.posto_de_vigilancia),
				estado=r.estado, tom="bad" if r.estado in ("Aberta", "Em Análise", "Encaminhada para Processo") else None)

	def _disciplinar(self):
		parts = self._docs("Participacao", {"vigilante": self.vig},
			["gravidade", "tipo_de_infracao", "relato", "posto_nome", "suspensao_desde", "suspensao_ate",
			 "suspensao_remuneracao", "processo_disciplinar", "repreensao", "termo_responsabilidade", "denuncia", "recusada", "motivo_recusa"], "data")
		infr = {}
		for row in frappe.get_all("Participacao Infracao",
				filters={"parenttype": "Participacao", "parent": ["in", [p.name for p in parts] or [""]]},
				fields=["parent", "tipo_de_infracao"], order_by="idx"):
			infr.setdefault(row.parent, []).append(row.tipo_de_infracao)
		for r in parts:
			desfecho = (_("Recusada pelo Jurista") if r.recusada
				else _("Processo {0}").format(r.processo_disciplinar) if r.processo_disciplinar
				else _("Denúncia") if r.denuncia else _("Termo de Responsabilidade") if r.termo_responsabilidade
				else _("Repreensão") if r.repreensao else (_("Aguarda Jurista") if r.docstatus == 1 else None))
			self.add("disciplinar", "participacao", r.data,
				_("Participação — {0}").format(", ".join(infr.get(r.name) or [r.tipo_de_infracao or ""])),
				"Participacao", r.name,
				sub=self._txt(r.gravidade and _("gravidade {0}").format(r.gravidade), r.posto_nome, desfecho),
				detalhe=(_("Motivo da recusa: {0}").format(r.motivo_recusa) if r.recusada else (r.relato or "")[:400]),
				estado=_("Recusada") if r.recusada else None,
				tom=None if r.recusada else _tom_grav(r.gravidade), row=r)
			if r.suspensao_desde and r.docstatus == 1:
				self.add("disciplinar", "suspensao", r.suspensao_desde, _("Suspensão Preventiva"), "Participacao", r.name,
					sub=self._txt(_("até {0}").format(self._d(r.suspensao_ate)) if r.suspensao_ate else _("em curso"),
						r.suspensao_remuneracao and _("remuneração: {0}").format(r.suspensao_remuneracao)),
					estado=None if r.suspensao_ate else _("Em curso"), tom=None if r.suspensao_ate else "amber")
		for r in self._docs("Repreensao", {"vigilante": self.vig}, ["numero", "infracoes", "observacoes"], "data"):
			self.add("disciplinar", "repreensao", r.data, _("Repreensão ({0}.ª)").format(r.numero or "?"), "Repreensao", r.name,
				sub=r.infracoes, detalhe=r.observacoes, row=r)
		for r in self._docs("Termo De Responsabilidade", {"vigilante": self.vig},
				["infracoes", "documento_assinado", "processo_disciplinar"], "data"):
			self.add("disciplinar", "termo", r.data, _("Termo de Responsabilidade"), "Termo De Responsabilidade", r.name,
				sub=self._txt(r.infracoes, _("assinado") if r.documento_assinado else (_("falta assinatura") if r.docstatus == 1 else None)),
				row=r)
		for r in self._docs("Denuncia", {"vigilante": self.vig}, ["fundamentacao", "demissao", "infracoes"], "data"):
			self.add("disciplinar", "denuncia", r.data, _("Denúncia (período experimental)"), "Denuncia", r.name,
				sub=self._txt(r.infracoes, r.demissao and _("Demissão {0}").format(r.demissao)),
				detalhe=r.fundamentacao, tom="bad", row=r)
		for r in self._docs("Processo Disciplinar", {"vigilante": self.vig},
				["motivo", "gravidade", "decisao", "fase", "origem"], "data"):
			self.add("disciplinar", "processo", r.data, _("Processo Disciplinar"), "Processo Disciplinar", r.name,
				sub=self._txt(r.motivo, r.gravidade and _("gravidade {0}").format(r.gravidade),
					_("decisão: {0}").format(r.decisao) if r.decisao and r.docstatus == 1 else (r.fase and _("fase: {0}").format(r.fase))),
				estado=None if r.docstatus != 0 else (r.get("workflow_state") or r.fase or _("Em curso")),
				tom="bad" if r.decisao == "Despedimento" else ("amber" if r.docstatus == 0 else None), row=r)

	def _material(self):
		for r in self._docs("Alocacao De Material", {"vigilante": self.vig}, ["estado", "observacoes", "alocar_a"], "data"):
			itens = frappe.get_all("Alocacao Material Item", filters={"parent": r.name, "parenttype": "Alocacao De Material"},
				fields=["material", "quantidade", "qtd_devolvida", "retornavel"], order_by="idx")
			self.add("material", "material", r.data, _("Alocação de Material"), "Alocacao De Material", r.name,
				sub=", ".join(f"{i.quantidade or 0}× {i.material}" for i in itens)[:200],
				detalhe=r.observacoes, estado=r.estado if r.estado not in ("Alocado", "Entregue") else None,
				tom="good" if r.estado == "Devolvido" else None, row=r)

	def _salario(self):
		e = self.emp
		for r in self._docs("Salary Structure Assignment", {"employee": e}, ["base"], "from_date"):
			self.add("salario", "salario", r.from_date, _("Salário base definido"), "Salary Structure Assignment", r.name,
				valor=flt(r.base), row=r)
		for r in self._docs("Salary Slip", {"employee": e}, ["start_date", "end_date", "gross_pay", "total_deduction", "net_pay"],
				"end_date"):
			self.add("salario", "folha", r.end_date, _("Folha — {0}").format(self._mes(r.start_date or r.end_date)),
				"Salary Slip", r.name,
				sub=_("bruto {0} · descontos {1}").format(_m(r.gross_pay), _m(r.total_deduction)), valor=flt(r.net_pay), row=r)
		for dt, titulo, campo_tipo in (("Outras Deducoes", _("Dedução"), "tipo"), ("Outras Remuneracoes", _("Provento"), "tipo_de_subsidios"),
				("Emprestimo", _("Empréstimo"), None)):
			campos = ["valor_a_pagar", "valor_mensal", "meses_a_pagar", "data_de_fim", "descricao" if dt != "Outras Remuneracoes" else "tipo_de_pagamento"]
			if campo_tipo:
				campos.append(campo_tipo)
			if frappe.get_meta(dt).has_field("estado"):
				campos.append("estado")
			for r in self._docs(dt, {"funcionario": e}, campos, "data_de_inicio"):
				self.add("salario", "deducao" if dt != "Outras Remuneracoes" else "provento", r.data_de_inicio,
					self._txt(titulo, r.get(campo_tipo) if campo_tipo else None), dt, r.name,
					sub=self._txt(_("{0}/mês").format(_m(r.valor_mensal)) if r.valor_mensal else None,
						_("{0} mês(es)").format(r.meses_a_pagar) if r.meses_a_pagar else None,
						_("até {0}").format(self._d(r.data_de_fim)) if r.data_de_fim else None),
					detalhe=r.get("descricao"), valor=flt(r.valor_a_pagar) * (1 if dt == "Outras Remuneracoes" else -1),
					estado=r.get("estado") if r.get("estado") not in (None, "Activo") and r.docstatus == 1 else None, row=r)
		for r in self._docs("Reclamacao De Salario", {"funcionario": e},
				["mes_de_reclamacao", "ano_de_reclamacao", "valor_a_reclamar", "motivo"], "data"):
			self.add("salario", "reclamacao", r.data, _("Reclamação de Salário — {0} {1}").format(
				r.mes_de_reclamacao or "", r.ano_de_reclamacao or ""), "Reclamacao De Salario", r.name,
				detalhe=r.motivo, valor=flt(r.valor_a_reclamar), row=r)

	# ─── output ──────────────────────────────────────────────────────────────

	def resultado(self):
		self.eventos.sort(key=lambda e: e["data"], reverse=True)
		cats = [{"key": k, "label": _(l), "n": sum(1 for e in self.eventos if e["cat"] == k)}
			for k, l in CATEGORIAS if k != "salario" or self.salario]
		return {
			"vigilante": self.vig, "nome": self.v.nome_completo,
			"de": str(self.de) if self.de else None, "ate": str(self.ate),
			"mostra_salario": self.salario, "categorias": cats, "eventos": self.eventos,
		}


def _m(v):
	return frappe.format_value(flt(v), {"fieldtype": "Currency"})


def _tom_grav(g):
	return {"Alta": "bad", "Média": "amber"}.get(g)


def _tom_estado(estado):
	if estado in ("Cancelada", "Cancelado", "Cancelled", "Rejected", "Rejeitado"):
		return "neutral"
	if estado in ("Activa", "Por Atribuir", "Aberta", "Em Curso", "Em Investigação", "Open"):
		return "amber"
	return None


def justificacoes_do_vigilante(vigilante):
	"""Every non-cancelled Justificação De Faltas of the guard, flagged `aprovada`
	(submitted + workflow Aprovado when a workflow exists) — the same rule payroll
	uses to take faltas off."""
	tem_wf = frappe.get_meta("Justificacao De Faltas").has_field("workflow_state")
	campos = ["name", "dia_de_inicio", "dia_de_fim", "data_do_justificativo", "docstatus", "numero"]
	if tem_wf:
		campos.append("workflow_state")
	out = frappe.get_all("Justificacao De Faltas",
		filters={"vigilante": vigilante, "docstatus": ["<", 2]}, fields=campos, order_by="creation asc")
	for j in out:
		j.aprovada = j.docstatus == 1 and (not tem_wf or j.get("workflow_state") == "Aprovado")
		j.de, j.ate = getdate(j.dia_de_inicio), getdate(j.dia_de_fim)
	return out


def cobertura_da_falta(data, justificacoes):
	"""(approved, pending) Justificação covering `data` — approved wins; first by creation."""
	d = getdate(data)
	ok = next((j for j in justificacoes if j.aprovada and j.de <= d <= j.ate), None)
	pend = None if ok else next((j for j in justificacoes if not j.aprovada and j.de <= d <= j.ate), None)
	return ok, pend
