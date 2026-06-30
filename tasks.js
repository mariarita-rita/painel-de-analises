export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const LIST_ID = process.env.CLICKUP_LIST_ID;
  const API_KEY = process.env.CLICKUP_API_KEY;

  if (!LIST_ID || !API_KEY) {
    return res.status(500).json({ error: 'Variáveis de ambiente não configuradas' });
  }

  try {
    let page = 0;
    let allTasks = [];
    let hasMore = true;

    while (hasMore) {
      const url = `https://api.clickup.com/api/v2/list/${LIST_ID}/task?include_closed=true&page=${page}&subtasks=true`;
      const response = await fetch(url, {
        headers: { Authorization: API_KEY }
      });

      if (!response.ok) {
        const err = await response.text();
        return res.status(response.status).json({ error: `Erro ClickUp: ${err}` });
      }

      const data = await response.json();
      allTasks = allTasks.concat(data.tasks || []);
      hasMore = !data.last_page && (data.tasks || []).length > 0;
      page++;
    }

    // Busca o último comentário de cada tarefa (em paralelo, em lotes para não estourar rate limit)
    const BATCH_SIZE = 10;
    const commentsMap = {};

    for (let i = 0; i < allTasks.length; i += BATCH_SIZE) {
      const batch = allTasks.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (t) => {
          try {
            const cResp = await fetch(`https://api.clickup.com/api/v2/task/${t.id}/comment?limit=1`, {
              headers: { Authorization: API_KEY }
            });
            if (!cResp.ok) return { id: t.id, comment: null };
            const cData = await cResp.json();
            const latest = (cData.comments || [])[0];
            if (!latest) return { id: t.id, comment: null };
            return {
              id: t.id,
              comment: {
                text: latest.comment_text || (latest.comment || []).map(c => c.text).join('') || '',
                date: latest.date || null,
                author: latest.user?.username || latest.user?.email || ''
              }
            };
          } catch {
            return { id: t.id, comment: null };
          }
        })
      );
      results.forEach(r => { commentsMap[r.id] = r.comment; });
    }

    const tasks = allTasks.map(t => {
      const cf = t.custom_fields || [];
      const getField = (...names) => {
        for (const n of names) {
          const f = cf.find(x => x.name?.toLowerCase().includes(n.toLowerCase()));
          if (f && f.value != null && f.value !== '') return String(f.value);
        }
        return '';
      };

      const lastComment = commentsMap[t.id];

      return {
        id: t.id,
        name: t.name || '',
        status: t.status?.status || '',
        statusColor: t.status?.color || '',
        assignees: (t.assignees || []).map(a => a.username || a.email || '').filter(Boolean),
        due_date: t.due_date || null,
        url: t.url || '',
        nucleo: getField('núcleo', 'nucleo', 'id núcleo', 'id nucleo'),
        cliente: getField('cliente', 'solicitante', 'empresa', 'company'),
        jiraUrl: getField('jira issue url', 'jira url', 'jira issue', 'issue url'),
        ambiente: getField('ambiente'),
        urgencia: getField('urgência', 'urgencia'),
        lastComment: lastComment?.text || '',
        lastCommentDate: lastComment?.date || null,
        lastCommentAuthor: lastComment?.author || '',
      };
    });

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({ tasks, total: tasks.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
