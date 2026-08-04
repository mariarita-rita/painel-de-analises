export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const API_KEY = process.env.CLICKUP_API_KEY;
  // Normaliza a variável antes de comparar: espaço ou aspas sobrando no painel da
  // Vercel fariam a checagem de escopo falhar para TODA tarefa, e o efeito visível
  // seria 404 em todo modal — um jeito silencioso de derrubar a tela inteira.
  const LIST_ID = (process.env.CLICKUP_LIST_ID || '').trim().replace(/^["']|["']$/g, '');
  if (!API_KEY || !LIST_ID) {
    return res.status(500).json({ error: 'Variáveis de ambiente não configuradas' });
  }

  try {
    // req.query no runtime da Vercel é getter lazy: acessar fora do try faz um
    // corpo/URL malformado derrubar a função inteira em vez de virar 400.
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ error: 'ID da tarefa obrigatório' });

    // A tarefa é buscada SEMPRE, não só pela descrição: é ela que diz a qual
    // lista o id pertence. Sem essa checagem o endpoint serve os comentários de
    // qualquer tarefa que o token alcance no workspace.
    const [commentsResp, taskResp] = await Promise.all([
      fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(id)}/comment`, {
        headers: { Authorization: API_KEY }
      }),
      fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(id)}?include_markdown_description=true`, {
        headers: { Authorization: API_KEY }
      }).catch(() => null)
    ]);

    // 429 nunca pode virar "lista vazia": isso é indistinguível de "não tem
    // comentário" e faz o painel mentir. Devolvemos o 429 com o Retry-After
    // para o front poder avisar, sem retry automático — reenviar na hora só
    // agrava o estouro de cota, que é compartilhada com os outros painéis.
    const limitado = [commentsResp, taskResp].find(r => r && r.status === 429);
    if (limitado) {
      const retryAfter = limitado.headers?.get?.('Retry-After');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: 'Limite de requisições do ClickUp atingido. Aguarde alguns segundos e tente novamente.',
        rateLimited: true,
        retryAfter: retryAfter || null
      });
    }

    // Escopo: só tarefas da lista de análises. 404/403 do ClickUp cai aqui
    // também, porque sem a tarefa não há como provar que ela pertence à lista.
    let taskData = null;
    if (taskResp && taskResp.ok) {
      try { taskData = await taskResp.json(); } catch { taskData = null; }
    }
    if (!taskData) {
      return res.status(502).json({ error: 'Não foi possível validar a tarefa no ClickUp.' });
    }
    // Com o ClickApp "Tasks in Multiple Lists" ativo, a tarefa aparece na lista de
    // análises mas seu list.id aponta para a lista de origem. Por isso o escopo
    // aceita list.id OU qualquer entrada de locations[]: checar só list.id
    // recusaria tarefa legítima e o modal quebraria para ela.
    const listasDaTarefa = [
      taskData.list?.id,
      ...(Array.isArray(taskData.locations) ? taskData.locations.map(l => l?.id) : [])
    ].filter(Boolean).map(String);

    if (!listasDaTarefa.includes(String(LIST_ID))) {
      return res.status(404).json({ error: 'Tarefa não encontrada nesta lista.' });
    }

    const description =
      taskData.markdown_description || taskData.description || taskData.text_content || '';

    if (!commentsResp.ok) {
      return res.status(502).json({ error: 'Não foi possível carregar os comentários no ClickUp.' });
    }
    const commentsData = await commentsResp.json();
    const allComments = commentsData.comments || [];

    // Padrões que indicam mudança de status nos comentários de atividade do ClickUp
    const STATUS_PATTERNS = [
      /alterou o status de .+ para .+/i,
      /changed the status from .+ to .+/i,
      /status changed from .+ to .+/i,
      /moved this task from .+ to .+/i,
      /alterou o status para .+/i,
    ];

    const isStatusChange = (text) => STATUS_PATTERNS.some(p => p.test(text));

    // Separa comentários normais de registros de mudança de status
    const comments = [];
    const statusHistory = [];

    allComments.forEach(c => {
      const text = c.comment_text || (c.comment || []).map(x => x.text || '').join('') || '';
      const author = c.user?.username || c.user?.email || 'Sistema';
      const date = c.date || null;

      // Divide o texto em linhas — no ClickUp, atividades e comentários
      // ficam na mesma entrada mas separados por \n
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const statusLines = lines.filter(l => isStatusChange(l));
      const commentLines = lines.filter(l => !isStatusChange(l));

      // Se tem linhas de status, adiciona ao histórico
      statusLines.forEach(line => {
        statusHistory.push({ text: line, date, author });
      });

      // Se tem linhas de comentário real, adiciona aos comentários
      if (commentLines.length) {
        comments.push({
          id: c.id,
          text: commentLines.join('\n'),
          date,
          author
        });
      }
    });

    return res.status(200).json({ comments, statusHistory, description });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
