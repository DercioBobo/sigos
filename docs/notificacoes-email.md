# SIGOS — Notificações por Email (Ausências e Disciplina)

Cada bloco abaixo é uma **Notification** do Frappe. Crie-as em **Definições → Notification → Novo** e copie os valores campo a campo.

---

## Antes de começar

1. **Conta de email de saída**: *Email Account* com **Default Outgoing** activo e testado.
2. **Utilizadores com email** e com o papel certo:

   | Papel | Quem | Usado como |
   |---|---|---|
   | `Operações SIGOS` | CCO / operadores | CCO |
   | `Aprovador Operações` | Chefe de operações | CCO |
   | `Aprovador RH`, `RH Normal` | Recursos Humanos | RH |
   | `Jurista` | Departamento jurídico | Jurista |
   | `SIGOS Manager` | Gestão | Gestor |

3. **Código actualizado** no servidor (as notificações com *Send Alert On = Method* dependem de sinais do SIGOS):
   `bench --site erpnext-site migrate` e `bench restart`.
4. Em cada Notification:
   - **Channel**: `Email`
   - **Message Type**: `HTML`
   - **Enabled**: ✓
   - **Send System Notification**: ✓ (opcional — também aparece no sino)
   - Destinatários: tabela **Recipients**, uma linha por papel, coluna **Receiver By Role**.

> **Send Alert On**
> - `New` — quando o documento é criado.
> - `Submit` — quando é submetido.
> - `Value Change` — quando o campo indicado em *Value Changed* muda (use com *Condition*).
> - `Days Before` / `Days After` — verificado uma vez por dia contra a data em *Reference Date*.
> - `Method` — sinal enviado pelo SIGOS (escreva o nome exacto em *Method*).

---

## Resumo

| # | Notificação | Documento | Quando | Para |
|---|---|---|---|---|
| N01 | Limite de faltas atingido | Vigilante | Method | CCO, Jurista |
| N02 | Presunção de Abandono aberta | Presuncao De Abandono | New | CCO, RH, Jurista |
| N03 | Presunção — mudança de estado | Presuncao De Abandono | Value Change | CCO, RH |
| N04 | Regresso de abandono | Presuncao De Abandono | Value Change | RH, CCO |
| N05 | Vigilante doente | Baixa Medica | New | CCO, RH |
| N06 | Regresso de baixa médica | Baixa Medica | Value Change | RH, CCO |
| N07 | Salário congelado | Vigilante | Method | RH |
| N08 | Salário descongelado | Vigilante | Method | RH |
| N09 | Justificação de faltas | Justificacao De Faltas | Submit | RH, CCO |
| N10 | Participação por submeter | Participacao | New | Aprovador Operações |
| N11 | Participação submetida | Participacao | Submit | Jurista |
| N12 | Participação fora de prazo | Participacao | Submit | Gestor |
| N13 | Prazo do processo a terminar | Participacao | Days After | Jurista |
| N14 | Suspensão preventiva | Participacao | Method | RH, Jurista, CCO |
| N15 | Fim da suspensão preventiva | Participacao | Method | RH, CCO |
| N16 | Repreensão registada | Repreensao | Submit | CCO, RH |
| N17 | Limite de repreensões | Repreensao | Submit | Jurista, Gestor |
| N18 | Processo disciplinar aberto | Processo Disciplinar | New | RH, CCO |
| N19 | Prazo de defesa a terminar | Processo Disciplinar | Days Before | Jurista |
| N20 | Diligências pedidas | Processo Disciplinar | Value Change | Jurista |
| N21 | Processo com o Sindicato | Processo Disciplinar | Method | Jurista, Gestor |
| N22 | Decisão a vencer | Processo Disciplinar | Days Before | Jurista, Gestor |
| N23 | Processo caducado | Processo Disciplinar | Method | Jurista, Gestor |
| N24 | Decisão do processo | Processo Disciplinar | Submit | RH, CCO |
| N25 | Despedimento registado | Demissao | Submit | RH, CCO |

---

## A. Abandono de Posto

### N01 — Limite de faltas atingido

Só é útil no modo **Apenas Alerta**. No modo Automático a Presunção abre na mesma noite (N02).

| Campo | Valor |
|---|---|
| Document Type | `Vigilante` |
| Send Alert On | `Method` |
| Method | `sigos_limite_faltas_atingido` |
| Recipients | `Operações SIGOS`, `Aprovador Operações`, `Jurista` |

**Subject**
```
Possível abandono: {{ doc.nome_completo }} ({{ doc.mecanografico }})
```
**Message**
```html
<p>O vigilante <b>{{ doc.nome_completo }}</b> (Nº {{ doc.mecanografico }}, {{ doc.delegacao }}) atingiu o limite de ausências seguidas.</p>
<p>Ausente desde: <b>{{ frappe.utils.formatdate(doc.abandono_primeira_falta) }}</b><br>
Posto: {{ doc.nome_do_posto or "—" }}</p>
<p>Abra o vigilante e use <b>Criar Presunção de Abandono</b>.</p>
<p><a href="{{ frappe.utils.get_url_to_form('Vigilante', doc.name) }}">Abrir vigilante</a></p>
```

### N02 — Presunção de Abandono aberta

| Campo | Valor |
|---|---|
| Document Type | `Presuncao De Abandono` |
| Send Alert On | `New` |
| Attach Print | ✓ — Print Format `Presunção de Abandono` (opcional) |
| Recipients | `Operações SIGOS`, `Aprovador Operações`, `Aprovador RH`, `RH Normal`, `Jurista` |

**Subject**
```
Presunção de Abandono {{ doc.name }} — {{ doc.nome_do_vigilante }}
```
**Message**
```html
<p>Foi aberta a Presunção de Abandono <b>{{ doc.name }}</b>.</p>
<table>
<tr><td>Vigilante</td><td><b>{{ doc.nome_do_vigilante }}</b> (Nº {{ doc.mecanografico }})</td></tr>
<tr><td>Delegação</td><td>{{ doc.delegacao }}</td></tr>
<tr><td>Posto</td><td>{{ doc.posto_de_vigilancia or "—" }}</td></tr>
<tr><td>Ausente desde</td><td>{{ frappe.utils.formatdate(doc.primeira_falta) }}</td></tr>
<tr><td>Faltas</td><td>{{ doc.total_faltas }} ({{ doc.total_dias }} dia(s))</td></tr>
</table>
<p><b>Efeitos:</b> o vigilante saiu do posto e da escala, o salário está congelado e não se registam faltas.</p>
<ul>
<li><b>CCO:</b> colocar outro vigilante no posto.</li>
<li><b>Jurista:</b> analisar e encaminhar para processo.</li>
<li><b>RH:</b> o vigilante fica fora das folhas até ao regresso.</li>
</ul>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir a Presunção</a></p>
```

### N03 — Presunção: mudança de estado

| Campo | Valor |
|---|---|
| Document Type | `Presuncao De Abandono` |
| Send Alert On | `Value Change` |
| Value Changed | `estado` |
| Condition | `doc.estado in ("Em Análise", "Encaminhada para Processo", "Arquivada")` |
| Recipients | `Operações SIGOS`, `Aprovador RH` |

**Subject**
```
Presunção {{ doc.name }} — {{ doc.estado }}
```
**Message**
```html
<p>A Presunção de Abandono de <b>{{ doc.nome_do_vigilante }}</b> passou a <b>{{ doc.estado }}</b>.</p>
{% if doc.processo_disciplinar %}<p>Processo Disciplinar: <b>{{ doc.processo_disciplinar }}</b></p>{% endif %}
{% if doc.nota_fecho %}<p>Motivo: {{ doc.nota_fecho }}</p>{% endif %}
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir a Presunção</a></p>
```

### N04 — Regresso de abandono

| Campo | Valor |
|---|---|
| Document Type | `Presuncao De Abandono` |
| Send Alert On | `Value Change` |
| Value Changed | `estado` |
| Condition | `doc.estado == "Regressou"` |
| Recipients | `Aprovador RH`, `RH Normal`, `Operações SIGOS` |

**Subject**
```
Regressou do abandono: {{ doc.nome_do_vigilante }}
```
**Message**
```html
<p><b>{{ doc.nome_do_vigilante }}</b> (Nº {{ doc.mecanografico }}) regressou.</p>
<p>Período não pago: {{ frappe.utils.formatdate(doc.abandono_desde) }} a {{ frappe.utils.formatdate(doc.abandono_ate) }}</p>
<p><b>RH:</b> o salário foi descongelado — processe as folhas em falta.</p>
<p><a href="{{ frappe.utils.get_url_to_form('Vigilante', doc.vigilante) }}">Abrir vigilante</a></p>
```

---

## B. Doença

### N05 — Vigilante doente

| Campo | Valor |
|---|---|
| Document Type | `Baixa Medica` |
| Send Alert On | `New` |
| Recipients | `Operações SIGOS`, `Aprovador Operações`, `Aprovador RH`, `RH Normal` |

**Subject**
```
Baixa médica: {{ doc.nome_do_vigilante }} desde {{ frappe.utils.formatdate(doc.data_inicio) }}
```
**Message**
```html
<p><b>{{ doc.nome_do_vigilante }}</b> (Nº {{ doc.mecanografico }}, {{ doc.delegacao }}) está doente desde <b>{{ frappe.utils.formatdate(doc.data_inicio) }}</b>.</p>
<p>Posto anterior: {{ doc.posto_anterior or "—" }}</p>
<ul>
<li><b>CCO:</b> o turno ficou como vaga — colocar substituto.</li>
<li><b>RH:</b> salário congelado até ao regresso.</li>
</ul>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir a Baixa Médica</a></p>
```

### N06 — Regresso de baixa médica

| Campo | Valor |
|---|---|
| Document Type | `Baixa Medica` |
| Send Alert On | `Value Change` |
| Value Changed | `estado` |
| Condition | `doc.estado == "Concluída"` |
| Recipients | `Aprovador RH`, `RH Normal`, `Operações SIGOS` |

**Subject**
```
Regresso de baixa: {{ doc.nome_do_vigilante }} ({{ doc.dias }} dia(s), {{ doc.pago_por }})
```
**Message**
```html
<p><b>{{ doc.nome_do_vigilante }}</b> regressou a {{ frappe.utils.formatdate(doc.data_regresso) }} — destino: {{ doc.destino_regresso }}.</p>
<p>Dias de baixa: <b>{{ doc.dias }}</b> · Pago por: <b>{{ doc.pago_por }}</b></p>
{% if doc.pago_por == "INSS" %}<p><b>RH:</b> tratar o subsídio de doença com o INSS. Os dias são descontados na folha.</p>{% endif %}
<p><b>RH:</b> salário descongelado — processe as folhas em falta.</p>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir a Baixa Médica</a></p>
```

---

## C. Salário

### N07 — Salário congelado

| Campo | Valor |
|---|---|
| Document Type | `Vigilante` |
| Send Alert On | `Method` |
| Method | `sigos_salario_congelado` |
| Recipients | `Aprovador RH`, `RH Normal` |

**Subject**
```
Salário congelado: {{ doc.nome_completo }} ({{ doc.mecanografico }})
```
**Message**
```html
<p>O salário de <b>{{ doc.nome_completo }}</b> foi congelado a {{ frappe.utils.formatdate(doc.salario_congelado_desde) }}.</p>
<p>Motivo: {{ doc.salario_congelado_motivo }}<br>Estado: {{ doc.status }}</p>
<p>Fica fora das Payroll Entries até ser descongelado.</p>
<p><a href="{{ frappe.utils.get_url_to_form('Vigilante', doc.name) }}">Abrir vigilante</a></p>
```

### N08 — Salário descongelado

| Campo | Valor |
|---|---|
| Document Type | `Vigilante` |
| Send Alert On | `Method` |
| Method | `sigos_salario_descongelado` |
| Recipients | `Aprovador RH`, `RH Normal` |

**Subject**
```
Salário descongelado: {{ doc.nome_completo }} — processar folhas em falta
```
**Message**
```html
<p>O salário de <b>{{ doc.nome_completo }}</b> (Nº {{ doc.mecanografico }}) foi descongelado. Estado actual: {{ doc.status }}.</p>
<p>Crie as Salary Slips dos meses em falta (desde a última folha processada).</p>
<p><a href="{{ frappe.utils.get_url_to_form('Vigilante', doc.name) }}">Abrir vigilante</a></p>
```

---

## D. Justificações

### N09 — Justificação de faltas

| Campo | Valor |
|---|---|
| Document Type | `Justificacao De Faltas` |
| Send Alert On | `Submit` |
| Recipients | `Aprovador RH`, `RH Normal`, `Operações SIGOS` |

**Subject**
```
Faltas justificadas: {{ frappe.db.get_value("Vigilante", doc.vigilante, "nome_completo") }}{% if doc.doenca %} (doença){% endif %}
```
**Message**
```html
<p>Justificação <b>{{ doc.name }}</b> de {{ frappe.db.get_value("Vigilante", doc.vigilante, "nome_completo") }}.</p>
<p>Período: {{ frappe.utils.formatdate(doc.dia_de_inicio) }} a {{ frappe.utils.formatdate(doc.dia_de_fim) }} · {{ doc.numero }} falta(s) justificada(s)</p>
{% if doc.doenca %}<p><b>Doença (atestado médico).</b> Até 3 dias paga a empresa; mais, os dias são pagos pelo INSS.</p>{% endif %}
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir a Justificação</a></p>
```

---

## E. Participação

### N10 — Participação por submeter

| Campo | Valor |
|---|---|
| Document Type | `Participacao` |
| Send Alert On | `New` |
| Recipients | `Aprovador Operações` |

**Subject**
```
Participação por submeter: {{ doc.nome_do_vigilante }}
```
**Message**
```html
<p>O CCO criou a Participação <b>{{ doc.name }}</b> sobre <b>{{ doc.nome_do_vigilante }}</b> ({{ doc.tipo_de_infracao }}).</p>
<p>Data de conhecimento: {{ frappe.utils.formatdate(doc.data_conhecimento_infracao) }}. O processo tem de ser aberto até 15 dias depois.</p>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Rever e submeter</a></p>
```

### N11 — Participação submetida

| Campo | Valor |
|---|---|
| Document Type | `Participacao` |
| Send Alert On | `Submit` |
| Attach Print | ✓ — Print Format `Participação` (opcional) |
| Recipients | `Jurista` |

**Subject**
```
Participação {{ doc.name }} — {{ doc.nome_do_vigilante }} ({{ doc.gravidade }})
```
**Message**
```html
<p>Nova Participação para decisão: <b>Repreensão</b> ou <b>Processo Disciplinar</b>.</p>
<table>
<tr><td>Vigilante</td><td><b>{{ doc.nome_do_vigilante }}</b> (Nº {{ doc.mecanografico }})</td></tr>
<tr><td>Infracções</td><td>{% for r in doc.infracoes %}{{ r.tipo_de_infracao }}{% if not loop.last %}, {% endif %}{% endfor %}</td></tr>
<tr><td>Gravidade</td><td>{{ doc.gravidade }}</td></tr>
<tr><td>Ocorrência</td><td>{{ frappe.utils.formatdate(doc.data) }} {{ doc.horas or "" }} · {{ doc.posto_nome or doc.posto or "" }}</td></tr>
<tr><td>Participante</td><td>{{ doc.participante_nome }}</td></tr>
<tr><td>Conhecimento</td><td>{{ frappe.utils.formatdate(doc.data_conhecimento_infracao) }}</td></tr>
</table>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir a Participação</a></p>
```

### N12 — Participação fora de prazo

| Campo | Valor |
|---|---|
| Document Type | `Participacao` |
| Send Alert On | `Submit` |
| Condition | `doc.fora_de_prazo` |
| Recipients | `SIGOS Manager` |

**Subject**
```
Participação fora de prazo: {{ doc.name }}
```
**Message**
```html
<p>A Participação <b>{{ doc.name }}</b> ({{ doc.nome_do_vigilante }}) foi criada fora de prazo.</p>
<p>Justificação: {{ doc.justificacao_fora_de_prazo }}</p>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir a Participação</a></p>
```

### N13 — Prazo do processo a terminar

Lembrete 3 dias antes do fim do prazo de 15 dias. Se mudar o prazo em SIGOS Settings, ajuste *Days Before or After*.

| Campo | Valor |
|---|---|
| Document Type | `Participacao` |
| Send Alert On | `Days After` |
| Reference Date | `data_conhecimento_infracao` |
| Days Before or After | `12` |
| Condition | `doc.docstatus == 1 and not doc.processo_disciplinar and not doc.repreensao` |
| Recipients | `Jurista` |

**Subject**
```
Faltam 3 dias para abrir o processo: {{ doc.nome_do_vigilante }}
```
**Message**
```html
<p>A Participação <b>{{ doc.name }}</b> ainda não tem decisão. O prazo para abrir o Processo Disciplinar termina dentro de 3 dias.</p>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir a Participação</a></p>
```

### N14 — Suspensão preventiva

| Campo | Valor |
|---|---|
| Document Type | `Participacao` |
| Send Alert On | `Method` |
| Method | `sigos_suspensao_preventiva` |
| Recipients | `Aprovador RH`, `RH Normal`, `Jurista`, `Operações SIGOS` |

**Subject**
```
Suspensão preventiva: {{ doc.nome_do_vigilante }} ({{ doc.suspensao_remuneracao }})
```
**Message**
```html
<p><b>{{ doc.nome_do_vigilante }}</b> foi suspenso preventivamente desde {{ frappe.utils.formatdate(doc.suspensao_desde) }} (Participação {{ doc.name }}).</p>
<p>Remuneração: <b>{{ doc.suspensao_remuneracao }}</b><br>Posto anterior: {{ doc.suspensao_posto or "—" }}</p>
<ul>
<li><b>CCO:</b> o turno ficou como vaga.</li>
<li><b>Jurista:</b> conduzir o processo.</li>
<li><b>RH:</b> aplicar a remuneração escolhida.</li>
</ul>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir a Participação</a></p>
```

### N15 — Fim da suspensão preventiva

| Campo | Valor |
|---|---|
| Document Type | `Participacao` |
| Send Alert On | `Method` |
| Method | `sigos_suspensao_terminada` |
| Recipients | `Aprovador RH`, `RH Normal`, `Operações SIGOS` |

**Subject**
```
Fim da suspensão preventiva: {{ doc.nome_do_vigilante }}
```
**Message**
```html
<p>A suspensão preventiva de <b>{{ doc.nome_do_vigilante }}</b> terminou ({{ frappe.utils.formatdate(doc.suspensao_desde) }} a {{ frappe.utils.formatdate(doc.suspensao_ate) }}).</p>
<p>Destino: {{ doc.suspensao_destino }} · Remuneração do período: <b>{{ doc.suspensao_remuneracao }}</b></p>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir a Participação</a></p>
```

---

## F. Repreensão

### N16 — Repreensão registada

| Campo | Valor |
|---|---|
| Document Type | `Repreensao` |
| Send Alert On | `Submit` |
| Recipients | `Operações SIGOS`, `Aprovador RH` |

**Subject**
```
{{ doc.numero }}.ª repreensão: {{ doc.nome_do_vigilante }}
```
**Message**
```html
<p>O Jurista registou a <b>{{ doc.numero }}.ª repreensão</b> de <b>{{ doc.nome_do_vigilante }}</b> (Nº {{ doc.mecanografico }}).</p>
<p>Infracções: {{ doc.infracoes }}</p>
{% if doc.observacoes %}<p>Observações: {{ doc.observacoes }}</p>{% endif %}
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir a Repreensão</a></p>
```

### N17 — Limite de repreensões

Ajuste o `3` se mudar "Repreensões até Propor Processo" em SIGOS Settings.

| Campo | Valor |
|---|---|
| Document Type | `Repreensao` |
| Send Alert On | `Submit` |
| Condition | `doc.numero >= 3` |
| Recipients | `Jurista`, `SIGOS Manager` |

**Subject**
```
Limite de repreensões: {{ doc.nome_do_vigilante }} ({{ doc.numero }}.ª)
```
**Message**
```html
<p><b>{{ doc.nome_do_vigilante }}</b> chegou à <b>{{ doc.numero }}.ª repreensão</b> desde o último processo.</p>
<p>Avalie a abertura de um Processo Disciplinar.</p>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir a Repreensão</a></p>
```

---

## G. Processo Disciplinar

### N18 — Processo disciplinar aberto

| Campo | Valor |
|---|---|
| Document Type | `Processo Disciplinar` |
| Send Alert On | `New` |
| Recipients | `Aprovador RH`, `Operações SIGOS` |

**Subject**
```
Processo disciplinar {{ doc.name }} — {{ doc.nome_do_vigilante }}
```
**Message**
```html
<p>Foi aberto o Processo Disciplinar <b>{{ doc.name }}</b>.</p>
<table>
<tr><td>Vigilante</td><td><b>{{ doc.nome_do_vigilante }}</b> (Nº {{ doc.mecanografico }})</td></tr>
<tr><td>Origem</td><td>{{ doc.origem }} {{ doc.participacao_referente or doc.presuncao_referente or "" }}</td></tr>
<tr><td>Motivo</td><td>{{ doc.motivo }}</td></tr>
<tr><td>Prazo de defesa</td><td>{{ frappe.utils.formatdate(doc.prazo_defesa) }}</td></tr>
<tr><td>Decisão até</td><td>{{ frappe.utils.formatdate(doc.prazo_decisao) }}</td></tr>
</table>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir o processo</a></p>
```

### N19 — Prazo de defesa a terminar

| Campo | Valor |
|---|---|
| Document Type | `Processo Disciplinar` |
| Send Alert On | `Days Before` |
| Reference Date | `prazo_defesa` |
| Days Before or After | `2` |
| Condition | `doc.docstatus == 0 and not doc.defesa_apresentada` |
| Recipients | `Jurista` |

**Subject**
```
Defesa termina a {{ frappe.utils.formatdate(doc.prazo_defesa) }}: {{ doc.nome_do_vigilante }}
```
**Message**
```html
<p>O prazo de defesa do processo <b>{{ doc.name }}</b> termina dentro de 2 dias e a defesa ainda não foi registada.</p>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir o processo</a></p>
```

### N20 — Diligências pedidas

| Campo | Valor |
|---|---|
| Document Type | `Processo Disciplinar` |
| Send Alert On | `Value Change` |
| Value Changed | `data_pedido_diligencias` |
| Condition | `doc.data_pedido_diligencias` |
| Recipients | `Jurista` |

**Subject**
```
Diligências pedidas: {{ doc.name }} (até {{ frappe.utils.formatdate(doc.prazo_diligencias) }})
```
**Message**
```html
<p>O vigilante <b>{{ doc.nome_do_vigilante }}</b> pediu diligências no processo <b>{{ doc.name }}</b>.</p>
<p>Pedido: {{ doc.diligencias_pedidas }}</p>
<p>Têm de ser concluídas até <b>{{ frappe.utils.formatdate(doc.prazo_diligencias) }}</b>; depois o processo passa para o Sindicato.</p>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir o processo</a></p>
```

### N21 — Processo com o Sindicato

| Campo | Valor |
|---|---|
| Document Type | `Processo Disciplinar` |
| Send Alert On | `Method` |
| Method | `sigos_pd_sindicato` |
| Recipients | `Jurista`, `SIGOS Manager` |

**Subject**
```
Processo {{ doc.name }} passou para o Sindicato
```
**Message**
```html
<p>As diligências do processo de <b>{{ doc.nome_do_vigilante }}</b> ultrapassaram o prazo. O processo é agora da responsabilidade do Sindicato (desde {{ frappe.utils.formatdate(doc.sindicato_desde) }}).</p>
<p>Registe o parecer do Sindicato e a decisão até {{ frappe.utils.formatdate(doc.prazo_decisao) }}.</p>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir o processo</a></p>
```

### N22 — Decisão a vencer

| Campo | Valor |
|---|---|
| Document Type | `Processo Disciplinar` |
| Send Alert On | `Days Before` |
| Reference Date | `prazo_decisao` |
| Days Before or After | `3` |
| Condition | `doc.docstatus == 0` |
| Recipients | `Jurista`, `SIGOS Manager` |

**Subject**
```
Decisão final até {{ frappe.utils.formatdate(doc.prazo_decisao) }}: {{ doc.name }}
```
**Message**
```html
<p>O processo de <b>{{ doc.nome_do_vigilante }}</b> caduca dentro de 3 dias sem decisão final.</p>
<p>Fase actual: {{ doc.fase }}</p>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir o processo</a></p>
```

### N23 — Processo caducado

| Campo | Valor |
|---|---|
| Document Type | `Processo Disciplinar` |
| Send Alert On | `Method` |
| Method | `sigos_pd_caducado` |
| Recipients | `Jurista`, `SIGOS Manager` |

**Subject**
```
Processo caducado: {{ doc.name }} — {{ doc.nome_do_vigilante }}
```
**Message**
```html
<p>O processo <b>{{ doc.name }}</b> não teve decisão até {{ frappe.utils.formatdate(doc.prazo_decisao) }} e caducou.</p>
<p>Só um gestor pode ainda decidir, com justificação.</p>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir o processo</a></p>
```

### N24 — Decisão do processo

| Campo | Valor |
|---|---|
| Document Type | `Processo Disciplinar` |
| Send Alert On | `Submit` |
| Recipients | `Aprovador RH`, `RH Normal`, `Operações SIGOS`, `Aprovador Operações` |

**Subject**
```
Decisão {{ doc.name }}: {{ doc.decisao }} — {{ doc.nome_do_vigilante }}
```
**Message**
```html
<p>O processo <b>{{ doc.name }}</b> de <b>{{ doc.nome_do_vigilante }}</b> (Nº {{ doc.mecanografico }}) foi decidido: <b>{{ doc.decisao }}</b>.</p>
{% if doc.decisao == "Suspensão do Trabalho" %}
<p>Suspensão de {{ doc.suspensao_dias }} dia(s): {{ frappe.utils.formatdate(doc.suspensao_inicio) }} a {{ frappe.utils.formatdate(doc.suspensao_fim) }}, sem remuneração.<br>
<b>CCO:</b> cobrir os turnos destes dias.</p>
{% elif doc.decisao == "Multa" %}
<p>Multa de {{ doc.multa_dias }} dia(s) de salário: <b>{{ frappe.utils.fmt_money(doc.multa_valor) }}</b>, a descontar a partir de {{ frappe.utils.formatdate(doc.data_de_inicio) }}.</p>
{% elif doc.decisao == "Despromoção" %}
<p>Despromoção para <b>{{ doc.despromocao_categoria }}</b> de {{ frappe.utils.formatdate(doc.despromocao_inicio) }} a {{ frappe.utils.formatdate(doc.despromocao_fim) }} (depois volta a {{ doc.categoria_anterior }}).</p>
{% elif doc.decisao == "Despedimento" %}
<p>O vigilante foi despedido. <b>CCO:</b> confirmar a vaga no posto. <b>RH:</b> acerto final e material por devolver.</p>
{% endif %}
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir o processo</a></p>
```

### N25 — Despedimento registado

Abrange também as saídas registadas pelo RH sem processo (rescisão, fim de contrato).

| Campo | Valor |
|---|---|
| Document Type | `Demissao` |
| Send Alert On | `Submit` |
| Recipients | `Aprovador RH`, `RH Normal`, `Operações SIGOS` |

**Subject**
```
Saída registada: {{ frappe.db.get_value("Vigilante", doc.vigilante, "nome_completo") }} ({{ frappe.utils.formatdate(doc.data_de_demissao) }})
```
**Message**
```html
<p>Foi registada a saída de <b>{{ frappe.db.get_value("Vigilante", doc.vigilante, "nome_completo") }}</b> (Nº {{ doc.mecanografico }}, {{ doc.delegacao }}) a {{ frappe.utils.formatdate(doc.data_de_demissao) }}.</p>
<p>Motivo: {{ doc.motivo }}</p>
<ul>
<li><b>RH:</b> acerto final; recolher uniforme e material.</li>
<li><b>CCO:</b> o vigilante saiu do posto e da escala.</li>
</ul>
<p><a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}">Abrir a Demissão</a></p>
```

---

## Testar

1. Crie as notificações com **Enabled** desligado.
2. Active uma de cada vez e provoque o evento num registo de teste.
3. Veja em **Email Queue** se a mensagem foi criada e enviada.
4. As de *Days Before/After* correm uma vez por dia (agendador). Para testar já: `bench --site erpnext-site execute frappe.email.doctype.notification.notification.trigger_daily_alerts`.
