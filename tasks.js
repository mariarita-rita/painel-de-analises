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

  const DIA_MS = 24 * 60 * 60 * 1000;
  const PADRAO_DIAS = 90;

  try {
    // req.query é getter lazy no runtime da Vercel: acessar fora do try faz uma
    // URL malformada derrubar a função em vez de virar 400.
    const q = req.query || {};

    // Corte de data aplicado SÓ às finalizadas. Análise em aberto carrega
    // sempre, sem corte: esconder uma aberta porque é antiga apaga exatamente o
    // que mais importa num painel de acompanhamento.
    let closedDays = PADRAO_DIAS;
    const pedido = String(q.closedDays == null ? '' : q.closedDays).trim().toLowerCase();
    if (pedido === 'todos' || pedido === '0') closedDays = 0;
    else if (/^\d{1,4}$/.test(pedido)) closedDays = Number(pedido);

    // 429 tem tratamento próprio: mensagem clara e Retry-After repassado, sem
    // retry automático. Reenviar na hora só agrava o estouro de uma cota que é
    // compartilhada com os outros painéis. Como agora há mais de uma consulta,
    // o paginador sinaliza por exceção tipada e quem trata é o catch.
    const buscarPaginas = async (base) => {
      const out = [];
      let page = 0;
      for (;;) {
        const resp = await fetch(`${base}&page=${page}`, { headers: { Authorization: API_KEY } });
        if (resp.status === 429) {
          const e = new Error('rate');
          e.rateLimited = true;
          e.retryAfter = resp.headers?.get?.('Retry-After') || null;
          throw e;
        }
        if (!resp.ok) {
          const e = new Error(await resp.text());
          e.upstream = resp.status;
          throw e;
        }
        const data = await resp.json();
        const lote = data.tasks || [];
        out.push(...lote);
        if (data.last_page || !lote.length) break;
        page++;
      }
      return out;
    };

    const RAIZ = `https://api.clickup.com/api/v2/list/${encodeURIComponent(LIST_ID)}/task?subtasks=true`;

    let allTasks;
    let escopo;

    if (!closedDays) {
      allTasks = await buscarPaginas(`${RAIZ}&include_closed=true`);
      escopo = { closedDays: 0, corte: null, abertas: null, fechadasNoPeriodo: null, dateDoneAplicado: null };
    } else {
      const corte = Date.now() - closedDays * DIA_MS;

      // `include_closed=false` já exclui os status do tipo `closed` — nesta lista,
      // só `finalizado`. `cancelado` é do tipo `done` e continua vindo aqui, o
      // que é o que queremos: são poucos e não entram no corte.
      const [abertas, fechadasBrutas] = await Promise.all([
        buscarPaginas(`${RAIZ}&include_closed=false`),
        buscarPaginas(`${RAIZ}&include_closed=true&statuses%5B%5D=finalizado&date_done_gt=${corte}`)
      ]);

      // ⚠️ `date_done_gt` e `statuses[]` NÃO foram verificados contra a API real.
      // Então o corte é reaplicado localmente: se a API ignorar os parâmetros, a
      // saída continua correta — só a economia de chamadas não acontece. É o
      // mesmo cuidado do `blocosVistos` no mentions.js: parâmetro não verificado
      // não pode falhar em silêncio.
      const fechadas = fechadasBrutas.filter(t => Number(t.date_closed || 0) > corte);

      // Dedupe por id: se `statuses[]` for ignorado, a segunda consulta devolve
      // tarefas que a primeira já trouxe.
      const porId = new Map();
      [...abertas, ...fechadas].forEach(t => { if (t && t.id) porId.set(t.id, t); });
      allTasks = [...porId.values()];

      escopo = {
        closedDays,
        corte,
        abertas: abertas.length,
        fechadasRecebidas: fechadasBrutas.length,
        fechadasNoPeriodo: fechadas.length,
        // Descarte local alto significa que a API devolveu finalizadas fora do
        // período, isto é: o parâmetro não foi aplicado e não houve economia.
        dateDoneAplicado: fechadasBrutas.length === fechadas.length
      };
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

    // s-maxage 60 (era 30): o cliente já recarrega a cada 60 s, então meia janela
    // de cache só dobrava as chamadas sem entregar dado mais novo a ninguém. Foi
    // a maior economia de cota do painel, e custa uma linha — bem mais que o
    // corte de data, que rende ~1 chamada por carga.
    // A chave de cache inclui a query, então cada valor de closedDays tem a sua
    // própria entrada: usuários com períodos diferentes não colapsam na mesma.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ tasks, total: tasks.length, escopo });
  } catch (e) {
    if (e.rateLimited) {
      if (e.retryAfter) res.setHeader('Retry-After', e.retryAfter);
      return res.status(429).json({
        error: 'Limite de requisições do ClickUp atingido. Aguarde alguns segundos e tente novamente.',
        rateLimited: true,
        retryAfter: e.retryAfter
      });
    }
    if (e.upstream) {
      return res.status(e.upstream).json({ error: `Erro ClickUp: ${e.message}` });
    }
    return res.status(500).json({ error: e.message });
  }
}
