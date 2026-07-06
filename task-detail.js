export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const API_KEY = process.env.CLICKUP_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'Variáveis de ambiente não configuradas' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'ID da tarefa obrigatório' });

  try {
    // Busca comentários completos (sem limit)
    const [commentsResp, activityResp] = await Promise.all([
      fetch(`https://api.clickup.com/api/v2/task/${id}/comment`, {
        headers: { Authorization: API_KEY }
      }),
      fetch(`https://api.clickup.com/api/v2/task/${id}/activity`, {
        headers: { Authorization: API_KEY }
      })
    ]);

    const commentsData = commentsResp.ok ? await commentsResp.json() : { comments: [] };
    const activityData = activityResp.ok ? await activityResp.json() : { history: [] };

    // Processa comentários
    const comments = (commentsData.comments || []).map(c => ({
      id: c.id,
      text: c.comment_text || (c.comment || []).map(x => x.text).join('') || '',
      date: c.date || null,
      author: c.user?.username || c.user?.email || 'Sistema',
      reactions: c.reactions || []
    }));

    // Filtra histórico de mudanças de status do activity log
    const statusHistory = (activityData.history || [])
      .filter(h => h.field === 'status')
      .map(h => ({
        date: h.date || null,
        from: h.before?.status || '—',
        to: h.after?.status || '—',
        user: h.user?.username || h.user?.email || 'Sistema'
      }));

    return res.status(200).json({ comments, statusHistory });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
