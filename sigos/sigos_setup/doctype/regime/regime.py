import frappe
from frappe import _
from frappe.model.document import Document


class Regime(Document):

	def validate(self):
		if not self.turnos:
			frappe.throw(_("O Regime deve ter pelo menos um turno definido."))
		self._sync_turno_fields()
		self._validar_n_faltas_folgas()

	def _sync_turno_fields(self):
		"""Populate periodo and e_folga from the linked Turno (fetch_from is UI-only)."""
		turno_cache = {}
		for row in self.turnos:
			if not row.turno:
				continue
			if row.turno not in turno_cache:
				t = frappe.db.get_value("Turno", row.turno, ["periodo", "e_folga"], as_dict=True)
				turno_cache[row.turno] = t or {}
			data = turno_cache[row.turno]
			row.periodo = data.get("periodo") or ""
			row.e_folga = int(data.get("e_folga") or 0)

	def _validar_n_faltas_folgas(self):
		for row in self.turnos:
			if row.e_folga and (row.n_de_faltas or 0) > 0:
				frappe.throw(
					_("Linha {0} (Turno: {1}): turnos de folga não podem ter Nº de Faltas > 0.").format(
						row.idx, row.turno
					)
				)

	# ─── Public helpers ────────────────────────────────────────────────────────

	def get_turno_sequence(self):
		"""Return list of turno dicts ordered by idx."""
		return [
			{
				"turno":       r.turno,
				"periodo":     r.periodo,
				"e_folga":     r.e_folga,
				"n_de_faltas": r.n_de_faltas or 0,
				"idx":         r.idx,
			}
			for r in sorted(self.turnos, key=lambda x: x.idx)
		]

	def get_n_faltas(self, turno: str) -> int:
		"""Return the n_de_faltas for a given Turno (docname) in this regime."""
		for row in self.turnos:
			if row.turno == turno:
				return row.n_de_faltas or 0
		return 1  # safe default
