# Monitoramento de Análises — Londrisoft (v2)

## O que mudou nesta versão

- **Régua de trajetória** mostrando quantas tarefas estão em cada etapa do fluxo (Novo Pedido → Finalizado)
- **Novos campos na tabela**: link direto para o ClickUp, último comentário da tarefa, autor e data do comentário
- **Sinalização de tarefas**: botão 🚩 em cada linha permite que CSMs/atendimento marquem "Cliente pede retorno" ou "Risco de churn" — isso adiciona automaticamente um **comentário** e uma **tag nativa** na tarefa do ClickUp
- **Identificação do usuário**: seletor na barra do topo, salvo no navegador
  (localStorage), usado para assinar as sinalizações

## Identificação: por que ela guarda o ID, e não só o nome

A chave `analises_monitor_user_v2` guarda `{id, nome}` — o `id` é o **ID de usuário
do ClickUp**. A versão anterior (`analises_monitor_user`) guardava só o nome, digitado
à mão num `prompt()`, e isso não sobrevive ao uso: dos quatro nomes que chegaram a ser
digitados em sinalizações reais, três casavam com um usuário do workspace e um não
("Aline Costa" — o workspace tem *Aline Rosa*). Nome digitado não serve para
identificar pessoa com segurança.

O ID **não precisa de mapa nem de chamada nova**: o campo `Solicitante` do ClickUp é
do tipo `users` e já devolve `{id, username, email}` em toda tarefa que o
`/api/tasks` carrega. O `tasks.js` passa isso adiante em `t.solicitantes`
(`[{id, nome}]`), e o seletor é montado dessa mesma lista — a mesma que alimenta o
filtro de solicitantes.

Também **não** use `GET /team/{id}/member` como fonte de IDs: ele não devolve todos os
usuários que aparecem nas tarefas (`Matheus Delamason da Silva`, `43078993`, é
assignee de dezenas de análises e não consta na lista de membros). A fonte é o payload
da tarefa.

O `t.assigneesFull` (`[{id, nome}]`) existe pelo mesmo motivo, para quando a
sinalização passar a mencionar o analista: **o assignee varia por tarefa** — Lucas
Santos (`82010227`), Matheus Delamason da Silva (`43078993`), Cassia Silva
(`42921071`), Maria Rita (`42926569`) — e algumas tarefas têm dois. ID fixo estaria
errado na maioria dos casos.

Migração da v1: se houver valor antigo e ele casar exatamente com um nome da lista, a
identidade é convertida sozinha. Não casando, a pessoa se identifica uma vez no
seletor e não é perguntada de novo.

## Estrutura (arquivos na raiz)

```
analises-monitor/
├── tasks.js         ← API: busca as tarefas da lista (/api/tasks)
├── task-detail.js   ← API: comentários, histórico e descrição (/api/task-detail)
├── flag.js          ← API: registra sinalização — comentário, tag e anexo (/api/flag)
├── index.html       ← Frontend completo
└── vercel.json      ← Roteamento
```

## Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Nome | Valor |
|------|-------|
| `CLICKUP_API_KEY` | `pk_xxxxxxxx_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` |
| `CLICKUP_LIST_ID` | `901326473282` (lista `🚨 Análises - ISSUE`, space `49108550`) |

Depois de configurar, clique em **Redeploy**.

> **Nunca comite o valor real da `CLICKUP_API_KEY`.** Este repositório é público.
> A chave é pessoal, dá acesso de leitura e escrita ao workspace e é compartilhada
> com outros painéis — se vazar, o estrago não fica restrito a este projeto.
>
> Configure o valor apenas em **Vercel → Settings → Environment Variables**, onde
> ele fica disponível para as funções em `process.env.CLICKUP_API_KEY` sem nunca
> chegar ao cliente. Para rodar local, use um `.env.local` (já coberto por
> `.gitignore`) — nunca este README.
>
> Se uma chave for exposta, revogue em ClickUp → Settings → Apps → *Regenerate*
> antes de qualquer outra coisa: remover do arquivo não basta, o valor continua
> no histórico do git.

## Sobre as tags de sinalização

As tags usadas são:
- `cliente-pede-retorno`
- `risco-churn`

Se essas tags ainda não existirem no Space do ClickUp, a primeira vez que alguém sinalizar pode retornar um aviso (o comentário ainda assim é adicionado normalmente). Caso queira, crie essas duas tags manualmente no Space antes de divulgar a funcionalidade, para garantir que apareçam coloridas certinho nos cards.

## Consumo de requisições no ClickUp

O token é limitado a **100 requisições por minuto** e é **compartilhado com outros
painéis**, então vale saber o custo de cada operação:

| Operação | Chamadas ao ClickUp |
|---|---|
| `GET /api/tasks`, padrão de 90 dias | **2** — uma consulta das abertas, uma das finalizadas no período |
| `GET /api/tasks`, "Finalizados: todos" | 3 (269 análises em páginas de 100) |
| `GET /api/task-detail` (abrir o modal) | 2 (comentários + descrição) |
| `GET /api/task-detail` reabrindo na sessão | 1 — a descrição vem do cache do front |
| `POST /api/flag` | 2, ou 3 quando há anexo |
| `GET /api/mentions`, nada mudou | **0** — o front nem chama |
| `GET /api/mentions`, algo mudou | 1 (lista) + 1 por tarefa alterada, teto de 40 |

O `index.html` recarrega a tabela a cada 60 s, e as respostas de `/api/tasks` têm
`Cache-Control: s-maxage=60`, então vários usuários simultâneos colapsam na mesma
resposta em cache em vez de multiplicar chamadas.

**A janela de cache era 30 s e virou 60 s, e essa linha economizou mais que o corte de
data.** Com o cliente recarregando a cada 60 s, meia janela só dobrava as chamadas sem
entregar dado mais novo a ninguém: eram ~6 req/min, passaram a ~3. O corte de data rende
~1 chamada por carga; ele existe pela legibilidade da tela e pelo dia em que as análises
passarem de 400, não pela cota.

A chave de cache inclui a query, então cada valor de `closedDays` tem a sua própria
entrada — usuários com períodos diferentes deixam de colapsar na mesma resposta.

`tasks.js` **não** busca comentário por tarefa — o último comentário saiu da
tabela justamente para não gastar uma chamada por linha. Se essa coluna voltar,
o custo passa a crescer com o número de análises e pode estourar a cota.

## Período das finalizadas

O seletor *Finalizados: 30 / 90 / 180 dias / todos* na barra de filtros é o **único**
filtro que recarrega do servidor — os outros filtram o que já está na memória. O corte é
feito na consulta ao ClickUp, porque filtrar no front não economizaria chamada nenhuma:
as 269 continuariam sendo paginadas. Padrão 90 dias, escolha guardada em
`analises_monitor_closed_days_v1`.

**O corte vale só para as finalizadas. Análise em aberto carrega sempre.** Esconder uma
aberta porque é antiga apaga exatamente o que mais importa num painel de acompanhamento —
é a mesma lição das 289 renovações em atraso no `apps-script-cs`, onde 183 venceram antes
de 2025. `cancelado` é `type: done` e não `closed`, então vem junto das abertas e também
não entra no corte; são poucos.

⚠️ **`date_done_gt` e `statuses[]` não foram verificados contra a API real.** Por isso o
corte é **reaplicado localmente** sobre o resultado: se a API ignorar os parâmetros, a
saída continua correta e só a economia de chamadas não acontece. O campo `escopo` da
resposta diz o que houve:

| campo | o que significa |
|---|---|
| `escopo.abertas` | quantas análises em aberto vieram |
| `escopo.fechadasRecebidas` | quantas finalizadas a API devolveu |
| `escopo.fechadasNoPeriodo` | quantas sobraram depois do filtro local |
| `escopo.dateDoneAplicado` | `false` = a API devolveu finalizadas fora do período, ou seja **não houve economia** |

Há também dedupe por `id`: se `statuses[]` for ignorado, a segunda consulta devolve
tarefas que a primeira já trouxe.

**Os cartões dizem o período no rótulo.** "Concluídas: 50" existindo 145 é o cartão
mentindo em silêncio; "Concluídas (90 d): 50" é o mesmo número dizendo o que ele é. E o
antigo cartão "Total" virou **"Em aberto"**: com corte de data, um "Total" diria 174
existindo 269. "Em aberto" é exato, sempre completo, e é o número que um painel de
monitoramento quer. Saber o total real não é barato — o endpoint de lista não devolve
contagem, só páginas.

## Sininho de menções

Os solicitantes têm usuário no ClickUp mas não o usam no dia a dia, então não veem as
menções. O sininho traz as menções para dentro do painel.

**Como a menção nasce.** A sinalização (`/api/flag`) menciona o **assignee da tarefa**,
lido de `t.assigneesFull` — nunca ID fixo, porque o responsável varia por tarefa e
algumas têm dois. Mencionar quem sinalizou seria recibo, não notificação. As respostas
da analista continuam vindo do ClickUp, com `@` normal.

O corpo do comentário usa o array de blocos, não `comment_text`, porque só assim dá
para emitir `{"type":"tag","user":{"id":N}}`. Esse parâmetro **não está no schema** do
`POST /task/{id}/comment`, só na página *Comment formatting* — foi verificado contra a
API real (o bloco sobrevive e renderiza como menção) antes de virar código. Blocos não
interpretam Markdown: negrito vem de `attributes.bold`, `**texto**` sairia literal.

**Como a menção é encontrada.** Não há endpoint de notificações na API do ClickUp — o
pedido foi encerrado como *"Not on the roadmap"* em 29/08/2025. Varrer as 269 análises
custaria 269 chamadas, o que não cabe na cota. Então `/api/mentions` faz varredura
incremental, e funciona porque **postar comentário carimba o `date_updated` da
tarefa** (verificado: na tarefa `86ak23wf0` o comentário é de `1787173573464` e o
`date_updated` `1787173573807`).

O front tem o `date_updated` de tudo, então compara o maior deles com o marcador
guardado e **só chama a rota quando algo mudou**. Em regime, custo zero.

A rota consulta a lista com `date_updated_gt` em vez de aceitar IDs do front: uma
chamada resolve o que mudou **e** o escopo de lista — o `task-detail.js` gasta uma
chamada extra por tarefa para fechar o mesmo furo.

Limites deliberados:

| o quê | valor | por quê |
|---|---|---|
| piso do `since` | 30 dias | sem piso, quem abre depois de muito tempo pede a varredura do período inteiro — o caminho de volta às 269 chamadas, por acidente |
| teto por chamada | 40 tarefas | processadas da **mais antiga** para a mais nova, devolvendo `nextSince`; o marcador avança monotonicamente e nada é pulado |
| `Cache-Control` | `no-store` | o `s-maxage` do `/api/tasks` existe para os CSMs colapsarem na mesma resposta; numa rota por usuário isso entregaria o sininho de uma pessoa para outra |
| fila truncada | sem laço | o próximo ciclo de 60 s continua sozinho, espalhando o custo em vez de estourar a cota numa tacada |

`429` nunca vira lista vazia — seria indistinguível de "ninguém te mencionou" e faria o
sininho mentir. A rota interrompe, devolve o que tem e **não** avança o marcador.

`blocosVistos: false` é diagnóstico: comentários foram lidos e nenhum trouxe array de
blocos, ou seja a leitura não preserva a menção estruturada e o sininho ficaria vazio
para sempre. Aparece como aviso no pé do painel em vez de falhar em silêncio.

**Visto / não visto.** Fica no navegador, em
`analises_monitor_mencoes_v1:<userId>` — a chave inclui o ID porque duas pessoas na
mesma máquina não podem ver o sininho uma da outra, e num painel de uso esporádico
compartilhar máquina é a regra.

Guarda as **menções**, não só as marcas de lido: a varredura é incremental, então uma
menção encontrada hoje não é reencontrada amanhã e desapareceria ao recarregar. Poda
de 30 dias (igual ao piso da rota, então nada mais antigo pode voltar) e teto de 200
itens.

Trocar de máquina perde as marcas de lido e o histórico local. Aceito: reidentificar é
um clique e rever menção já vista é inofensivo. Guardar no servidor exigiria banco, que
o painel não tem.

**O sininho nasce vazio.** No primeiro acesso de cada identidade o marcador nasce no
presente e nada é varrido do passado — não há backfill, e a varredura incremental basta
desde o primeiro dia.

## Mapeamento de campos customizados

Caso os nomes dos campos no ClickUp sejam diferentes, ajuste a função `getField` dentro de `tasks.js`:

- `nucleo` → busca por: "núcleo", "nucleo", "id núcleo", "id nucleo"
- `cliente` → busca por: "cliente", "empresa", "company"
- `jiraUrl` → busca por: "jira issue url", "jira url", "jira issue", "issue url"
- `ambiente` → busca por: "ambiente"
- `urgencia` → busca por: "urgência", "urgencia"

O campo `solicitante` é lido separadamente, por `getPersonField`, porque no
ClickUp é um campo de pessoa e o valor vem como objeto ou lista de objetos, não
como texto.
