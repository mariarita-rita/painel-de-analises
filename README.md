# Monitoramento de Análises — Londrisoft

Painel de monitoramento das tarefas da lista **Análises - ANALISTAS** no ClickUp.

## Estrutura

```
analises-monitor/
├── api/
│   └── tasks.js        ← Serverless function (proxy ClickUp)
├── public/
│   └── index.html      ← Frontend do painel
└── vercel.json         ← Configuração do Vercel
```

## Deploy no Vercel

### 1. Suba o projeto

Faça upload desta pasta no GitHub (repositório novo ou existente) ou use o Vercel CLI:

```bash
npm i -g vercel
cd analises-monitor
vercel
```

### 2. Configure as variáveis de ambiente

No painel do Vercel → seu projeto → **Settings → Environment Variables**, adicione:

| Nome | Valor |
|------|-------|
| `CLICKUP_API_KEY` | `pk_42926569_6HAK9EQINVBXO6AGR3FA1C15X7H5645Q` |
| `CLICKUP_LIST_ID` | `901327701998` |

> ⚠️ Nunca coloque a API key diretamente no código — só nas variáveis de ambiente.

### 3. Redeploy

Após salvar as variáveis, clique em **Redeploy** no Vercel.

## Funcionalidades

- Busca por cliente, CNPJ, Jira issue ou ID Núcleo
- Filtro por status
- Cards de resumo (total, andamento, aguardando Jira, para entregar, concluídas)
- Atualização automática a cada 60 segundos
- Link direto para a issue no Jira
- Datas vencidas destacadas em vermelho
- Modo escuro automático

## Mapeamento de campos customizados

O backend tenta localizar os campos pelo nome. Se os nomes dos campos no ClickUp forem diferentes, edite o arquivo `api/tasks.js` na função `getField` — ela busca por nome parcial, sem distinção de maiúsculas.

Campos mapeados:
- `nucleo` → busca por: "núcleo", "nucleo", "id núcleo", "id nucleo"
- `cliente` → busca por: "cliente", "solicitante", "empresa", "company"
- `jiraUrl` → busca por: "jira issue url", "jira url", "jira issue", "issue url"
