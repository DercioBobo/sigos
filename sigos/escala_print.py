"""
Server-side renderer for the monthly Escala grid print format.
Exposed to Jinja via the `jinja` hook → used by the "Escala Mensal" print format.
"""
import re
import frappe
from frappe.utils import getdate

_MES = [
	"Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
	"Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
]
_DOW = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"]  # weekday(): Mon=0


def _abbr(turno):
	if not turno:
		return ""
	m = re.match(r"^(\d)a?\s*(Manhã|Noite|Tarde|Folga)", turno, re.I)
	if m:
		return m.group(1) + m.group(2)[0].upper()
	if re.search("folga", turno, re.I):
		return "F"
	return turno if len(turno) <= 4 else turno[:4]


def render_escala_print(doc, mes=None):
	"""
	Return HTML calendar grid(s) for the escala.

	mes:
	  - None / "atual"  → only the current month (default)
	  - "todos"          → every month in the window, one per page
	  - "YYYY-MM"        → that specific month
	"""
	if isinstance(doc, str):
		doc = frappe.get_doc("Escala Do Vigilante", doc)

	rows = doc.get("tabela_de_escala") or []
	if not rows:
		return "<div style='padding:20px;text-align:center;'>Sem escala gerada.</div>"

	# Resolve which month(s) to render
	if not mes or mes == "atual":
		alvo = str(getdate())[:7]  # current YYYY-MM
	else:
		alvo = mes  # "todos" or a specific "YYYY-MM"

	# Regime info (for the coverage row)
	tipo = None
	working = set()
	if doc.get("regime_do_vigilante"):
		regime = frappe.get_doc("Regime", doc.regime_do_vigilante)
		tipo = regime.tipo_ciclo
		working = {r.turno for r in regime.turnos if not r.e_folga}

	# Guard order + names
	tab = doc.get("tab_vigilante_do_posto") or []
	guard_order = [g.vigilante for g in tab]
	name_map = {g.vigilante: (g.nome_completo or g.vigilante) for g in tab}
	seen = []
	for r in rows:
		if r.vigilante not in seen:
			seen.append(r.vigilante)
	guards = [g for g in guard_order if g in seen] + [g for g in seen if g not in guard_order]

	# Group dates by month + index cells
	months = {}
	cell = {}
	for r in rows:
		ds = str(getdate(r.data))
		months.setdefault(ds[:7], set()).add(ds)
		cell[f"{r.vigilante}|{ds}"] = r

	posto = doc.get("posto_de_vigilancia") or ""
	cliente = doc.get("cliente") or ""
	regime_name = doc.get("regime_do_vigilante") or ""

	# Pick months to render
	if alvo == "todos":
		meses_a_render = sorted(months)
	elif alvo in months:
		meses_a_render = [alvo]
	else:
		# Requested month has no rows — fall back to the earliest available
		# so the print is never blank (e.g. printing before the month starts).
		meses_a_render = [sorted(months)[0]] if months else []

	if not meses_a_render:
		return "<div style='padding:20px;text-align:center;'>Sem dias para o mês seleccionado.</div>"

	out = []
	for ym in meses_a_render:
		datas = sorted(months[ym])
		y, m = ym.split("-")
		label = f"{_MES[int(m) - 1]} {y}"

		b = [
			'<div class="esc-print-block">',
			'<div class="esc-print-head">',
			f'<h3>Escala de Vigilância — {label}</h3>',
			f'<div class="esc-print-meta"><b>Posto:</b> {posto} &nbsp;·&nbsp; '
			f'<b>Cliente:</b> {cliente} &nbsp;·&nbsp; <b>Regime:</b> {regime_name}</div>',
			'</div>',
			'<table class="esc-print-table"><thead><tr><th class="vname">Vigilante</th>',
		]
		for ds in datas:
			dt = getdate(ds)
			we = "we" if dt.weekday() >= 5 else ""
			b.append(f'<th class="{we}"><div class="dn">{dt.day}</div><div class="dw">{_DOW[dt.weekday()]}</div></th>')
		b.append("</tr></thead><tbody>")

		# Coverage row (Rotativo only)
		if tipo == "Rotativo" and working:
			b.append('<tr class="covrow"><td class="vname">Cobertura</td>')
			for ds in datas:
				counts = {}
				for vig in guards:
					r = cell.get(f"{vig}|{ds}")
					if r and r.turno in working:
						counts[r.turno] = counts.get(r.turno, 0) + 1
				gap = [w for w in working if not counts.get(w)]
				dbl = [w for w in working if counts.get(w, 0) > 1]
				if dbl:
					ic, c = "●", "cd"
				elif gap:
					ic, c = "▲", "cg"
				else:
					ic, c = "✓", "co"
				b.append(f'<td class="cov {c}">{ic}</td>')
			b.append("</tr>")

		# Guard rows
		for vig in guards:
			b.append(f'<tr><td class="vname">{frappe.utils.escape_html(name_map.get(vig, vig))}</td>')
			for ds in datas:
				r = cell.get(f"{vig}|{ds}")
				if not r:
					b.append("<td></td>")
				else:
					per = (r.periodo or "").lower()
					pcls = {"manhã": "pm", "noite": "pn", "tarde": "pt"}.get(per, "pf")
					ovr = "ovr" if r.override else ""
					b.append(f'<td class="cell {pcls} {ovr}">{_abbr(r.turno)}</td>')
			b.append("</tr>")

		b.append("</tbody></table>")
		b.append(
			'<div class="esc-print-legend">'
			'M=Manhã · N=Noite · T=Tarde · F=Folga · (1/2 = 1ª/2ª) &nbsp;|&nbsp; '
			'Cobertura: ✓ coberto · ▲ falta · ● duplo &nbsp;|&nbsp; '
			'célula a vermelho = alteração manual'
			'</div>'
		)
		b.append("</div>")
		out.append("".join(b))

	return "".join(out)
