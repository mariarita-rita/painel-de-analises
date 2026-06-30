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

  const { taskId, flagType, authorName } = req.body || {};

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
    }
  };

  const config = FLAG_CONFIG[flagType];
  if (!config) {
    return res.status(400).json({ error: 'flagType inválido. Use "retorno" ou "churn"' });
  }

  try {
    // 1. Adiciona o comentário
    const commentText = `${config.emoji} **${config.label}** — sinalizado por ${authorName} via Painel de Monitoramento, em ${new Date().toLocaleString('pt-BR')}.`;

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

    // 2. Adiciona a tag nativa na tarefa
    const tagResp = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/tag/${encodeURIComponent(config.tagName)}`, {
      method: 'POST',
      headers: { Authorization: API_KEY }
    });

    // Tag pode falhar se já existir vinculada ou se a tag não existir no espaço — não bloqueia o fluxo
    let tagWarning = null;
    if (!tagResp.ok) {
      const err = await tagResp.text();
      tagWarning = `Comentário adicionado, mas a tag não pôde ser aplicada: ${err}`;
    }

    return res.status(200).json({
      success: true,
      message: tagWarning || 'Sinalização registrada com sucesso.',
      warning: !!tagWarning
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
