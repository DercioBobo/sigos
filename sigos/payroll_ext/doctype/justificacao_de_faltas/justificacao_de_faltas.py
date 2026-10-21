import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_months, getdate, date_diff, flt, cint

from sigos.utils import calcular_faltas_detalhado, resolver_periodo_folha

MESES_PT = ("Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
	"Agosto", "Setembro", "Outubro", "Novembro", "Dezembro")


def _outras_justificacoes(vigilante, de, ate, excluir=None):
	"""Approved justifications of the same guard overlapping [de, ate]."""
	from sigos.payroll_ext.salary_slip_hooks import _aprovado_filter
	filters = {
		"vigilante": vigilante,
		"docstatus": 1,
		"dia_de_inicio": ["<=", ate],
		"dia_de_fim": [">=", de],
	}
	if excluir:
		filters["name"] = ["!=", excluir]
	filters.update(_aprovado_filter("Justificacao De Faltas"))
	return frappe.get_all("Justificacao De Faltas", filters=filters,
		fields=["name", "dia_de_inicio", "dia_de_fim"])


def _periodo_da_folha(data):
	"""Payroll period (resolver_periodo_folha) that contains `data`."""
	data = getdate(data)
	for ref in (data, add_months(data, 1)):
		inicio, fim = resolver_periodo_folha(ref.month, ref.year)
		if inicio <= data <= fim:
			return {"inicio": inicio, "fim": fim, "nome": f"{MESES_PT[ref.month - 1]} {ref.year}"}
	return None


def detalhe_faltas(vigilante, dia_de_inicio, dia_de_fim, excluir=None):
	"""Every falta in the window (same escala-aware weights as payroll), flagging
	days already covered by another approved justification — those are not
	cleared twice. `a_retirar` is what this justification takes off."""
	de, ate = getdate(dia_de_inicio), getdate(dia_de_fim)
	outras = _outras_justificacoes(vigilante, de, ate, excluir)
	linhas = []
	for r in calcular_faltas_detalhado(vigilante, de, ate):
		coberta = next((o.name for o in outras
			if getdate(o.dia_de_inicio) <= r["data"] <= getdate(o.dia_de_fim)), None)
		linhas.append({
			"data": r["data"],
			"turno": r.get("turno"),
			"posto": r.get("posto"),
			"tipo": r.get("tipo_de_ausencia"),
			"subtipo": r.get("subtipo_falta"),
			"n": r["n_de_faltas"],
			"coberta_por": coberta,
			"ja_descontada": bool(r.get("processado_em_folha")),
		})
	total = sum(l["n"] for l in linhas)
	ja = sum(l["n"] for l in linhas if l["coberta_por"])
	return {"linhas": linhas, "total": total, "ja_justificadas": ja, "a_retirar": total - ja}


class JustificacaoDeFaltas(Document):

	def validate(self):
		self._recompute_numero()
		self._validar_prazo()
		self._validar_justificativo()

	def _recompute_numero(self):
		"""
		`numero` (justified faltas) is authoritative server-side — never trust the
		value that arrives from the form/API. Recompute it from the SAME escala-aware
		source the salary slip uses for faltas (calcular_faltas_vigilante), so a
		justification can never credit more faltas than actually occurred in its window.
		This closes the deduction-suppression vector (inflating numero to shrink the
		Faltas deduction). An over-claim is logged for the audit trail.
		"""
		submetido = flt(self.numero)

		det = None
		if self.vigilante and self.dia_de_inicio and self.dia_de_fim:
			det = detalhe_faltas(self.vigilante, self.dia_de_inicio, self.dia_de_fim,
				excluir=None if self.is_new() else self.name)
			real = det["a_retirar"]
		else:
			real = 0

		if submetido > real:
			frappe.log_error(
				f"Justificacao De Faltas {self.name or '(nova)'}: numero submetido "
				f"({submetido}) excede as faltas reais ({real}) de {self.vigilante} "
				f"entre {self.dia_de_inicio} e {self.dia_de_fim}. Corrigido para {real}.",
				"SIGOS Justificacao Numero",
			)

		self.numero = real

		# Nothing to justify → nothing to save. Only once the guard + window are known
		# (before that the form is still being filled and required-field checks apply).
		if det and real <= 0 and det["total"] > 0:
			frappe.throw(
				_("As faltas de {0} entre {1} e {2} já estão justificadas.").format(
					frappe.bold(self.vigilante),
					frappe.format(self.dia_de_inicio, {"fieldtype": "Date"}),
					frappe.format(self.dia_de_fim, {"fieldtype": "Date"}),
				),
				title=_("Faltas Já Justificadas"),
			)
		if self.vigilante and self.dia_de_inicio and self.dia_de_fim and real <= 0:
			frappe.throw(
				_("O vigilante {0} não tem faltas entre {1} e {2}. "
				  "Não é possível registar uma Justificação de Faltas sem faltas.").format(
					frappe.bold(self.vigilante),
					frappe.format(self.dia_de_inicio, {"fieldtype": "Date"}),
					frappe.format(self.dia_de_fim, {"fieldtype": "Date"}),
				),
				title=_("Sem Faltas a Justificar"),
			)

	def _cobre_abandono(self):
		"""The window lies within the guard's (latest) Abandono de Posto episode —
		from the first day of the absence streak (abandono_inicio_ausencia) to the
		return/dismissal. Such a justification is not bound by the prazo: the guard was
		absent, so the proof normally only arrives with the return, often weeks
		after the justified days."""
		if not (self.vigilante and self.dia_de_inicio and self.dia_de_fim):
			return False
		ab = frappe.db.get_value(
			"Vigilante", self.vigilante,
			["abandono_inicio_ausencia", "data_inicio_abandono", "data_fim_abandono"], as_dict=True,
		)
		inicio_ep = ab and (ab.abandono_inicio_ausencia or ab.data_inicio_abandono)
		if not inicio_ep:
			return False
		fim_ep = getdate(ab.data_fim_abandono) if ab.data_fim_abandono else getdate(self.dia_de_fim)
		return (getdate(self.dia_de_inicio) >= getdate(inicio_ep)
			and getdate(self.dia_de_fim) <= fim_ep)

	def _validar_prazo(self):
		if not self.dia_de_fim or not self.data_do_justificativo:
			return
		if self._cobre_abandono():
			return  # Abandono de Posto episode — proof arrives with the return

		# Single source of truth for the deadline (the form no longer duplicates it).
		# An unset/0 value falls back to the 3-day default.
		prazo = cint(frappe.db.get_single_value("SIGOS Settings", "prazo_justificacao_faltas")) or 3

		diff = date_diff(self.data_do_justificativo, self.dia_de_fim)
		if diff > prazo:
			frappe.throw(
				_("O prazo para justificar faltas é de {0} dias após a falta. "
				  "A data do justificativo ({1}) está {2} dias depois do fim da falta ({3}).").format(
					prazo,
					frappe.format(self.data_do_justificativo, {"fieldtype": "Date"}),
					diff,
					frappe.format(self.dia_de_fim, {"fieldtype": "Date"}),
				),
				title=_("Prazo Expirado"),
			)

	def _validar_justificativo(self):
		obrigatorio = frappe.db.get_single_value("SIGOS Settings", "justificativo_faltas_obrigatorio")
		if obrigatorio is None:
			obrigatorio = 1

		if obrigatorio and not self.justificativo:
			frappe.throw(_("É obrigatório anexar o Justificativo."))


@frappe.whitelist()
def preview_numero(vigilante, dia_de_inicio, dia_de_fim, name=None, data_do_justificativo=None):
	"""
	Form preview — the SAME count _recompute_numero stamps on save (a_retirar), plus
	the per-day breakdown and the payroll period the faltas come off.
	"""
	from sigos.api import PAPEIS_SALARIO
	frappe.only_for(PAPEIS_SALARIO)
	if not (vigilante and dia_de_inicio and dia_de_fim):
		return {"linhas": [], "total": 0, "ja_justificadas": 0, "a_retirar": 0}
	excluir = name if name and not name.startswith("new-") else None
	det = detalhe_faltas(vigilante, dia_de_inicio, dia_de_fim, excluir)
	if data_do_justificativo:
		det["folha"] = _periodo_da_folha(data_do_justificativo)
	return det
