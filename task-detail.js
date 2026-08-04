export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const API_KEY = process.env.CLICKUP_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'Variáveis de ambiente não configuradas' });

  const { id, withDescription } = req.query;
  if (!id) return res.status(400).json({ error: 'ID da tarefa obrigatório' });

  // O front manda withDescription=0 quando já tem a descrição em cache da
  // sessão, para não pagar a chamada de novo.
  const buscarDescricao = withDescription !== '0';

  try {
    // Comentários e detalhe da tarefa em paralelo — a descrição é um extra:
    // se a chamada dela falhar, o endpoint segue entregando os comentários.
    const [commentsResp, taskResp] = await Promise.all([
      fetch(`https://api.clickup.com/api/v2/task/${id}/comment`, {
        headers: { Authorization: API_KEY }
      }),
      buscarDescricao
        ? fetch(`https://api.clickup.com/api/v2/task/${id}?include_markdown_description=true`, {
            headers: { Authorization: API_KEY }
          }).catch(() => null)
        : Promise.resolve('skip')
    ]);

    let description = taskResp === 'skip' ? undefined : null;
    if (taskResp && taskResp !== 'skip' && taskResp.ok) {
      try {
        const taskData = await taskResp.json();
        description = taskData.markdown_description || taskData.description || taskData.text_content || '';
      } catch {
        description = null;
      }
    }

    const commentsData = commentsResp.ok ? await commentsResp.json() : { comments: [] };
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
