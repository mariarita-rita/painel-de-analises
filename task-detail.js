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
    const [commentsResp, historyResp] = await Promise.all([
      fetch(`https://api.clickup.com/api/v2/task/${id}/comment`, {
        headers: { Authorization: API_KEY }
      }),
      // Busca todo o histórico sem filtro para ver a estrutura completa
      fetch(`https://api.clickup.com/api/v2/task/${id}/history`, {
        headers: { Authorization: API_KEY }
      })
    ]);

    const commentsData = commentsResp.ok ? await commentsResp.json() : { comments: [] };
    const historyData = historyResp.ok ? await historyResp.json() : {};

    // Processa comentários
    const comments = (commentsData.comments || []).map(c => ({
      id: c.id,
      text: c.comment_text || (c.comment || []).map(x => x.text || '').join('') || '',
      date: c.date || null,
      author: c.user?.username || c.user?.email || 'Sistema'
    }));

    // O histórico pode estar em history, data ou outro campo — extrai tudo
    const historyRaw = historyData.history || historyData.data || historyData.events || [];

    const statusHistory = historyRaw
      .filter(h => {
        // Tenta detectar mudanças de status por diferentes formatos
        return h.field === 'status' ||
               h.type === 'status_updated' ||
               (h.before?.status !== undefined) ||
               (h.data?.field === 'status');
      })
      .map(h => {
        const from = h.before?.status || h.before || h.data?.before || '—';
        const to = h.after?.status || h.after || h.data?.after || '—';
        return {
          date: h.date || h.created_at || null,
          from: typeof from === 'object' ? (from.status || JSON.stringify(from)) : String(from),
          to: typeof to === 'object' ? (to.status || JSON.stringify(to)) : String(to),
          user: h.user?.username || h.user?.email || h.assigned_by?.username || 'Sistema'
        };
      });

    // Debug: retorna também a estrutura crua para diagnóstico
    return res.status(200).json({
      comments,
      statusHistory,
      _debug_history_keys: Object.keys(historyData),
      _debug_first_item: historyRaw[0] || null
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
