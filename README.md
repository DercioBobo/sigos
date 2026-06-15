# SIGOS

**Sistema Integrado de Gestão Operacional de Segurança** — a Frappe / ERPNext v15 installable app for security / vigilance companies in Mozambique (built for ~2900 vigilantes + ~150 admin staff).

It layers an operational + HR + payroll + armament system on top of ERPNext/HRMS, keeping the **operational identity (Vigilante)** and the **HR/payroll identity (Employee)** separate but tightly synced.

---

## Requirements

| Dependency | Version |
|------------|---------|
| Python     | 3.10+   |
| Node.js    | 18+     |
| Frappe     | v15     |
| ERPNext    | v15     |
| HRMS       | v15     |

---

## Installation

```bash
# 1. Get the app into your bench
bench get-app https://github.com/DercioBobo/sigos
# (or place the folder in apps/ when developing locally and skip get-app)

# 2. Install into a site (runs migrate + after_install)
bench --site your-site.localhost install-app sigos

# 3. Build frontend assets
bench build --app sigos
```

`after_install` loads `custom_fields.json` + `default_data.json` (idempotent): SIGOS custom fields on Employee / Salary Slip / Project, and master data (Categorias, Turnos, Regimes, …). `after_migrate` re-runs the custom-field loader, reloads orphan-prone child doctypes, and sets Employee/Project naming — so **new custom fields appear on existing sites on the next `migrate`, no reinstall needed**.

---

## Deploy & Dev loop

**Server:** Bitnami ERPNext at `~/stack/erpnext/frappe-bench`, site `erpnext-site`, OS user `bitnami`. Repo: `DercioBobo/sigos`.

**Dev loop:** edit on Windows (`PhpstormProjects/sigos`) → commit → push → pull on server.

```bash
# On the server, after pushing
cd apps/sigos && sudo git pull && sudo chown -R bitnami:bitnami .
bench --site erpnext-site migrate
bench build --app sigos        # only when JS/CSS changed
```

Uninstall: `bench --site <site> uninstall-app sigos && bench --site <site> migrate`.

---

## Modules

| Module | Doctypes |
| --- | --- |
| **Security Ops** | Vigilante, Posto De Vigilancia, Escala Do Vigilante, Ausencias, Rotatividade, Operacao De Rotatividade, Turnos Extras, Troca De Categoria, Troca De Regime, Demissao, Ocorrencia |
| **Disciplinar** | Participacao, Processo Disciplinar, Readimissao |
| **Payroll Ext** | Outras Deducoes, Outras Remuneracoes, Emprestimo, Justificacao De Faltas, Reclamacao De Salario |
| **Armamento** | Arma, Movimentacao De Arma, Alocacao De Material, Material |
| **SIGOS Setup** | SIGOS Settings (Single), Delegacao, Grupo De Delegados, Regime (+ Regime Turno Item), Turno, Categoria Vigilante, Tipo De Infracao, Tipo De Justificacao, Faturacao Mensal |

---

## Core architecture

### Vigilante ↔ Employee
Two records, one person. `Vigilante.funcionario` → `Employee`. The Employee is auto-created in `Vigilante.validate()` when status reaches an admission state. Sync lives in `sync.py`:
- **Personal data is bidirectional** (name, DOB, contacts, NUIT, document, admission date, company…).
- **Operational data is forward-only** (Vigilante → Employee `custom_*` mirrors, read-only on Employee): categoria, regime, posto, delegação.
- The copy helper **fills but never clears** (an empty source never nulls the target). Loop-safe via `flags.ignore_sync`.

A vigilante and their Employee **share one number**: `VIG-02` ↔ `FUNC-02`. `FUNC-` is reserved for vigilante employees; admin staff use the separate `ADM-.##` series.

### Keystone — "the escala follows the guard"
`migrar_escala_vigilante(...)` in `escala_do_vigilante.py` is the single engine that moves a guard between `(posto, regime)` escalas. It is triggered automatically by `Vigilante.on_update` diffing before/after posto+regime — so **Rotatividade, Troca De Regime, and manual edits all migrate identically**. There is exactly **one Escala per (posto, regime)** pair, holding a rolling ~3-month window of day-rows. Past escala data has no downstream use (payroll reads Ausencias only).

### Posto = codename, not a series
A Posto's **ID is the codename you type** (e.g. `BC-59`, `H10`) — `autoname: "prompt"`. `nome_do_posto` is the descriptive name. Every doctype that links a Posto also carries a read-only `…_nome` field (`fetch_from`) so both the code and the human name show.

### Contract model
`Customer → Project (Contract) → Posto → Vigilante`. You set `Posto.project`; `Posto.cliente` is fetched from it. Per-regime rates live in `Project.custom_regime_rates` (child rows), with `custom_valor_do_contrato` as the fallback. `posto_interno = 1` marks a company-owned post (no contract / not billed). Projects are named after the customer ("Access Bank 01"), not `PROJ-####`.

### Payroll
Salary-Slip-driven (`payroll_ext/salary_slip_hooks.py`).
- **Escala is purely operational — payroll never reads it.** Faltas come exclusively from **Ausencias** (sum of `n_de_faltas`).
- `custom_dias_de_trabalho` is the monthly divisor (days in the period, not from escala).
- Faltas deduction is computed in Python, so the **"Faltas" Salary Component must NOT be formula-based** in ERPNext.
- Earnings: subsídios / arma / Outras Remuneracoes / retroativo. Deductions: Outras Deducoes / Emprestimo / Faltas.

### Vigilante timeline
Every operational doc writes an Info Comment against the Vigilante via `timeline.py registar(vigilante, texto, origem)` (never throws). New operations should call `registar` too.

---

## Workflows (approval)

Workflows are **optional and user-created** — none ship with the app. Controllers and payroll queries are written to work with or without one:
- Controllers guard with `(self.get("workflow_state") or "Aprovado") != "Aprovado"`.
- Payroll uses `_aprovado_filter(dt)`, which only adds the `workflow_state` filter if the doctype actually has that field.

### Canonical state names (use these exactly)
The fixture in `hooks.py` ships these Workflow States — **reuse them verbatim**:

```
Rascunho · Pendente De Aprovação · Aprovado · Rejeitado · Cancelado
```

The approval contract is **Rascunho → Pendente De Aprovação → Aprovado**, where **Aprovado must set `docstatus = 1`** (a Submit action). That is what fires each doc's `on_submit` (timeline writes, payroll eligibility, escala side-effects).

### Activating a workflow on Ausencias (deck-aware)
The Ausencias deck (`ausencias.js`) is already built to detect and cooperate with a workflow — **no code change needed**. When you create one:

1. **Name the intermediate state exactly `Pendente De Aprovação`.** That literal string drives the deck's lock: header read-only, cards read-only, a "Pendente de Aprovação" chip, and the footer CTA is withdrawn so the approver uses the native workflow buttons. Any other name and the deck silently won't lock.
2. **The `Aprovado` transition must set `docstatus → 1`.** Otherwise `on_submit` never runs — no timeline entry, no next-shift faltas recompute.
3. **Keep the field name `workflow_state`** (Frappe's default — the deck checks `has_field("Ausencias", "workflow_state")`).
4. **Give the submitter a single outgoing transition from the draft state.** The deck CTA ("Enviar para Aprovação") auto-applies the first available transition. The approver's Approve/Reject choices are handled by the native workflow buttons, since the deck hides its CTA while the doc is locked.
5. `motivo_atraso` stays editable even while locked — intentional (a late-submission justification can still be added after sending for approval).

The same naming + `docstatus → 1` rules apply to any other doctype you put a workflow on. Export workflows you build in the UI with `bench --site <site> export-fixtures --app sigos`.

---

## Permissions model

Role separation between **Operations** and **HR** is enforced with Frappe **permission levels** (not client JS):
- **L0** = shared identity / base fields (create, delete, submit live here).
- **L1** = Operational data — write: `Aprovador Operações` + managers.
- **L2** = HR data — write: `Aprovador RH` + managers.

Cross-visibility is **read-only**: every role can *read* all levels, so the other side's tab shows but is locked (not hidden). Applied on **Vigilante** (Dados Operacionais = L1, Dados RH = L2) and **Processo Disciplinar** (Decisão tab = L1, write: HR + managers — sanctions/payroll locked from Ops).

Writer sets: **OPS** = {System Manager, SIGOS Manager, Aprovador Operações}; **HR** = {System Manager, SIGOS Manager, Aprovador RH}. `Operações SIGOS` is read-only on these two doctypes.

> A save only needs write permission on the fields actually **changed**, so single-side edits and server `ignore_permissions` sync flows are unaffected. Note: `anexar_documento` sits at the tail of the Ops tab (L1) — move it to L0 if HR needs to attach documents.

---

## Naming conventions

- **Entities / persistent registry → `XXX-.##`** (2-digit counter, no year, grows past 99): Vigilante `VIG-.##`, Arma `ARM-.##`, Escala Do Vigilante `ESC-.##`.
- **Posto De Vigilancia → no series** — ID is the typed codename (`autoname: "prompt"`).
- **Transactional / event docs → `XXX-.YY.-.##`** (2-digit year + counter): Participacao, Processo Disciplinar (`PD-.YY.-.##`), Demissao, Readimissao, Rotatividade, Troca De Categoria/Regime, Turnos Extras, Ocorrencia, Alocacao De Material, Movimentacao De Arma, Outras Deducoes (DED), Outras Remuneracoes (PROV), Emprestimo, Justificacao De Faltas (JF), Reclamacao De Salario (RS), Faturacao Mensal (FAT).
- **Field-named masters keep title naming** (`autoname: field:…`): Categoria Vigilante, Delegacao, Regime, Turno, Material, Tipo De Infracao, Tipo De Justificacao, Operacao De Rotatividade, Grupo De Delegados.
- **Employees:** vigilantes forced to `FUNC-<n>`; admin staff use `ADM-.##`.

Changing a `naming_series` option only affects **new** records; existing names are untouched.

---

## Developer conventions & gotchas (hard-won)

1. **DocType name MUST equal `folder.replace('_',' ').title()`** — `frappe.unscrub` is title-case, so a folder `posto_de_vigilancia` ⇒ doctype `Posto De Vigilancia` (capital `De`/`Do`). A mismatch makes `migrate` delete the doctype as orphaned and throws `ImportError` on save. Always Title-Case-match when adding a doctype.
2. **DB doctype/field names are ASCII**; accents only in labels/options/descriptions.
3. **CSS must be pure ASCII** — multibyte box-drawing chars (`─ ═ —`) got mangled by the server build pipeline and dropped whole rules. `.gitattributes` enforces LF + UTF-8 for css/js/py/json/md. Fonts load via JS `<link>` injection, not CSS `@import`. The Rotatividade wizard and the Ausencias deck self-inject their CSS as belt-and-suspenders.
4. **Custom fields & Property Setters use `module: "SIGOS Setup"`** (not `"SIGOS"`, which isn't a Module Def). Add new fields to `custom_fields.json` — they load on the next `migrate`.
5. **`patches.txt` sections are `[pre_model_sync]` / `[post_model_sync]`** (not `pre_migrate`).
6. **`requirements.txt` must be empty** (frappe/erpnext aren't PyPI packages); `pyproject.toml` with the setuptools backend is required.
7. **`Tab Vigilante Do Posto`** is reloaded in `after_migrate` because Frappe syncs modules alphabetically and would orphan it (its Turno link in SIGOS Setup doesn't exist yet during security_ops sync).
8. **Workspace JSON needs a `"title"` field** or the v15 sidebar `slug()` crashes on null.
9. **`hooks.py doc_events` must NOT duplicate a doctype's own controller methods** (`on_submit`, `before_save`, …) — wiring a doc_event to what is actually a class method raises `AttributeError`. Only cross-cutting hooks remain (Vigilante/Employee → `sync.py`, Salary Slip → `salary_slip_hooks.py`).
10. **Don't rebuild `field_order` from scratch** in layout scripts — it silently drops fields not in the new list (this once dropped `naming_series` from 11 doctypes → `AttributeError` on save).
11. **Smoke tests live at app root** (`sigos.smoke_rotatividade`), never in a `tests/` package (clashes with Frappe test discovery).

---

## SIGOS Settings (Single)

All tunables live here, e.g. `dias_minimos_rotatividade` (90), `hora_limite_manha` (09:30), `hora_limite_noite` (18:30), `prazo_justificacao_faltas` (3), `percentagem_maxima_emprestimo` (30%), `meses_maximos_emprestimo` (3), `valor_padrao_uniforme` (3240), `valor_subsidio_arma` (300), `base_dias_de_trabalho`, `metodo_calculo_faltas`, and Salary Component references.

---

## Fixtures & smoke test

```bash
# Export Roles, masters, Custom Fields, Property Setters, Workflows (per hooks.py)
bench --site erpnext-site export-fixtures --app sigos

# Smoke test: 11 assertions across keystone / preview / TPV / APV / DEM, auto-cleanup
bench --site erpnext-site execute sigos.smoke_rotatividade.run
```

---

## License

MIT
