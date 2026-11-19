// SIGOS date / time pickers - a friendlier replacement for Frappe's air-datepicker.
//
//   const c = sigos.ui.date_control({ parent, label, value, reqd, min, max, read_only,
//                                     description, onchange(v) {} });
//   const t = sigos.ui.time_control({ parent, label, value, read_only, onchange(v) {} });
//
// Both return { $wrapper, $input, get_value(), set_value(v), refresh() } so they slot into
// the deck pattern where make_control was used. Values are ISO "YYYY-MM-DD" / "HH:MM".
// Typing works too: "19", "19/11", "191126", "19-11-2026", "hoje", "ontem", "1430", "14h30".

frappe.provide("sigos.ui");

(function () {
	const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
		"Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
	const DIAS_CURTO = ["S", "T", "Q", "Q", "S", "S", "D"]; // Monday first
	const DIAS_LONGO = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

	const pad = (n) => String(n).padStart(2, "0");
	const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const de_iso = (s) => {
		const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
		return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
	};
	const hoje = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
	const mais_dias = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
	const valida = (y, m, d) => {
		const x = new Date(y, m - 1, d);
		return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d ? x : null;
	};
	const mes_primeiro = () => /^m/i.test((frappe.boot && frappe.boot.sysdefaults && frappe.boot.sysdefaults.date_format) || "dd");
	const para_user = (s) => (s ? frappe.datetime.str_to_user(s) : "");
	const dia_semana = (s) => { const d = de_iso(s); return d ? DIAS_LONGO[d.getDay()] : ""; };

	// Free-text → Date (day-first unless the system format is month-first).
	function interpretar_data(txt, ref) {
		const t = String(txt || "").trim().toLowerCase();
		if (!t) return null;
		if (t === "hoje" || t === "h") return hoje();
		if (t === "ontem") return mais_dias(hoje(), -1);
		if (t === "anteontem") return mais_dias(hoje(), -2);
		ref = ref || hoje();
		let p;
		if (/^\d+$/.test(t)) {
			if (t.length <= 2) p = [t];
			else if (t.length === 4) p = [t.slice(0, 2), t.slice(2)];
			else if (t.length === 6) p = [t.slice(0, 2), t.slice(2, 4), t.slice(4)];
			else if (t.length === 8) p = /^(19|20)/.test(t) && +t.slice(4, 6) <= 12
				? [t.slice(6), t.slice(4, 6), t.slice(0, 4)] // yyyymmdd
				: [t.slice(0, 2), t.slice(2, 4), t.slice(4)];
			else return null;
		} else {
			p = t.split(/[^0-9]+/).filter(Boolean);
			if (p.length && p[0].length === 4) p = [p[2], p[1], p[0]]; // yyyy-mm-dd
		}
		if (!p.length || p.length > 3) return null;
		let [a, b, c] = p.map(Number);
		let dia = a, mes = b || ref.getMonth() + 1;
		if (b && mes_primeiro()) { dia = b; mes = a; }
		let ano = c === undefined ? ref.getFullYear() : c < 100 ? 2000 + c : c;
		return valida(ano, mes, dia);
	}

	function interpretar_hora(txt) {
		const t = String(txt || "").trim().toLowerCase();
		if (!t) return null;
		if (t === "agora") { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
		let h, m;
		const sep = /^(\d{1,2})\s*[h:.,\s]\s*(\d{0,2})\s*(?:m(?:in)?)?$/.exec(t);
		if (sep) { h = +sep[1]; m = +(sep[2] || 0); }
		else if (/^\d{1,4}$/.test(t)) {
			if (t.length <= 2) { h = +t; m = 0; } else { h = +t.slice(0, t.length - 2); m = +t.slice(-2); }
		} else return null;
		return h <= 23 && m <= 59 ? `${pad(h)}:${pad(m)}` : null;
	}

	// ─── Shared shell: label + input + popover attached to <body> ────────────────

	function base(opts, cls, icone) {
		css();
		const esc = frappe.utils.escape_html;
		const $wrapper = $(`
			<div class="frappe-control sg-pk ${cls} ${opts.read_only ? "sg-ro" : ""}">
				<div class="form-group">
					${opts.label ? `<div class="clearfix"><label class="control-label ${opts.reqd ? "reqd" : ""}">${esc(opts.label)}</label></div>` : ""}
					<div class="sg-pk-box">
						<input type="text" class="form-control sg-pk-in" autocomplete="off" spellcheck="false"
							placeholder="${esc(opts.placeholder || "")}" ${opts.read_only ? "readonly tabindex=-1" : ""}>
						<span class="sg-pk-suf"></span>
						${opts.read_only ? "" : `<button type="button" class="sg-pk-btn" tabindex="-1" aria-label="${__("Abrir")}">${icone}</button>`}
					</div>
					${opts.description ? `<p class="help-box small text-muted">${esc(opts.description)}</p>` : ""}
				</div>
			</div>`).appendTo(opts.parent);
		const $input = $wrapper.find(".sg-pk-in");
		const $pop = $(`<div class="sg-pk-pop ${cls}-pop" style="display:none"></div>`).appendTo(document.body);
		const ctl = { $wrapper, $input, $pop, aberto: false };

		ctl.posicionar = () => {
			if (!ctl.aberto) return;
			const r = $wrapper.find(".sg-pk-box")[0].getBoundingClientRect();
			const w = $pop.outerWidth(), h = $pop.outerHeight();
			let top = r.bottom + 6;
			if (top + h > window.innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
			const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
			$pop.css({ top: top + window.scrollY, left: left + window.scrollX });
		};
		const fora = (e) => {
			if (!$pop[0].contains(e.target) && !$wrapper[0].contains(e.target)) ctl.fechar();
		};
		const rolar = () => ctl.posicionar();
		ctl.abrir = () => {
			if (opts.read_only || ctl.aberto) return;
			ctl.aberto = true;
			ctl.desenhar();
			$pop.show();
			ctl.posicionar();
			$wrapper.addClass("sg-open");
			document.addEventListener("mousedown", fora, true);
			window.addEventListener("scroll", rolar, true);
			window.addEventListener("resize", rolar);
		};
		ctl.fechar = () => {
			if (!ctl.aberto) return;
			ctl.aberto = false;
			$pop.hide();
			$wrapper.removeClass("sg-open");
			document.removeEventListener("mousedown", fora, true);
			window.removeEventListener("scroll", rolar, true);
			window.removeEventListener("resize", rolar);
		};
		// the form re-renders by replacing the wrapper's HTML: drop the orphan popover
		const vigia = setInterval(() => {
			if (!document.body.contains($wrapper[0])) { ctl.fechar(); $pop.remove(); clearInterval(vigia); }
		}, 4000);

		if (!opts.read_only) {
			$wrapper.on("click", ".sg-pk-btn", () => (ctl.aberto ? ctl.fechar() : ($input.trigger("focus"), ctl.abrir())));
			$input.on("focus click", () => ctl.abrir());
			$input.on("keydown", (e) => {
				if (e.key === "Escape") { ctl.fechar(); return; }
				if (e.key === "Enter") { e.preventDefault(); ctl.confirmar_texto(); ctl.fechar(); return; }
				if (e.key === "Tab") { ctl.confirmar_texto(); ctl.fechar(); return; }
				if (ctl.teclas) ctl.teclas(e);
			});
			$input.on("blur", () => setTimeout(() => {
				if (!$pop[0].contains(document.activeElement)) ctl.confirmar_texto();
			}, 120));
			$pop.on("mousedown", (e) => e.preventDefault()); // keep focus in the input
		}
		return ctl;
	}

	// ─── Date ─────────────────────────────────────────────────────────────────────

	sigos.ui.date_control = function (opts) {
		const ico = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
			stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="17" rx="2.5"/>
			<path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>`;
		const fmt = (frappe.boot && frappe.boot.sysdefaults && frappe.boot.sysdefaults.date_format) || "dd-mm-yyyy";
		const ctl = base(Object.assign({ placeholder: fmt.replace(/y+/, "aaaa") }, opts), "sg-dp", ico);
		let valor = null, vista = null, modo = "dias", cursor = null;
		const min = () => (typeof opts.min === "function" ? opts.min() : opts.min) || null;
		const max = () => (typeof opts.max === "function" ? opts.max() : opts.max) || null;
		const fora_limite = (s) => (min() && s < min()) || (max() && s > max());

		const mostrar = () => {
			ctl.$input.val(para_user(valor));
			ctl.$wrapper.find(".sg-pk-suf").text(valor ? dia_semana(valor) : "");
		};
		const definir = (s, emitir) => {
			if (s && fora_limite(s)) {
				frappe.show_alert({ message: max() && s > max()
					? __("A data não pode ser depois de {0}.", [para_user(max())])
					: __("A data não pode ser antes de {0}.", [para_user(min())]), indicator: "orange" }, 4);
				mostrar();
				return;
			}
			const mudou = (s || null) !== valor;
			valor = s || null;
			mostrar();
			if (mudou && emitir && opts.onchange) opts.onchange(valor);
		};
		ctl.confirmar_texto = () => {
			const t = ctl.$input.val();
			if (t === para_user(valor)) return;
			if (!t.trim()) { definir(null, true); return; }
			const d = interpretar_data(t, de_iso(valor) || vista);
			if (d) definir(iso(d), true);
			else { frappe.show_alert({ message: __("Data inválida: {0}", [frappe.utils.escape_html(t)]), indicator: "orange" }, 3); mostrar(); }
		};

		ctl.desenhar = () => {
			const base_d = de_iso(cursor) || de_iso(valor) || vista || hoje();
			vista = new Date(base_d.getFullYear(), base_d.getMonth(), 1);
			cursor = cursor || valor || iso(hoje());
			const y = vista.getFullYear(), m = vista.getMonth();
			let corpo;
			if (modo === "meses") {
				corpo = `<div class="sg-dp-meses">${MESES.map((n, i) => {
					const on = valor && de_iso(valor).getFullYear() === y && de_iso(valor).getMonth() === i;
					const ag = hoje().getFullYear() === y && hoje().getMonth() === i;
					return `<button type="button" class="sg-dp-mes ${on ? "on" : ""} ${ag ? "hj" : ""}" data-mes="${i}">${n.slice(0, 3)}</button>`;
				}).join("")}</div>`;
			} else {
				const inicio = mais_dias(vista, -((vista.getDay() + 6) % 7));
				let cel = "";
				for (let i = 0; i < 42; i++) {
					const d = mais_dias(inicio, i), s = iso(d);
					const cls = [
						d.getMonth() !== m ? "out" : "",
						s === valor ? "on" : "",
						s === iso(hoje()) ? "hj" : "",
						s === cursor ? "cur" : "",
						d.getDay() === 0 || d.getDay() === 6 ? "fds" : "",
					].join(" ");
					cel += `<button type="button" class="sg-dp-d ${cls}" data-d="${s}" ${fora_limite(s) ? "disabled" : ""}>${d.getDate()}</button>`;
					if (i === 34 && mais_dias(inicio, 35).getMonth() !== m) break; // 5 rows suffice
				}
				corpo = `<div class="sg-dp-sem">${DIAS_CURTO.map((x) => `<span>${x}</span>`).join("")}</div>
					<div class="sg-dp-grid">${cel}</div>`;
			}
			const atalho = (rot, d) => {
				const s = iso(d);
				return `<button type="button" class="sg-pk-chip ${s === valor ? "on" : ""}" data-d="${s}" ${fora_limite(s) ? "disabled" : ""}>${rot}</button>`;
			};
			ctl.$pop.html(`
				<div class="sg-dp-top">
					<button type="button" class="sg-dp-nav" data-nav="-1">&lsaquo;</button>
					<button type="button" class="sg-dp-tit" data-modo>${modo === "meses" ? y : `${MESES[m]} <span>${y}</span>`}</button>
					<button type="button" class="sg-dp-nav" data-nav="1">&rsaquo;</button>
				</div>
				${corpo}
				<div class="sg-pk-foot">
					${atalho(__("Hoje"), hoje())}${atalho(__("Ontem"), mais_dias(hoje(), -1))}${atalho(__("Anteontem"), mais_dias(hoje(), -2))}
					${opts.reqd ? "" : `<button type="button" class="sg-pk-chip sg-pk-limpar" data-limpar>${__("Limpar")}</button>`}
				</div>`);
			ctl.posicionar();
		};

		ctl.$pop.on("click", "[data-nav]", function () {
			const n = +$(this).attr("data-nav");
			const d = de_iso(cursor) || vista;
			const alvo = modo === "meses"
				? new Date(d.getFullYear() + n, d.getMonth(), 1)
				: new Date(vista.getFullYear(), vista.getMonth() + n, 1);
			cursor = iso(alvo);
			ctl.desenhar();
		});
		ctl.$pop.on("click", "[data-modo]", () => { modo = modo === "meses" ? "dias" : "meses"; ctl.desenhar(); });
		ctl.$pop.on("click", "[data-mes]", function () {
			cursor = iso(new Date(vista.getFullYear(), +$(this).attr("data-mes"), 1));
			modo = "dias";
			ctl.desenhar();
		});
		ctl.$pop.on("click", "[data-d]", function () {
			definir($(this).attr("data-d"), true);
			cursor = valor;
			ctl.fechar();
		});
		ctl.$pop.on("click", "[data-limpar]", () => { definir(null, true); ctl.fechar(); });

		ctl.teclas = (e) => {
			const passo = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
			if (!passo || !ctl.aberto || modo !== "dias") return;
			e.preventDefault();
			cursor = iso(mais_dias(de_iso(cursor) || hoje(), passo));
			ctl.desenhar();
			if (!fora_limite(cursor)) { ctl.$input.val(para_user(cursor)); }
		};
		const abrir = ctl.abrir;
		ctl.abrir = () => { modo = "dias"; cursor = valor || iso(hoje()); vista = null; abrir(); };

		ctl.get_value = () => valor;
		ctl.set_value = (v) => { valor = v ? String(v).slice(0, 10) : null; mostrar(); if (ctl.aberto) ctl.desenhar(); };
		ctl.refresh = mostrar;
		ctl.set_value(opts.value);
		return ctl;
	};

	// ─── Time ─────────────────────────────────────────────────────────────────────

	sigos.ui.time_control = function (opts) {
		const ico = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
			stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
		const ctl = base(Object.assign({ placeholder: "hh:mm" }, opts), "sg-tp", ico);
		let valor = null, hora_sel = null;
		const mostrar = () => ctl.$input.val(valor || "");
		const definir = (v, emitir) => {
			const mudou = (v || null) !== valor;
			valor = v || null;
			mostrar();
			if (mudou && emitir && opts.onchange) opts.onchange(valor);
		};
		ctl.confirmar_texto = () => {
			const t = ctl.$input.val();
			if (t === (valor || "")) return;
			if (!t.trim()) { definir(null, true); return; }
			const v = interpretar_hora(t);
			if (v) definir(v, true);
			else { frappe.show_alert({ message: __("Hora inválida: {0}", [frappe.utils.escape_html(t)]), indicator: "orange" }, 3); mostrar(); }
		};
		ctl.desenhar = () => {
			const [vh, vm] = (valor || "").split(":");
			const h_on = hora_sel !== null ? hora_sel : vh !== undefined && vh !== "" ? +vh : null;
			const horas = Array.from({ length: 24 }, (_, h) =>
				`<button type="button" class="sg-tp-h ${h === h_on ? "on" : ""}" data-h="${h}">${pad(h)}</button>`).join("");
			const mins = Array.from({ length: 12 }, (_, i) => i * 5).map((mm) =>
				`<button type="button" class="sg-tp-m ${valor && +vm === mm && h_on === +vh ? "on" : ""}" data-m="${mm}" ${h_on === null ? "disabled" : ""}>:${pad(mm)}</button>`).join("");
			ctl.$pop.html(`
				<div class="sg-tp-lbl">${__("Hora")}</div><div class="sg-tp-hs">${horas}</div>
				<div class="sg-tp-lbl">${__("Minutos")}</div><div class="sg-tp-ms">${mins}</div>
				<div class="sg-pk-foot">
					<button type="button" class="sg-pk-chip" data-agora>${__("Agora")}</button>
					<button type="button" class="sg-pk-chip sg-pk-limpar" data-limpar>${__("Limpar")}</button>
				</div>`);
			ctl.posicionar();
		};
		ctl.$pop.on("click", "[data-h]", function () { hora_sel = +$(this).attr("data-h"); ctl.desenhar(); });
		ctl.$pop.on("click", "[data-m]", function () {
			if (hora_sel === null && valor) hora_sel = +valor.split(":")[0];
			if (hora_sel === null) return;
			definir(`${pad(hora_sel)}:${pad(+$(this).attr("data-m"))}`, true);
			ctl.fechar();
		});
		ctl.$pop.on("click", "[data-agora]", () => { definir(interpretar_hora("agora"), true); ctl.fechar(); });
		ctl.$pop.on("click", "[data-limpar]", () => { definir(null, true); ctl.fechar(); });
		const abrir = ctl.abrir;
		ctl.abrir = () => { hora_sel = null; abrir(); };

		ctl.get_value = () => valor;
		ctl.set_value = (v) => { valor = v ? String(v).slice(0, 5) : null; mostrar(); if (ctl.aberto) ctl.desenhar(); };
		ctl.refresh = mostrar;
		ctl.set_value(opts.value);
		return ctl;
	};

	// ─── CSS (ASCII only) ─────────────────────────────────────────────────────────

	function css() {
		if (document.getElementById("sigos-pk-css")) return;
		const c = `
.sg-pk { --sg-acc: #1a3a5c; --sg-acc-soft: #e8eef6; --sg-line: var(--border-color, #dfe5ec);
	--sg-ink: var(--text-color, #1f2933); --sg-ink2: var(--text-muted, #6b7a8a); --sg-bg: var(--control-bg, #f4f5f7); }
.sg-pk-box { position: relative; display: flex; align-items: center; }
.sg-pk-in { padding-right: 34px !important; font-variant-numeric: tabular-nums; cursor: pointer; }
.sg-pk.sg-open .sg-pk-in { box-shadow: 0 0 0 2px rgba(26, 58, 92, .18); }
.sg-pk-suf { position: absolute; right: 36px; font-size: 11.5px; color: var(--sg-ink2); pointer-events: none; }
.sg-pk-btn { position: absolute; right: 4px; width: 28px; height: 26px; border: none; background: transparent;
	color: var(--sg-ink2); border-radius: 6px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.sg-pk-btn:hover, .sg-pk.sg-open .sg-pk-btn { color: var(--sg-acc); background: var(--sg-acc-soft); }
.sg-ro .sg-pk-in { cursor: default; background: transparent; border-color: transparent; padding-left: 0; box-shadow: none; }
.sg-ro .sg-pk-suf { right: auto; position: static; margin-left: 8px; }
.sg-pk-pop { position: absolute; z-index: 1060; width: 296px; padding: 12px; border-radius: 14px;
	background: var(--fg-color, #fff); color: var(--text-color, #1f2933); border: 1px solid var(--border-color, #dfe5ec);
	box-shadow: 0 14px 38px rgba(16, 34, 56, .18), 0 2px 6px rgba(16, 34, 56, .08); font-size: 13px; user-select: none;
	--sg-acc: #1a3a5c; --sg-acc-soft: #e8eef6; --sg-ink2: var(--text-muted, #6b7a8a); }
.sg-pk-pop button { border: none; background: transparent; color: inherit; cursor: pointer; font: inherit; }
.sg-pk-pop button[disabled] { opacity: .3; cursor: not-allowed; }
.sg-dp-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.sg-dp-nav { width: 32px; height: 32px; border-radius: 8px; font-size: 22px !important; line-height: 1; color: var(--sg-ink2) !important; }
.sg-dp-nav:hover { background: var(--sg-acc-soft) !important; color: var(--sg-acc) !important; }
.sg-dp-tit { font-weight: 700 !important; font-size: 14.5px !important; padding: 5px 12px; border-radius: 8px; }
.sg-dp-tit span { font-weight: 500; color: var(--sg-ink2); }
.sg-dp-tit:hover { background: var(--sg-acc-soft) !important; }
.sg-dp-sem, .sg-dp-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.sg-dp-sem span { text-align: center; font-size: 11px; font-weight: 600; color: var(--sg-ink2); padding: 4px 0; }
.sg-dp-d { height: 36px; border-radius: 9px; font-variant-numeric: tabular-nums; font-size: 13.5px !important; }
.sg-dp-d:hover:not([disabled]) { background: var(--sg-acc-soft) !important; }
.sg-dp-d.fds { color: var(--sg-ink2) !important; }
.sg-dp-d.out { opacity: .38; }
.sg-dp-d.hj { box-shadow: inset 0 0 0 1.5px var(--sg-acc); font-weight: 700 !important; }
.sg-dp-d.cur { background: var(--sg-acc-soft) !important; }
.sg-dp-d.on { background: var(--sg-acc) !important; color: #fff !important; font-weight: 700 !important; opacity: 1; }
.sg-dp-meses { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 4px 0; }
.sg-dp-mes { height: 44px; border-radius: 10px; font-weight: 600 !important; }
.sg-dp-mes:hover { background: var(--sg-acc-soft) !important; }
.sg-dp-mes.hj { box-shadow: inset 0 0 0 1.5px var(--sg-acc); }
.sg-dp-mes.on { background: var(--sg-acc) !important; color: #fff !important; }
.sg-pk-foot { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-color, #eef1f5); }
.sg-pk-chip { padding: 5px 12px; border-radius: 999px; font-size: 12px !important; font-weight: 600 !important;
	background: var(--sg-acc-soft) !important; color: var(--sg-acc) !important; }
.sg-pk-chip:hover:not([disabled]) { filter: brightness(.95); }
.sg-pk-chip.on { background: var(--sg-acc) !important; color: #fff !important; }
.sg-pk-limpar { margin-left: auto; background: transparent !important; color: var(--sg-ink2) !important; }
.sg-tp-pop { width: 272px; }
.sg-tp-lbl { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--sg-ink2); margin: 2px 0 6px; }
.sg-tp-hs { display: grid; grid-template-columns: repeat(6, 1fr); gap: 3px; margin-bottom: 10px; }
.sg-tp-ms { display: grid; grid-template-columns: repeat(6, 1fr); gap: 3px; }
.sg-tp-h, .sg-tp-m { height: 32px; border-radius: 8px; font-variant-numeric: tabular-nums; }
.sg-tp-h:hover, .sg-tp-m:hover:not([disabled]) { background: var(--sg-acc-soft) !important; }
.sg-tp-h.on, .sg-tp-m.on { background: var(--sg-acc) !important; color: #fff !important; font-weight: 700 !important; }
@media (max-width: 480px) { .sg-pk-pop { width: calc(100vw - 16px); } .sg-dp-d { height: 42px; } }`;
		$(`<style id="sigos-pk-css">${c}</style>`).appendTo("head");
	}

	sigos.ui._interpretar_data = interpretar_data; // exposed for quick console checks
	sigos.ui._interpretar_hora = interpretar_hora;
})();
