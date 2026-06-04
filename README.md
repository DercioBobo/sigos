# SIGOS

**Sistema Integrado de Gestão Operacional de Segurança**

A Frappe/ERPNext app for security and vigilance companies. Manages guards (vigilantes), posts, shift schedules, absences, disciplinary processes, weapons, and payroll extensions.

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

### 1. Get the app into your bench

```bash
# From the bench root directory
bench get-app https://github.com/your-org/sigos
# OR, if developing locally, just place the folder in apps/ and skip get-app
```

### 2. Install into a site

```bash
bench --site your-site.localhost install-app sigos
```

This runs `bench migrate` automatically and calls `after_install`, which:
- Creates all SIGOS custom fields on Employee, Salary Slip, Project, Sales Invoice, etc.
- Seeds master data: Categorias de Vigilante, Turnos, and Regimes (H24, TDN, TDU, TDU-MT, 24h)

### 3. Build frontend assets

```bash
bench build --app sigos
```

---

## Development Setup (local bench)

```bash
# 1. Clone into the apps directory of your bench
cd /path/to/frappe-bench/apps
git clone https://github.com/your-org/sigos

# 2. Install in dev mode (editable)
bench --site your-site.localhost install-app sigos

# 3. Build assets (watch mode for JS/CSS changes)
bench watch

# 4. Start the bench
bench start
```

### After pulling new changes

```bash
bench --site your-site.localhost migrate
bench build --app sigos
```

---

## Modules

| Module | Description |
|--------|-------------|
| **Security Ops** | Vigilante, Posto de Vigilância, Escala do Vigilante, Ausências, Rotatividade, Demissão, Turnos Extras, Troca de Categoria, Troca de Regime |
| **Disciplinar** | Repreensão Disciplinar, Processo Disciplinar, Readmissão |
| **Payroll Ext** | Deduções, Proventos, Justificação de Faltas, Reclamação de Salário |
| **Armamento** | Arma, Movimentação de Arma, Alocação de Material |
| **SIGOS Setup** | Delegação, Grupo de Delegados, SIGOS Settings, Regime, Turno, Categoria Vigilante |

---

## Key Architectural Decisions

- **Vigilante ≠ Employee** — Operational identity (Vigilante) and HR/payroll identity (Employee) are separate but linked. An Employee is auto-created when a Vigilante reaches status *Pre-Admissão*. Fields sync bidirectionally via `sync.py`.
- **Escala is operational only** — Payroll never reads the schedule. Absences come exclusively from `Ausencias` documents.
- **Rolling schedule window** — Escalas hold ~3 months of day-rows. A daily job extends the horizon and trims old data. The engine is idempotent and override-safe.
- **Regime is a DocType** — Shift cycles (H24, TDN, TDU, etc.) are managed as documents, not hardcoded selects. Each Regime defines its turno sequence and how many faltas each turn counts.

---

## Fixture Export (after creating workflows / roles in the UI)

```bash
bench --site your-site.localhost export-fixtures --app sigos
```

This exports Roles, Categorias, Turnos, Regimes, Custom Fields, Property Setters, and Workflows to the fixtures declared in `hooks.py`.

---

## Uninstall

```bash
bench --site your-site.localhost uninstall-app sigos
bench --site your-site.localhost migrate
```

---

## License

MIT
