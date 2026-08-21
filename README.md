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
| `GET /api/tasks` (uma carga da tabela) | 1 por página de 100 tarefas — hoje 2 |
| `GET /api/task-detail` (abrir o modal) | 2 (comentários + descrição) |
| `GET /api/task-detail` reabrindo na sessão | 1 — a descrição vem do cache do front |
| `POST /api/flag` | 2, ou 3 quando há anexo |

O `index.html` recarrega a tabela a cada 60 s, e as respostas de `/api/tasks` têm
`Cache-Control: s-maxage=30`, então vários usuários simultâneos colapsam na mesma
resposta em cache em vez de multiplicar chamadas.

`tasks.js` **não** busca comentário por tarefa — o último comentário saiu da
tabela justamente para não gastar uma chamada por linha. Se essa coluna voltar,
o custo passa a crescer com o número de análises e pode estourar a cota.

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
