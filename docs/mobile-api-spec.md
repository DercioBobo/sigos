# SIGOS ↔ SMV Integration API — contract for the SMV developer

Status: **implemented** — `sigos/mobile_api.py`, role `SMV Integration`
(write-not-submit on Ausencias). See §0 for the one-time setup a System
Manager runs to issue credentials.

## 1. Architecture — who talks to whom

```
Guard's phone  <-->  SMV backend  <-->  SIGOS API
   (existing)        (holds the SIGOS     (this doc)
                      credential, knows
                      device -> posto)
```

Phones **never** call SIGOS directly and never hold a SIGOS credential. They
keep authenticating to SMV's own backend exactly as already built — nothing
changes there. It's SMV's backend that calls SIGOS, server-to-server, and
SMV's backend that already knows which posto a given device/request belongs
to (device↔posto assignment is already handled on SMV's side).

This is why "let SMV filter by posto on its side" is the right call here —
as long as "its side" means the SMV backend, not the phone app itself. A
phone app can be decompiled or have requests replayed with a different posto
id; there's no way to stop that on a client. The SMV backend is a real trust
boundary it already controls, so it's fine for SIGOS to trust it.

## 0. One-time setup (SIGOS side — run by a System Manager)

```
bench --site <site> execute sigos.mobile_api.configurar_integracao_smv
bench --site <site> execute sigos.mobile_api.gerar_credenciais_smv
```

The first call creates the `smv@integration.sigos.local` service user (the
`SMV Integration` role and its Ausencias permission already ship in
`ausencias.json`/`hooks.py` — `bench migrate` creates the Role itself the
first time it syncs, no extra step needed). The second call generates the
API key/secret pair and **prints the secret once** — copy both into SMV's
backend config immediately; SIGOS never displays the secret again after this
(Frappe stores it hashed). Re-running `gerar_credenciais_smv` rotates the
secret and kills the old one instantly — that's the entire "credential
leaked" runbook.

## 2. Auth

**One** SIGOS credential total — not one per posto. Issued once to SMV's
backend from §0, used for every posto:

```
Authorization: token <api_key>:<api_secret>
```

Standard Frappe API Key/Secret pair (no per-posto tokens to generate,
distribute, or rotate — onboarding posto #201 costs nothing on the SIGOS
side).

Trade-off, stated plainly: with a single shared credential, SIGOS is no
longer independently checking that one posto can't see another's data — that
enforcement now lives entirely in SMV's backend (which must always pass the
correct `posto` for the request it's handling). That's the right call given
SMV's backend is a trusted, controlled service — just worth knowing it's a
deliberate choice, not a gap that was overlooked.

Optional extra hardening (recommended, cheap): if SMV's backend runs from a
stable egress IP, ask SIGOS ops to IP-allowlist that credential —
belt-and-suspenders in case the key ever leaks.

## 3. Base URL

```
https://<site>/api/method/sigos.mobile_api.<function_name>
```

`GET` for reads, `POST` (JSON body) for writes. Standard Frappe envelope —
success is `{"message": <payload>}`; errors are HTTP 4xx/5xx with
`{"exception": "...", "_server_messages": "..."}`.

Every endpoint below takes an explicit `posto` parameter (the SIGOS
`Posto De Vigilancia` name/id) — SMV's backend must always supply the right
one for the device/request it's handling. Unknown or inactive posto → 4xx.

## 4. Endpoints

### `GET mobile_api.get_postos`
Full list of postos, for SMV's backend to sync into its own posto table —
call once at integration setup and periodically after (e.g. daily), to pick
up new/closed postos without manual re-export.
```json
[
  { "posto": "PT-MPT-01", "nome_do_posto": "Banco X — Agência Sommerschield", "delegacao": "DEL-003", "estado": "Activo" },
  { "posto": "PT-MPT-02", "nome_do_posto": "Banco X — Agência Malhangalene", "delegacao": "DEL-003", "estado": "Activo" }
]
```
`posto` (the `PT-...` code) is the value SMV should store as the foreign key
against its own posto records and the value to send as `posto` on every
other endpoint below. It's SIGOS's permanent, system-generated id for that
posto — unlike `nome_do_posto` (an editable label), it never changes once
created, so it's safe to hard-store rather than re-matching by name on every
sync.

### `GET mobile_api.get_posto_info?posto=<posto>`
Sanity check for a posto id, and basic display info.
```json
{ "posto": "PT-MPT-01", "nome_do_posto": "Banco X — Agência Sommerschield", "delegacao": "DEL-003", "estado": "Activo" }
```
4xx if `posto` doesn't exist or `estado != Activo` — use this to catch a
stale/misconfigured device↔posto mapping early rather than failing later on
a write.

### `GET mobile_api.get_opcoes`
Current option lists, so the app never hardcodes business rules that can
change from SIGOS Settings.
```json
{
  "tipo_de_ausencia": ["Falta", "Atraso", "Saída Antecipada", "Suspensão", "Licença", "Outro"],
  "subtipo_falta": ["Normal", "Vermelha"],
  "subtipo_falta_activo": true,
  "proxima_accao": ["Sem Ação", "Substituto", "Dobra de Turno", "Meia Dobra", "Adiantamento de Turno", "Horas Extras"]
}
```
(`Abandono de Posto` / `Falta de Reserva` are deliberately excluded — those
are CCO-only registration types, not something a posto marks on itself.)

### `GET mobile_api.get_escalados_hoje?posto=<posto>&data=YYYY-MM-DD` (`data` optional, defaults to today)
Roster for that posto only — the guards actually scheduled there that day.
```json
{
  "periodo_actual": "Manhã",
  "escalados": [
    {
      "vigilante": "VIG-00123",
      "nome_completo": "João Alfredo",
      "categoria": "Vigilante",
      "turno": "T-MANHA-01",
      "periodo": "Manhã",
      "ja_registado": false,
      "ja_registado_estado": null
    }
  ]
}
```
`ja_registado: true` means this guard already has an absence marked for this
data+período (draft or submitted, by anyone) — grey them out in the UI. The
write endpoint enforces this server-side too, but checking here first avoids
a round-trip failure.

### `GET mobile_api.get_candidatos?posto=<posto>&proxima_accao=<proxima_accao>&vigilante=<vigilante>&data=YYYY-MM-DD&periodo=<periodo>`
Candidate vigilantes for whichever companion field the chosen `proxima_accao`
needs on `marcar_ausencia` — call this right before showing that picker, with
the same `posto`/`vigilante`/`data`/`periodo` you're about to send there.
`vigilante`, `data`, `periodo` are all optional (`vigilante` just excludes that
guard from their own candidate pool; `data`/`periodo` default the same way
`get_escalados_hoje` does).

Each `proxima_accao` pulls from a different pool:
- `Substituto` → benched (Reserva) guards in this posto's own delegação.
- `Dobra de Turno` / `Meia Dobra` → guards already scheduled at THIS posto today
  (they're on site and can double up; Meia Dobra reuses the same pool, just
  priced for half a shift in payroll).
- `Horas Extras` → guards on FOLGA (day off) today, scoped to the posto's
  delegação, not the posto itself — any folga guard in the delegação can be
  called in, not just ones normally posted here.
- `Adiantamento de Turno` → other Activo guards at this SAME posto (one of them
  brings their own shift forward).
- `Sem Ação` → always `[]` (no companion field to fill).

```json
[
  { "vigilante": "VIG-00456", "nome_completo": "Carlos Machava", "categoria": "Vigilante" }
]
```
(Exact fields vary slightly per pool — Substituto/Adiantamento include
`categoria`; Dobra/Meia Dobra/Horas Extras include `turno` instead.)

Only *submitted* absences are excluded from these pools (same rule the
equivalent Desk pickers use) — a same-período double-booking across two still-
draft calls isn't caught here; `marcar_ausencia`'s own idempotency (by
`vigilante`+`data`+`periodo`) is what actually prevents duplicate rows.

### `POST mobile_api.marcar_ausencia`
Creates or updates one guard's absence row for the day. Always saved as a
**draft** — the SIGOS integration user has write but not submit permission
on Ausencias, enforced by SIGOS's permission grid regardless of what's sent.
CCO submits later from SIGOS.

Idempotent by `vigilante` + `data` + `periodo` — safe to retry on a flaky
phone connection without dedup logic on your side.

```json
{
  "posto": "PT-MPT-01",
  "vigilante": "VIG-00123",
  "data": "2026-08-01",
  "periodo": "Manhã",
  "tipo_de_ausencia": "Falta",
  "subtipo_falta": null,
  "tipo_justificacao": null,
  "jutificativo": null,
  "proxima_accao": "Substituto",
  "vigilante_substituto": "VIG-00456"
}
```
- `vigilante` must be one of the names `get_escalados_hoje` returned for that
  `posto`/`data`/`periodo` — re-validated server-side, so a rejection here
  means "roster changed, refresh and retry," not a bug.
- `proxima_accao` drives which one companion field is required —
  `Substituto`→`vigilante_substituto`, `Dobra de Turno`→`vigilante_a_dobrar`,
  `Meia Dobra`→`vigilante_a_meia_dobra`, `Adiantamento de Turno`→`vigilante_a_adiantar`,
  `Horas Extras`→`vigilante_a_horas_extras`. Send only the one that matches.

Response:
```json
{ "doc": "AUS-2026-000042", "row": "row-id-abc", "n_de_faltas": 1 }
```

### `POST mobile_api.remover_marca`
Undo a mark made in error, before CCO has submitted it.
```json
{ "posto": "PT-MPT-01", "ausencia_doc": "AUS-2026-000042", "ausencia_row": "row-id-abc" }
```
Fails with a clear error if the sheet is already submitted — at that point
it's CCO's document to fix, not the app's.

## 5. What NOT to do
- Don't cache/forward the SIGOS credential to any phone, ever — it lives only
  in SMV's backend config.
- Don't let a phone-supplied posto value reach SIGOS unchecked — SMV's
  backend is the thing responsible for mapping "this device/session" → "this
  posto" correctly before calling `marcar_ausencia` etc. That check is now
  the only thing enforcing posto isolation, so it needs to be solid.
- No submit action anywhere — there isn't one exposed, by design.
- No hardcoded enum values beyond `get_opcoes` — SIGOS Settings can change
  these without an SMV deploy.

## 6. Rollout note
Pilot on a handful of postos first if you like, but unlike a per-posto-token
model there's no per-posto setup cost on the SIGOS side to scale up from
there — the same one credential already covers all 200+.
