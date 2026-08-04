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

      // 429 tem tratamento próprio: mensagem clara e Retry-After repassado, sem
      // retry automático. Reenviar na hora só agrava o estouro de uma cota que é
      // compartilhada com os outros painéis.
      if (response.status === 429) {
        const retryAfter = response.headers?.get?.('Retry-After');
        if (retryAfter) res.setHeader('Retry-After', retryAfter);
        return res.status(429).json({
          error: 'Limite de requisições do ClickUp atingido. Aguarde alguns segundos e tente novamente.',
          rateLimited: true,
          retryAfter: retryAfter || null
        });
      }

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

      const getPersonField = (...names) => {
        for (const n of names) {
          const f = cf.find(x => x.name?.toLowerCase().includes(n.toLowerCase()));
          if (!f || f.value == null) continue;
          const val = f.value;
          if (Array.isArray(val)) {
            const ns = val.map(p => p.username || p.email || '').filter(Boolean);
            if (ns.length) return ns.join(', ');
          } else if (typeof val === 'object') {
            const n2 = val.username || val.email || '';
            if (n2) return n2;
          } else if (val) {
            return String(val);
          }
        }
        return '';
      };

      return {
        id: t.id,
        name: t.name || '',
        assunto: t.name || '',
        date_created: t.date_created || null,
        date_updated: t.date_updated || null,
        start_date: t.start_date || null,
        date_closed: t.date_closed || null,
        status: t.status?.status || '',
        statusColor: t.status?.color || '',
        assignees: (t.assignees || []).map(a => a.username || a.email || '').filter(Boolean),
        due_date: t.due_date || null,
        url: t.url || '',
        nucleo: getField('núcleo', 'nucleo', 'id núcleo', 'id nucleo'),
        cliente: getField('cliente', 'empresa', 'company'),
        solicitante: getPersonField('solicitante'),
        jiraUrl: getField('jira issue url', 'jira url', 'jira issue', 'issue url'),
        ambiente: getField('ambiente'),
        urgencia: getField('urgência', 'urgencia'),
        tags: (t.tags || []).map(tag => ({ name: tag.name, color: tag.tag_fg || '#64748B' })),
      };
    });

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({ tasks, total: tasks.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
