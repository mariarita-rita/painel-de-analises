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
      const url = `https://api.clickup.com/api/v2/list/${LIST_ID}/task?include_closed=true&page=${page}&custom_fields=true&subtasks=true`;
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

    const tasks = allTasks.map(t => {
      const cf = t.custom_fields || [];
      const getField = (...names) => {
        for (const n of names) {
          const f = cf.find(x => x.name?.toLowerCase().includes(n.toLowerCase()));
          if (f && f.value != null && f.value !== '') return String(f.value);
        }
        return '';
      };

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
      };
    });

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({ tasks, total: tasks.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
