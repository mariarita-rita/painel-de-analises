// Varredura incremental de menções, para o sininho.
//
// Custo: 1 chamada de lista + 1 por tarefa alterada desde `since`. Não existe
// varredura completa: as 269 análises custariam 269 chamadas, o que não cabe numa
// cota de 100/min compartilhada com o dashboard de carteiras (28 chamadas por
// leitura, 4 CSMs no expediente) e com o Apps Script de sincronização.
//
// Postar comentário carimba o date_updated da tarefa — verificado na API: na
// tarefa 86ak23wf0 o comentário é de 1787173573464 e o date_updated 1787173573807,
// 343 ms depois. É isso que torna a varredura incremental suficiente.
//
// O front só chama esta rota quando o maior date_updated que ele conhece avançou,
// então em regime (nada mudou nos últimos 60 s) o custo é ZERO chamada.

// Teto de tarefas por chamada. Acima disso a rota processa as MAIS ANTIGAS
// primeiro e devolve nextSince, para o front continuar de onde parou — assim o
// marcador avança de forma monotônica e nenhuma menção é pulada.
const MAX_TAREFAS = 40;

// Piso de 30 dias no `since`. Sem isso, quem abre o painel depois de muito tempo
// pediria a varredura de todo o período de uma vez — o caminho de volta para as
// 269 chamadas, por acidente.
const PISO_MS = 30 * 24 * 60 * 60 * 1000;

// Lotes pequenos de leitura concorrente: rápido o suficiente para o limite de
// execução da Vercel, sem disparar 40 requisições simultâneas contra a cota.
const LOTE = 5;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Nunca cachear: a resposta é por usuário. O s-maxage do /api/tasks existe
  // para 4 CSMs colapsarem na mesma resposta — aqui o mesmo mecanismo entregaria
  // o sininho de uma pessoa para outra.
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const API_KEY = process.env.CLICKUP_API_KEY;
  // Mesma normalização do task-detail.js: espaço ou aspas sobrando na variável da
  // Vercel derrubaria a rota inteira em silêncio.
  const LIST_ID = (process.env.CLICKUP_LIST_ID || '').trim().replace(/^["']|["']$/g, '');
  if (!API_KEY || !LIST_ID) {
    return res.status(500).json({ error: 'Variáveis de ambiente não configuradas' });
  }

  try {
    // req.query é getter lazy no runtime da Vercel: acessar fora do try faz uma
    // URL malformada derrubar a função em vez de virar 400.
    const q = req.query || {};

    const userId = Number(q.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'userId obrigatório (ID de usuário do ClickUp).' });
    }

    const agora = Date.now();
    const pedido = Number(q.since);
    const since = Math.max(
      Number.isFinite(pedido) && pedido > 0 ? pedido : agora - PISO_MS,
      agora - PISO_MS
    );

    // Uma chamada só, e ela resolve duas coisas: diz quais tarefas mudaram e
    // garante o escopo. O escopo vem de graça porque a consulta é feita NA lista
    // — não há como o cliente pedir comentário de tarefa de outro lugar do
    // workspace, que é o furo que o task-detail.js precisa de uma chamada extra
    // por tarefa para fechar.
    const listaUrl = `https://api.clickup.com/api/v2/list/${encodeURIComponent(LIST_ID)}/task`
      + `?include_closed=true&subtasks=true&order_by=updated&reverse=true`
      + `&date_updated_gt=${since}`;

    const listaResp = await fetch(listaUrl, { headers: { Authorization: API_KEY } });

    if (listaResp.status === 429) {
      const retryAfter = listaResp.headers?.get?.('Retry-After');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: 'Limite de requisições do ClickUp atingido.',
        rateLimited: true,
        retryAfter: retryAfter || null
      });
    }
    if (!listaResp.ok) {
      return res.status(502).json({ error: 'Não foi possível consultar a lista no ClickUp.' });
    }

    const listaData = await listaResp.json();
    // Ascendente por date_updated: processar do mais antigo para o mais novo é o
    // que permite cortar em MAX_TAREFAS sem pular nada.
    const alteradas = (listaData.tasks || [])
      .filter(t => t && t.id)
      .sort((a, b) => Number(a.date_updated || 0) - Number(b.date_updated || 0));

    const fatia = alteradas.slice(0, MAX_TAREFAS);
    const truncado = alteradas.length > fatia.length;

    const mentions = [];
    let blocosVistos = false;
    let rateLimited = false;
    // Marcador de progresso: só avança para tarefas efetivamente processadas.
    let nextSince = since;

    for (let i = 0; i < fatia.length && !rateLimited; i += LOTE) {
      const bloco = fatia.slice(i, i + LOTE);
      const respostas = await Promise.all(bloco.map(t =>
        fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(t.id)}/comment`, {
          headers: { Authorization: API_KEY }
        }).then(r => ({ t, r })).catch(() => ({ t, r: null }))
      ));

      for (const { t, r } of respostas) {
        if (r && r.status === 429) {
          // 429 não pode virar "nenhuma menção": isso é indistinguível de
          // "ninguém te mencionou" e faria o sininho mentir. Para aqui, devolve o
          // que já tem e NÃO avança o marcador além desta tarefa.
          rateLimited = true;
          break;
        }
        if (!r || !r.ok) continue;

        let dados;
        try { dados = await r.json(); } catch (e) { continue; }

        (dados.comments || []).forEach(c => {
          const blocos = Array.isArray(c.comment) ? c.comment : [];
          if (blocos.length) blocosVistos = true;

          // Comentário do próprio usuário não vira notificação para ele.
          if (Number(c.user?.id) === userId) return;

          const data = Number(c.date || 0);
          if (data <= since) return;

          const mencionado = blocos.some(b => b && b.type === 'tag' && Number(b.user?.id) === userId);
          if (!mencionado) return;

          const texto = c.comment_text || blocos.map(b => (b && b.text) || '').join('');
          mentions.push({
            taskId: t.id,
            taskName: t.name || '',
            taskUrl: t.url || '',
            commentId: String(c.id),
            date: data,
            author: c.user?.username || c.user?.email || 'Sistema',
            texto: texto.length > 280 ? texto.slice(0, 280) + '…' : texto
          });
        });

        if (!rateLimited) {
          nextSince = Math.max(nextSince, Number(t.date_updated || 0));
        }
      }
    }

    mentions.sort((a, b) => b.date - a.date);

    return res.status(200).json({
      mentions,
      // Quantas tarefas foram lidas de fato: é o custo em chamadas desta resposta.
      checked: fatia.length,
      // true quando o teto cortou a fila, ou quando a cota interrompeu: nos dois
      // casos o front deve chamar de novo com nextSince em vez de considerar a
      // varredura completa. Sem isso o corte pareceria "não há mais nada".
      incompleto: truncado || rateLimited,
      rateLimited,
      nextSince,
      // Se comentários foram lidos e NENHUM trouxe array de blocos, a leitura não
      // preserva a menção estruturada e o sininho ficaria vazio para sempre sem
      // dar sinal. Preferimos que isso apareça a falhar em silêncio.
      blocosVistos: fatia.length ? blocosVistos : null
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
