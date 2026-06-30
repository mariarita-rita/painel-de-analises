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

  let taskId, flagType, authorName, note, file;

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
      }
    } else {
      const buffer = await readRawBody(req);
      const body = JSON.parse(buffer.toString('utf8') || '{}');
      taskId = body.taskId; flagType = body.flagType; authorName = body.authorName; note = body.note;
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

  try {
    let commentText = `${config.emoji} **${config.label}** — sinalizado por ${authorName} via Painel de Monitoramento, em ${new Date().toLocaleString('pt-BR')}.`;
    if (note && note.trim()) {
      commentText += `\n\nNota: ${note.trim()}`;
    }

    const commentResp = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
      method: 'POST',
      headers: {
        Authorization: API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment_text: commentText, notify_all: true })
    });

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

    const warnings = [tagWarning, attachWarning].filter(Boolean);

    return res.status(200).json({
      success: true,
      message: warnings.length ? warnings.join(' | ') : 'Sinalização registrada com sucesso.',
      warning: warnings.length > 0
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
