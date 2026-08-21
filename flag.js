export const config = {
  api: {
    bodyParser: false
  }
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Os IDs chegam do front (t.assigneesFull), não de uma leitura da tarefa aqui:
// buscar a tarefa custaria uma chamada a mais numa cota de 100/min compartilhada
// com o dashboard de carteiras e o Apps Script. O preço é que o dado pode estar
// até 60 s velho (o intervalo de recarga do painel), então uma troca de
// responsável nesse intervalo mencionaria o anterior. Aceitável: o assignee
// atual é notificado pelo ClickUp de qualquer forma, por ser assignee.
function normalizarIds(bruto) {
  let arr = [];
  if (Array.isArray(bruto)) {
    arr = bruto;
  } else if (typeof bruto === 'string' && bruto.trim()) {
    try {
      const parsed = JSON.parse(bruto);
      arr = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      arr = bruto.split(',');
    }
  }
  const out = [];
  for (const v of arr) {
    const n = Number(v && typeof v === 'object' ? v.id : v);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

// Parser simples de multipart/form-data (sem dependências externas)
function extractParts(buffer, boundary) {
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buffer.indexOf(boundaryBuf);
  while (start !== -1) {
    const next = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
    if (next === -1) break;
    const partBuf = buffer.slice(start + boundaryBuf.length, next);
    parts.push(partBuf);
    start = next;
  }
  return parts.map(p => {
    let buf = p;
    if (buf.slice(0, 2).toString() === '\r\n') buf = buf.slice(2);
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return null;
    const headerStr = buf.slice(0, headerEnd).toString('utf8');
    let body = buf.slice(headerEnd + 4);
    if (body.slice(-2).toString() === '\r\n') body = body.slice(0, -2);

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const typeMatch = headerStr.match(/Content-Type:\s*(.+)/i);

    return {
      name: nameMatch ? nameMatch[1] : null,
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
      data: body
    };
  }).filter(Boolean);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const API_KEY = process.env.CLICKUP_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'Variáveis de ambiente não configuradas' });
  }

  const contentType = req.headers['content-type'] || '';

  let taskId, flagType, authorName, note, file, assigneeIdsRaw;

  try {
    if (contentType.includes('multipart/form-data')) {
      const boundaryMatch = contentType.match(/boundary=(.+)$/);
      if (!boundaryMatch) return res.status(400).json({ error: 'Boundary multipart não encontrado' });
      const boundary = boundaryMatch[1];
      const buffer = await readRawBody(req);
      const parts = extractParts(buffer, boundary);

      for (const part of parts) {
        if (part.filename) {
          file = part;
        } else if (part.name === 'taskId') taskId = part.data.toString('utf8');
        else if (part.name === 'flagType') flagType = part.data.toString('utf8');
        else if (part.name === 'authorName') authorName = part.data.toString('utf8');
        else if (part.name === 'note') note = part.data.toString('utf8');
        else if (part.name === 'assigneeIds') assigneeIdsRaw = part.data.toString('utf8');
      }
    } else {
      const buffer = await readRawBody(req);
      const body = JSON.parse(buffer.toString('utf8') || '{}');
      taskId = body.taskId; flagType = body.flagType; authorName = body.authorName; note = body.note;
      assigneeIdsRaw = body.assigneeIds;
    }
  } catch (e) {
    return res.status(400).json({ error: `Erro ao processar requisição: ${e.message}` });
  }

  if (!taskId || !flagType || !authorName) {
    return res.status(400).json({ error: 'Parâmetros obrigatórios: taskId, flagType, authorName' });
  }

  const FLAG_CONFIG = {
    retorno: {
      tagName: 'cliente-pede-retorno',
      label: 'Cliente pede retorno',
      emoji: '📞'
    },
    churn: {
      tagName: 'risco-churn',
      label: 'Risco de churn',
      emoji: '🚨'
    },
    cancelou: {
      tagName: 'cliente-cancelou',
      label: 'Cliente cancelou',
      emoji: '❌'
    },
    retorno_cliente: {
      tagName: 'retorno-do-cliente',
      label: 'Retorno do cliente',
      emoji: '💬'
    }
  };

  const config = FLAG_CONFIG[flagType];
  if (!config) {
    return res.status(400).json({ error: 'flagType inválido' });
  }

  const assigneeIds = normalizarIds(assigneeIdsRaw);

  try {
    // Array de blocos, não `comment_text`. É a única forma de gerar menção
    // estruturada ({type:'tag', user:{id}}), que é o que faz a notificação
    // chegar a uma pessoa específica e o que o sininho consegue reconhecer
    // depois. O parâmetro `comment` não consta no schema do endpoint, só na
    // página de Comment formatting — verificado na API real antes de usar:
    // o bloco tag sobrevive e renderiza como menção.
    //
    // Como blocos não interpretam Markdown, o negrito do rótulo vem de
    // attributes.bold — `**texto**` sairia literal.
    const comment = [
      { text: `${config.emoji} ` },
      { text: config.label, attributes: { bold: true } },
      { text: ` — sinalizado por ${authorName} via Painel de Monitoramento, em ${new Date().toLocaleString('pt-BR')}.` }
    ];

    // Menciona o ANALISTA (assignee da tarefa), não quem sinalizou: mencionar
    // quem acabou de agir é recibo, não notificação. Quem precisa saber é quem
    // tem de agir. Todos os assignees, porque há tarefas com dois.
    if (assigneeIds.length) {
      comment.push({ text: '\n\n' });
      assigneeIds.forEach((id, i) => {
        if (i > 0) comment.push({ text: ' ' });
        comment.push({ type: 'tag', user: { id } });
      });
    }

    if (note && note.trim()) {
      comment.push({ text: `\n\nNota: ${note.trim()}` });
    }

    const commentResp = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
      method: 'POST',
      headers: {
        Authorization: API_KEY,
        'Content-Type': 'application/json'
      },
      // notify_all: false, e não omitido — o schema marca o campo como
      // obrigatório, e explícito evita depender do default. Estava `true`, que
      // notificava o dono do token (quem sinaliza não é o dono do token) e não
      // acrescentava nada: assignees e watchers são notificados de qualquer
      // forma, independente deste campo.
      body: JSON.stringify({ comment, notify_all: false })
    });

    // 429 antes do erro genérico: a sinalização não foi registrada, e o usuário
    // precisa saber que é limite de cota e não falha de dado — senão ele reenvia
    // no ato e piora o estouro.
    if (commentResp.status === 429) {
      const retryAfter = commentResp.headers?.get?.('Retry-After');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: 'Limite de requisições do ClickUp atingido. A sinalização NÃO foi registrada. Aguarde alguns segundos e tente novamente.',
        rateLimited: true,
        retryAfter: retryAfter || null
      });
    }

    if (!commentResp.ok) {
      const err = await commentResp.text();
      return res.status(commentResp.status).json({ error: `Erro ao comentar: ${err}` });
    }

    // Tag nativa
    let tagWarning = null;
    const tagResp = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/tag/${encodeURIComponent(config.tagName)}`, {
      method: 'POST',
      headers: { Authorization: API_KEY }
    });
    if (!tagResp.ok) {
      const err = await tagResp.text();
      tagWarning = `Tag não aplicada: ${err}`;
    }

    // Upload de anexo, se houver arquivo
    let attachWarning = null;
    if (file) {
      try {
        const boundary = '----ClickUpUploadBoundary' + Date.now();
        const preamble = Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
        );
        const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
        const multipartBody = Buffer.concat([preamble, file.data, epilogue]);

        const uploadResp = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/attachment`, {
          method: 'POST',
          headers: {
            Authorization: API_KEY,
            'Content-Type': `multipart/form-data; boundary=${boundary}`
          },
          body: multipartBody
        });

        if (!uploadResp.ok) {
          const err = await uploadResp.text();
          attachWarning = `Anexo não pôde ser enviado: ${err}`;
        }
      } catch (e) {
        attachWarning = `Erro ao enviar anexo: ${e.message}`;
      }
    }

    // Tarefa sem responsável: não menciona ninguém, e avisa. Cair num ID
    // padrão foi descartado — ID fixo estaria errado na maioria dos casos
    // (o assignee varia entre pelo menos quatro pessoas), e mencionar a pessoa
    // errada ensina todo mundo a ignorar menção, o que é pior que não mencionar.
    // A sinalização não se perde: comentário e etiqueta são aplicados, e uma
    // análise sinalizada sem responsável é ela mesma uma condição que alguém
    // precisa ver — por isso vira aviso na tela de quem sinalizou.
    const mencaoWarning = assigneeIds.length
      ? null
      : 'Sinalização registrada, mas ninguém foi mencionado: esta análise não tem responsável no ClickUp.';

    const warnings = [mencaoWarning, tagWarning, attachWarning].filter(Boolean);

    return res.status(200).json({
      success: true,
      message: warnings.length ? warnings.join(' | ') : 'Sinalização registrada com sucesso.',
      warning: warnings.length > 0
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
