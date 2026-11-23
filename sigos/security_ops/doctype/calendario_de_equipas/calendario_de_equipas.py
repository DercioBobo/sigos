import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_days, getdate, nowdate

from sigos import calendario_equipas as ce

PAPEIS_APLICAR = ("System Manager", "SIGOS Manager", "Aprovador Operações")


class CalendarioDeEquipas(Document):
	"""Company-wide team rotation of one Rotativo regime — see sigos.calendario_equipas.
	Saving does NOT touch escalas: "Aplicar às Escalas" previews and then applies."""

	def validate(self):
		reg = frappe.get_cached_doc("Regime", self.regime)
		if reg.tipo_ciclo != "Rotativo":
			frappe.throw(_("O Calendário de Equipas só se aplica a regimes <b>Rotativos</b>."))
		turnos = [r.turno for r in sorted(reg.turnos, key=lambda x: x.idx)]
		vistas, posicoes = set(), {}
		for r in self.equipas or []:
			if r.turno_equipa in vistas:
				frappe.throw(_("A equipa <b>{0}</b> está repetida.").format(r.turno_equipa))
			vistas.add(r.turno_equipa)
			if r.turno not in turnos:
				frappe.throw(_("O turno <b>{0}</b> não pertence ao regime <b>{1}</b>.").format(r.turno, self.regime))
			if r.turno in posicoes:
				frappe.throw(_("<b>{0}</b> e <b>{1}</b> fazem o mesmo turno ({2}) — cada equipa tem de estar numa posição diferente do ciclo.")
					.format(posicoes[r.turno], r.turno_equipa, r.turno))
			posicoes[r.turno] = r.turno_equipa

	def on_update(self):
		ce.limpar_cache()
		antes = self.get_doc_before_save()
		mudou = not antes or (
			str(antes.data_referencia) != str(self.data_referencia) or antes.activo != self.activo
			or [(r.turno_equipa, r.turno) for r in antes.equipas] != [(r.turno_equipa, r.turno) for r in self.equipas])
		if mudou and self._escalas():
			frappe.msgprint(_("Use <b>Aplicar às Escalas</b> para actualizar as escalas do regime {0}.").format(self.regime),
				indicator="blue", alert=True)

	def _escalas(self):
		return frappe.get_all("Escala Do Vigilante",
			filters={"regime_do_vigilante": self.regime, "estado": ["in", ["Activo", "Rascunho"]]},
			fields=["name", "posto_de_vigilancia", "nome_do_posto", "delegacao", "tipo_de_escala"], order_by="name")

	@frappe.whitelist()
	def pre_visualizar(self):
		"""Per escala: which guards' turno changes today, without saving anything."""
		frappe.only_for(PAPEIS_APLICAR)
		ce.limpar_cache()
		cal = ce.calendario(self.regime)
		if not cal:
			frappe.throw(_("Grave o calendário (activo) primeiro."))
		hoje = getdate(nowdate())
		out = []
		for e in self._escalas():
			esc = frappe.get_doc("Escala Do Vigilante", e.name)
			plano = ce.planear(esc, cal)
			mudancas = [{k: v for k, v in p.items() if k != "row"}
				for p in plano if p["turno_antes"] != p["turno_depois"]]
			out.append({"escala": e.name, "posto": e.nome_do_posto or e.posto_de_vigilancia or e.delegacao,
				"vigilantes": len(plano), "mudancas": mudancas, "ajuste": esc.get("ajuste_local_dias") or 0})
		return {"data": str(hoje), "escalas": out}

	@frappe.whitelist()
	def aplicar(self):
		"""Re-save every escala of the regime (EscalaDoVigilante._aplicar_calendario does
		the work: assigns teams, re-derives turno_inicial, regenerates future days)."""
		frappe.only_for(PAPEIS_APLICAR)
		ce.limpar_cache()
		ok, erros = [], []
		frappe.flags.sigos_origem_escala = ("Calendario De Equipas", self.name)
		for e in self._escalas():
			frappe.db.savepoint("sigos_cal_esc")
			try:
				esc = frappe.get_doc("Escala Do Vigilante", e.name)
				esc.flags.regenerar_tudo = True  # the reference date/turnos may have moved
				esc.save(ignore_permissions=True)
				ok.append(e.name)
			except Exception as ex:
				frappe.db.rollback(save_point="sigos_cal_esc")
				erros.append({"escala": e.name, "erro": str(ex)[:300]})
				frappe.log_error(frappe.get_traceback(), f"SIGOS Calendário de Equipas: {e.name}")
		frappe.flags.sigos_origem_escala = None
		return {"aplicadas": ok, "erros": erros}

	@frappe.whitelist()
	def previsao(self, dias=14):
		"""Form preview: each team's turno for the next `dias` days."""
		ce.limpar_cache()
		cal = ce.calendario(self.regime) if not self.is_new() else None
		if not cal:
			return None
		hoje = getdate(nowdate())
		datas = [add_days(hoje, i) for i in range(int(dias))]
		return {
			"datas": [str(d) for d in datas],
			"equipas": [{"equipa": eq, "dias": [ce.turno_em(cal, eq, d) for d in datas]}
				for eq in sorted(cal.equipas, key=lambda x: cal.equipas[x])],
		}
