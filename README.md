# Monitoramento de Análises — Londrisoft (v2)

## O que mudou nesta versão

- **Régua de trajetória** mostrando quantas tarefas estão em cada etapa do fluxo (Novo Pedido → Finalizado)
- **Novos campos na tabela**: link direto para o ClickUp, último comentário da tarefa, autor e data do comentário
- **Sinalização de tarefas**: botão 🚩 em cada linha permite que CSMs/atendimento marquem "Cliente pede retorno" ou "Risco de churn" — isso adiciona automaticamente um **comentário** e uma **tag nativa** na tarefa do ClickUp
- **Identificação do usuário**: nome salvo no navegador (localStorage), usado para assinar as sinalizações

## Estrutura (arquivos na raiz)

```
analises-monitor/
├── tasks.js       ← API: busca tarefas + último comentário de cada uma
├── flag.js        ← API: registra sinalização (comentário + tag) no ClickUp
├── index.html     ← Frontend completo
└── vercel.json    ← Roteamento
```

## Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Nome | Valor |
|------|-------|
| `CLICKUP_API_KEY` | sua chave da API do ClickUp |
| `CLICKUP_LIST_ID` | `901327701998` |

Depois de configurar, clique em **Redeploy**.

## Sobre as tags de sinalização

As tags usadas são:
- `cliente-pede-retorno`
- `risco-churn`

Se essas tags ainda não existirem no Space do ClickUp, a primeira vez que alguém sinalizar pode retornar um aviso (o comentário ainda assim é adicionado normalmente). Caso queira, crie essas duas tags manualmente no Space antes de divulgar a funcionalidade, para garantir que apareçam coloridas certinho nos cards.

## Sobre a busca de comentários

A API faz uma chamada adicional por tarefa para buscar o último comentário (em lotes de 10 simultâneas, para não estourar o limite de requisições do ClickUp). Em listas muito grandes (200+ tarefas), o carregamento pode demorar alguns segundos a mais — isso é esperado.

## Mapeamento de campos customizados

Caso os nomes dos campos no ClickUp sejam diferentes, ajuste a função `getField` dentro de `tasks.js`:

- `nucleo` → busca por: "núcleo", "nucleo", "id núcleo", "id nucleo"
- `cliente` → busca por: "cliente", "solicitante", "empresa", "company"
- `jiraUrl` → busca por: "jira issue url", "jira url", "jira issue", "issue url"
