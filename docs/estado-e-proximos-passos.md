# Estado e próximos passos — Painel de Análises

Última atualização: **24/08/2026**

Este documento existe porque várias escolhas deste painel são **deliberadas** e o motivo
não é óbvio a partir do código. Daqui a um mês ninguém vai lembrar por que o
`/api/mentions` consulta a lista em vez de aceitar IDs do front, nem por que o sininho
nasce vazio — está escrito abaixo.

Lista alvo: `901326473282` (`🚨 Análises - ISSUE`) · Space `49108550` · 269 análises.
Hospedagem: Vercel. Repositório: `mariarita-rita/painel-de-analises` — **público**, como
o README registra.

---

## 1. Onde as coisas estão

| arquivo | papel |
|---|---|
| `tasks.js` | `/api/tasks` — carrega as tarefas da lista e normaliza os campos |
| `task-detail.js` | `/api/task-detail` — comentários, histórico de status e descrição, sob demanda |
| `flag.js` | `/api/flag` — registra sinalização: comentário com menção, etiqueta nativa e anexo |
| `mentions.js` | `/api/mentions` — varredura incremental de menções, para o sininho |
| `index.html` | front inteiro (dois blocos de script inline) |
| `vercel.json` | build e roteamento — **toda rota nova precisa de entrada em `builds` E em `routes`** |

**Variáveis de ambiente:** apenas duas, `CLICKUP_API_KEY` e `CLICKUP_LIST_ID`. As quatro
rotas leem só essas — o sininho **não** introduziu variável nova.

---

## 2. O que está no ar

Sincronizado com `main` em 21/08/2026 (PR #1, merge `b600e03`).

- Tabela das análises com filtros (status, solicitante, etiqueta, busca), régua de
  trajetória, cartões de estatística e modal de detalhe
- Sinalização pelo 🚩 com quatro tipos, nota e anexo
- **Identificação com ID de usuário do ClickUp** (seletor no topo)
- **Menção ao analista** na sinalização
- **Sininho de menções** com varredura incremental e estado no navegador

---

## 3. Decisões tomadas, e por que estão assim

### A identidade guarda o ID, não o nome

O seletor do topo era um `prompt()` de texto livre. Não sobrevive ao uso: dos quatro
nomes que chegaram a ser digitados em sinalizações reais, **três casavam com um usuário
do workspace e um não** — "Aline Costa", quando o workspace tem *Aline Rosa*. 25% de erro
numa amostra de quatro.

O ID **não precisou de mapa nem de chamada nova**: o campo `Solicitante` do ClickUp
(`329ce990-7626-4ca2-946e-9966ae696784`) é do tipo `users` e já devolve
`{id, username, email}` em toda tarefa que o `/api/tasks` carrega. O `tasks.js`
descartava o `p.id` uma linha antes de montar `t.solicitante`.

**Não use `GET /team/{id}/member` como fonte de IDs.** Ele não devolve todos os usuários
que aparecem nas tarefas: `Matheus Delamason da Silva` (`43078993`) é assignee de dezenas
de análises e **não consta** na lista de membros. A fonte é o payload da tarefa.

O campo "Seu nome" do modal de sinalização é **somente-leitura** de propósito. Campo
digitável ali reintroduz o nome sem ID exatamente no ponto em que ele importa.

### A sinalização menciona o analista, não quem sinalizou

Mencionar quem acabou de sinalizar é **recibo, não notificação** — o sininho mostraria à
pessoa a própria ação. Quem precisa saber é quem tem de agir.

O ID vem de `t.assigneesFull`, **nunca fixo**: o responsável varia por tarefa — Lucas
Santos (`82010227`), Matheus Delamason da Silva (`43078993`), Cassia Silva (`42921071`),
Maria Rita (`42926569`) — e há tarefas com **dois** (`86ah301ve`, `86agw2jum`,
`86agvzdgq`). Todos são mencionados.

Os IDs vão **do front**, não de uma leitura da tarefa no `/api/flag`: ler custaria uma
chamada a mais na cota compartilhada. Preço: o dado pode estar até 60 s velho (intervalo
de recarga), então troca de responsável nesse intervalo menciona o anterior. Aceitável —
o assignee atual é notificado pelo ClickUp por ser assignee, independente da menção.

**Tarefa sem responsável não menciona ninguém**, e quem sinalizou recebe aviso. ID padrão
foi descartado: estaria errado na maioria dos casos, e mencionar a pessoa errada ensina
todo mundo a ignorar menção — pior que não mencionar. A sinalização não se perde
(comentário e etiqueta são aplicados), e análise sinalizada sem responsável é ela mesma
uma condição que alguém precisa ver.

### O comentário usa array de blocos, não `comment_text`

É a única forma de emitir menção estruturada `{"type":"tag","user":{"id":N}}`.

⚠️ **O parâmetro `comment` não está no schema** do `POST /task/{id}/comment` — só na
página *Comment formatting*. Foi verificado contra a API real antes de virar código
(escrita e leitura), pelo precedente do `configurarLabels_` no `apps-script-cs`, que
mandava `name` onde o campo esperava `label` e falhou em silêncio por 191 clientes.

**Blocos não interpretam Markdown.** O negrito do rótulo vem de `attributes.bold`;
`**texto**` sairia literal. Se alguém mexer no corpo do comentário, é a primeira coisa a
lembrar.

`notify_all` é `false`, e **explícito** em vez de omitido, porque o schema o marca
obrigatório. Estava `true`, notificando o **dono do token** (que não é quem sinaliza) e
sem efeito útil: assignees e watchers são notificados independente do campo.

### Não existe endpoint de notificações no ClickUp

Investigado e descartado, para não ser reinvestigado: a API pública **não tem** endpoint
de notificações. O pedido de funcionalidade foi encerrado como *"Not on the roadmap"* em
29/08/2025. O **audit log** também não serve — é Enterprise, só o dono do workspace cria,
e **não cobre eventos de comentário**.

Existe webhook `taskCommentPosted`, com o comentário completo no payload e custo zero de
cota. **Não foi usado** porque precisaria de onde persistir (o painel não tem banco) e
porque webhook do ClickUp **morre calado**: suspende ao atingir `fail_count` 100, e a
documentação diz explicitamente que nenhuma notificação é enviada quando a saúde muda.
Fica registrado como caminho válido se um banco entrar no projeto.

### A varredura é incremental, e o front decide se ela acontece

Varredura completa das 269 análises custaria **269 chamadas** — não cabe em 100/min
compartilhados com o dashboard de carteiras (28 por leitura, 4 CSMs no expediente) e o
Apps Script de sincronização.

Funciona porque **postar comentário carimba o `date_updated` da tarefa**. Verificado: na
tarefa `86ak23wf0` o comentário é de `1787173573464` e o `date_updated` `1787173573807`,
343 ms depois.

O front tem o `date_updated` de tudo, então compara o maior deles com o marcador guardado
e **só chama a rota quando algo mudou**. Em regime: **zero chamada**.

A rota consulta a lista com `date_updated_gt` em vez de aceitar IDs do front. Uma chamada
resolve duas coisas: o que mudou **e** o escopo de lista. Aceitar IDs custaria 0 chamadas
mas serviria comentário de qualquer tarefa que o token alcance no workspace — o furo que
o `task-detail.js` gasta uma chamada extra **por tarefa** para fechar.

### O sininho nasce vazio

No primeiro acesso de cada identidade o marcador nasce no presente e nada é varrido do
passado. É intencional: varrer o histórico custaria as 269 chamadas que este desenho
existe para evitar, e encheria o sininho de menções velhas já resolvidas.

**Consequência para quem for testar:** identifique-se **antes** de criar a menção. Na
ordem inversa a menção não aparece, e isso é o comportamento correto.

### O estado das menções mora no navegador

Guarda as **menções**, não só as marcas de lido. A varredura é incremental, então uma
menção encontrada hoje não é reencontrada amanhã — o marcador já passou dela. Sem
persistir a lista, menção não lida desapareceria ao recarregar.

A chave inclui o ID: `analises_monitor_mencoes_v1:<userId>`. Duas pessoas na mesma máquina
não podem ver o sininho uma da outra, e num painel de uso esporádico compartilhar máquina
é a regra, não a exceção.

Preço aceito: **trocar de máquina perde as marcas de lido e o histórico local.**
Reidentificar é um clique e rever menção já vista é inofensivo. Guardar no servidor
exigiria banco.

### Sem senha, de propósito

O conteúdo não é sensível e o modo de falha de um painel pouco usado é o **abandono**, não
o acesso indevido. Uma barreira a mais vira motivo para não usar. Isso é decisão de
produto, não descuido — mas veja §6, porque tem tamanho.

### `--brand` nunca em texto pequeno

A paleta registra: `--brand` dá 3.48:1 sobre branco e reprova o AA. Texto azul usa
`--accent-text` (8.65:1) ou `--text` (19.97:1); `--brand` fica em preenchimento, borda e
ícone. O chip de identidade já tropeçou nisso uma vez.

---

## 4. Constantes de controle

| constante | valor | por quê |
|---|---|---|
| `MAX_TAREFAS` (`mentions.js`) | `40` | teto por chamada. As tarefas são processadas da **mais antiga** para a mais nova e a rota devolve `nextSince` — o marcador avança monotonicamente e nada é pulado |
| `PISO_MS` (`mentions.js`) | 30 dias | sem piso, quem abre depois de muito tempo pede a varredura do período inteiro — o caminho de volta às 269 chamadas, por acidente |
| `LOTE` (`mentions.js`) | `5` | leitura concorrente rápida o bastante para o limite de execução da Vercel, sem disparar 40 requisições simultâneas contra a cota |
| `MENCOES_JANELA_MS` (`index.html`) | 30 dias | igual ao piso da rota — nada mais antigo pode voltar a aparecer, então podar é seguro |
| `MENCOES_MAX` (`index.html`) | `200` | teto de itens no `localStorage` |
| recarga da tabela | 60 s | `setInterval(loadTasks, 60000)` — é também o ciclo do sininho |
| `s-maxage` do `/api/tasks` | `60` | vários CSMs colapsam na mesma resposta. Era `30`, com o cliente recarregando a cada 60 s: meia janela dobrava as chamadas sem entregar dado mais novo. Foi a maior economia de cota do painel, e custa uma linha |
| `PADRAO_DIAS` (`tasks.js`) | `90` | período das finalizadas quando o cliente não manda `closedDays`. **Só as finalizadas** — análise em aberto nunca é cortada |
| `Cache-Control` do `/api/mentions` | `no-store` | rota **por usuário**: o mesmo cache entregaria o sininho de uma pessoa para outra |

---

## 5. Armadilhas registradas

**`429` nunca pode virar lista vazia.** É indistinguível de "não tem comentário" ou
"ninguém te mencionou", e faz o painel mentir. As três rotas de leitura devolvem 429 com
`Retry-After` e **sem retry automático** — reenviar na hora agrava o estouro de uma cota
compartilhada. No `/api/mentions`, o 429 interrompe e **não avança o marcador**, senão a
menção da janela perdida nunca apareceria.

**`req.query` é getter lazy no runtime da Vercel.** Acessar fora do `try` faz uma URL
malformada derrubar a função inteira em vez de virar 400.

**A variável `CLICKUP_LIST_ID` precisa ser normalizada.** Espaço ou aspas sobrando no
painel da Vercel fariam a checagem de escopo falhar para **toda** tarefa — um jeito
silencioso de derrubar a tela inteira. Por isso o `.trim().replace(/^["']|["']$/g, '')`.

**Escopo de lista aceita `list.id` OU `locations[]`.** Com o ClickApp *Tasks in Multiple
Lists* ativo, a tarefa aparece na lista de análises mas o `list.id` aponta para a lista de
origem. Checar só `list.id` recusaria tarefa legítima.

**`blocosVistos: false` é o alarme do sininho.** Significa que comentários foram lidos e
nenhum trouxe array de blocos, isto é: a leitura não preserva a menção estruturada e o
sininho ficaria vazio **para sempre** sem dar sinal. Vira aviso amarelo no pé do painel.
A leitura foi verificada funcionando em 21/08/2026, então esse aviso aparecendo significa
mudança de comportamento da API.

**`mergeMencoes` preserva a marca de lido.** A varredura pode devolver o mesmo comentário
quando o marcador não avançou (429, fila truncada). Sobrescrever faria menção lida voltar
a piscar.

**Não interpolar dado da API dentro de atributo de evento.** Os itens do sininho usam
`data-cid` com delegação, não `onclick="...${id}..."`.

**A régua avisa em vez de esconder.** Status fora das etapas do `JOURNEY` cai no balde
"Outros", que só aparece quando tem número, e um `console.warn` **nomeia** os status
desconhecidos. Há também conferência de soma. Se aparecer "Outros" com número, abra o
console: o status legítimo que falta está nomeado lá.

**DOIS campos customizados contêm "solicitante" no nome.** `Solicitante`
(`329ce990-…`, `type: users`, a pessoa) e `Cliente - Solicitante` (`ba361d20-…`,
`type: short_text`, a razão social). **O de texto vem antes no array que a API devolve**,
então `cf.find` por `includes` pega o cliente. Foi o que quebrou a identificação em
produção em 24/08/2026: o seletor ficava sem opções, e daí sem identidade o botão
Sinalizar ficava desabilitado e o sininho não tinha usuário — três sintomas, uma causa. E
antes disso o mesmo erro atingia o `getPersonField` em silêncio: a coluna "Solicitante"
mostrava a mesma razão social da coluna "Cliente". A busca agora **ordena** os candidatos
(nome exato + `type: users` primeiro) em vez de pegar o primeiro. `getField('cliente')`
continua caindo em `Cliente - Solicitante` de propósito — ali a razão social é o valor
certo.

**`display` de autor vence `[hidden] { display: none }` do navegador.** O painel do
sininho tem `display: flex` e ficava permanentemente visível: `painel.hidden = true` não
tinha efeito nenhum, e o sininho abria sem nunca fechar. Precisa da regra explícita
`.bell-panel[hidden] { display: none }`, que tem especificidade de atributo e ganha da de
classe. **Qualquer elemento novo que combine `hidden` com `display` de autor tem o mesmo
problema.**

**`normalizeStatus` remove acentos, então alvos de comparação vão SEM acento.** O
`statusClass` comparava `s.includes('interação pendente')` com acento contra uma string já
normalizada — condição que nunca era verdadeira, e todas as análises em `interação
pendente` caíam em `'outro'` com badge cinza. O `JOURNEY_INDEX` não sofria disso porque
normaliza os dois lados.

**Rota nova precisa de DUAS entradas no `vercel.json`.** Uma em `builds` e uma em
`routes`. Faltando a de `builds`, a função não é compilada e a rota dá 404 em produção.

**O `.gitignore` já cobre `.env`.** As linhas `.env` + `.env.*` + `!.env.example` estão
corretas nessa ordem. **Não acrescente `.env*` no fim** — padrão posterior vence no
gitignore, e isso anula a exceção do `!.env.example`, voltando a ignorá-lo.

---

## 6. Pendências

### Ajustes de status na régua — **feitos em 24/08/2026**

Os três lugares (`JOURNEY`, `statusClass`, legenda) mais o cartão do topo, que dizia
"Aguard. Jira" e ficaria incoerente.

`abrir issue` removido — confirmado via `GET /list/901326473282` que não existe entre os
13 status da lista. `análise tribe tech` entrou como etapa, com a chave no nome exato da
API (minúsculo, com acento).

**`aguardando jira` saiu da régua mas ficou no `statusClass`.** No ClickUp ele existe
(orderindex 4) e serve só de gatilho da integração com o Jira — a tarefa passa e sai.
Etapa para status de passagem só produz coluna zerada, mas o badge precisa de cor coerente
enquanto a tarefa passa. **Consequência esperada:** de vez em quando aparece "Outros: 1"
com o `console.warn` nomeando `aguardando jira`. Não é status esquecido.

### `publicado` e `cancelado` caem em "Outros"

Descoberto pelo teste da régua em 24/08/2026. São status legítimos e configurados na
lista, e não têm etapa no `JOURNEY` — somam em "Outros" junto com o `aguardando jira`
transitório, e o `console.warn` nomeia os três. **Não decidido:** se merecem etapa própria
ou se o lugar deles é mesmo "Outros". Uma linha cada, se merecerem.

### Filtro de data nos finalizados — **feito em 24/08/2026**

Seletor *Finalizados: 30 / 90 / 180 dias / todos*, corte na consulta ao ClickUp. Detalhes
no README, seção "Período das finalizadas". Duas coisas para lembrar:

⚠️ **`date_done_gt` e `statuses[]` continuam NÃO verificados contra a API real.** O corte
é reaplicado localmente, então a saída está correta de qualquer forma — mas se
`escopo.dateDoneAplicado` vier `false`, a economia de chamadas **não está acontecendo** e
vale uma chamada de `curl` para descobrir o parâmetro certo.

**A economia real veio de outra linha.** O `s-maxage` do `/api/tasks` era 30 s com o
cliente recarregando a cada 60 s — meia janela dobrava as chamadas sem entregar dado mais
novo a ninguém. Subir para 60 s levou de ~6 para ~3 req/min; o corte de data rende ~1
chamada por carga. Se a cota apertar de novo, o próximo lugar a olhar é o intervalo de
recarga do cliente (60 → 120 s), não mais filtros.

### Segurança: as quatro rotas são abertas — **registrado, não resolvido**

Estado verificado em 21/08/2026: `tasks.js:2`, `task-detail.js:2`, `flag.js:77` e
`mentions.js:30` todas setam `Access-Control-Allow-Origin: *`, e **nenhuma das quatro tem
autenticação**. O `/api/mentions` **entra na mesma condição** — não piorou o padrão, mas
acrescentou superfície (ver abaixo).

**Precisão sobre o que é o problema:** o `Access-Control-Allow-Origin: *` **não é** a
vulnerabilidade. Sem autenticação e sem cookie, qualquer um chama por `curl` de qualquer
forma; o `*` só remove o atrito de fazer isso pelo navegador de outra pessoa. O problema é
**ausência de autenticação**. E o repositório é público, então as URLs são descobríveis.

Tamanho, do mais grave para o menos:

1. **Escrita sem autenticação (`/api/flag`).** Qualquer um cria comentário, aplica
   etiqueta e **sobe anexo** em qualquer tarefa da lista, assinando com o nome que quiser.
   É escrita no ClickUp de produção.
2. **Exaustão de cota.** Nenhuma rota tem limite próprio. Um laço contra `/api/tasks` ou
   `/api/mentions` queima os 100/min do token — e a cota é **compartilhada** com o
   dashboard de carteiras que 4 CSMs usam e com o Apps Script de sincronização. O estrago
   sai do painel.
3. **Leitura de dado de cliente.** Nome de cliente, CNPJ, e-mail de login, telefone e
   histórico de comentários das 269 análises. Classificado como não sensível na decisão de
   produto (§3), mas CNPJ e e-mail de login merecem o segundo olhar.
4. **Enumeração de menções (novo com o sininho).** O `/api/mentions` aceita `userId`
   arbitrário sem provar que quem pede é aquele usuário. Dá para ler as menções de
   qualquer pessoa passando o ID dela — e IDs de usuário não são segredo, aparecem no
   payload das tarefas.

Mitigações possíveis, em ordem de custo, **nenhuma implementada**: restringir o
`Allow-Origin` ao domínio do painel e do dashboard que o embute em iframe (barato, resolve
só o atrito de navegador); um segredo compartilhado em header, injetado no
`index.html` pela Vercel (barato, quebra o `curl` casual, não resiste a quem abre o
DevTools); autenticação de verdade (contraria a decisão de produto de não ter senha, e o
motivo dela continua válido).

---

## 7. Como validar

| quero | faço |
|---|---|
| conferir sintaxe antes de subir | `node --check` em cada `.js` (copiar para `.mjs`, são ESM) e nos dois blocos inline do `index.html` |
| conferir o `vercel.json` | `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8'))"` |
| rodar local | `.env.local` com `CLICKUP_API_KEY` e `CLICKUP_LIST_ID=901326473282`, depois `vercel dev` |
| ver menção aparecer no sininho | identifique-se **primeiro**, deixe carregar, **depois** crie a menção, espere 60 s |
| descobrir status fora da régua | console do navegador, aviso `[Trajetória]` |
| ver o custo em chamadas de uma varredura | campo `checked` na resposta do `/api/mentions` |
