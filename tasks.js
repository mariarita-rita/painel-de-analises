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

      // ARMADILHA: dois campos desta lista contêm "solicitante" no nome —
      // "Solicitante" (`329ce990-…`, type `users`, a pessoa) e
      // "Cliente - Solicitante" (`ba361d20-…`, type `short_text`, a razão social
      // do cliente). O de texto vem ANTES no array, então um `cf.find` por
      // `includes` pega o cliente e não a pessoa. Era o que acontecia: a coluna
      // "Solicitante" mostrava a mesma razão social da coluna "Cliente".
      //
      // Por isso a busca ordena os candidatos em vez de pegar o primeiro:
      // nome exato + type `users` primeiro, depois type `users`, depois nome
      // exato, e só então o resto.
      const candidatosPara = (nome) => {
        const alvo = nome.toLowerCase();
        return cf
          .filter(x => x.name?.toLowerCase().includes(alvo))
          .map(x => {
            const exato = (x.name || '').toLowerCase() === alvo;
            const pessoa = x.type === 'users';
            return { f: x, peso: (pessoa && exato) ? 0 : pessoa ? 1 : exato ? 2 : 3 };
          })
          .sort((a, b) => a.peso - b.peso)
          .map(x => x.f);
      };

      const getPersonField = (...names) => {
        for (const n of names) {
          for (const f of candidatosPara(n)) {
            if (f.value == null) continue;
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
        }
        return '';
      };

      // Mesma leitura de getPersonField, mas preservando o `id` do usuário do
      // ClickUp. Campo do tipo `users` devolve o objeto completo — o `id` estava
      // sendo descartado, e sem ele não há como identificar pessoa com segurança:
      // o painel caía em casar por nome digitado à mão, que erra ("Aline Costa"
      // não existe; o workspace tem "Aline Rosa"). Devolve [] quando o valor vem
      // como texto solto, porque aí não existe id nenhum para recuperar.
      const getPersonFieldFull = (...names) => {
        for (const n of names) {
          for (const f of candidatosPara(n)) {
            if (f.value == null) continue;
            const val = Array.isArray(f.value) ? f.value : [f.value];
            const people = val
              .filter(p => p && typeof p === 'object' && p.id != null)
              .map(p => ({ id: p.id, nome: p.username || p.email || '' }))
              .filter(p => p.nome);
            if (people.length) return people;
          }
        }
        return [];
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
        // Com id: o analista responsável varia por tarefa (Lucas 82010227,
        // Matheus 43078993, Cassia 42921071, Maria Rita 42926569) e algumas têm
        // dois. Quem precisa ser avisado de uma sinalização é o assignee da
        // própria tarefa, então o id não pode ser fixo nem inferido pelo nome.
        assigneesFull: (t.assignees || [])
          .filter(a => a && a.id != null)
          .map(a => ({ id: a.id, nome: a.username || a.email || '' }))
          .filter(a => a.nome),
        due_date: t.due_date || null,
        url: t.url || '',
        nucleo: getField('núcleo', 'nucleo', 'id núcleo', 'id nucleo'),
        cliente: getField('cliente', 'empresa', 'company'),
        solicitante: getPersonField('solicitante'),
        solicitantes: getPersonFieldFull('solicitante'),
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
