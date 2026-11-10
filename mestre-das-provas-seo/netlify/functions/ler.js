// Mestre das provas — lê páginas em imagem (PDF escaneado, slides, fotos) e devolve o texto.
// Usa as mesmas variáveis do gerar.js (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY, SALT).
// Cada 3 páginas lidas contam 1 do limite horário do visitante.
const crypto = require('crypto');

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIMITE = +process.env.LIMITE_QUESTOES_POR_HORA || 100;
const MODELOS = [...new Set((process.env.MODELOS_LEITURA || process.env.MODELOS ||
  [process.env.MODELO || 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'].join(','))
  .split(',').map(s => s.trim()).filter(Boolean))];
const PRAZO = +process.env.PRAZO_MS || 24000;
const ESPERA = process.env.ESPERA_MS !== undefined ? +process.env.ESPERA_MS : 700;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const out = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const dorme = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

const mimeDe = (b64) => b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('iVBOR') ? 'image/png' : b64.startsWith('UklGR') ? 'image/webp' : null;

const prompt = (de, qtd) => `Transcreva fielmente TODO o texto legível das ${qtd} imagem(ns) a seguir (OCR), na ordem de leitura. As imagens são páginas numeradas a partir de ${de}; comece cada página com uma linha "=== Página N ===".
- Preserve títulos, listas, enunciados, fórmulas e números exatamente como aparecem.
- Tabelas: uma linha por linha da tabela, colunas separadas por " | ".
- Figuras, gráficos e esquemas: descreva em uma frase entre colchetes, incluindo os rótulos e valores visíveis. Ex.: [Gráfico de barras: vendas por ano, 2022 = 10, 2023 = 14].
- Ignore apenas rodapés de navegador (URL, data e hora de impressão).
- Não resuma, não comente, não corrija e não invente nada. Se uma página estiver ilegível ou em branco, escreva [página ilegível].`;

async function chamarGemini(partes, inicio) {
  let ultimo = 'sem resposta', tentativas = 0, altaDemanda = false;
  for (let volta = 0; volta < 2; volta++) {
    for (const modelo of MODELOS) {
      const restante = PRAZO - (Date.now() - inicio);
      if (restante < 3500) return { erro: ultimo, tentativas, altaDemanda };
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), Math.min(restante - 300, volta === 0 && modelo === MODELOS[0] ? 18000 : 22000));
      tentativas++;
      try {
        const gc = { maxOutputTokens: 8000, temperature: 0.1 };
        if (modelo === 'gemini-2.5-flash') gc.thinkingConfig = { thinkingBudget: 0 };
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
          method: 'POST', signal: ac.signal,
          headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: partes }], generationConfig: gc })
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          const c = j.candidates && j.candidates[0];
          const txt = ((c && c.content && c.content.parts) || []).map(p => p.text || '').join('').trim();
          if (txt) return { texto: txt, modelo, tentativas };
          ultimo = 'resposta vazia (' + ((c && c.finishReason) || (j.promptFeedback && j.promptFeedback.blockReason) || 'sem motivo') + ')';
        } else {
          const msg = (j.error && j.error.message) || ('HTTP ' + r.status);
          ultimo = msg;
          if (r.status === 401 || (r.status === 400 && /api key/i.test(msg))) return { erro: 'A chave do Gemini é inválida ou não tem permissão.', fatal: true, tentativas };
          if (r.status === 503 || r.status === 429 || /high demand|overloaded|unavailable/i.test(msg)) altaDemanda = true;
        }
      } catch (e) {
        ultimo = e.name === 'AbortError' ? 'tempo esgotado' : String((e && e.message) || e);
      } finally { clearTimeout(to); }
      await dorme(ESPERA / 2);
    }
    await dorme(ESPERA * 2);
  }
  return { erro: ultimo, tentativas, altaDemanda };
}

exports.handler = async (ev) => {
  const t0 = Date.now();
  if (ev.httpMethod !== 'POST') return out(405, { erro: 'Método não permitido.' });
  if ((ev.body || '').length > 5.8e6) return out(413, { erro: 'Imagens grandes demais para uma só chamada.' });
  let b;
  try { b = JSON.parse(ev.body || '{}'); } catch (e) { return out(400, { erro: 'Requisição inválida.' }); }
  const imgs = (Array.isArray(b.imagens) ? b.imagens : []).slice(0, 6).map(s => String(s || '').replace(/^data:[^,]*,/, ''));
  const de = clamp(parseInt(b.de) || 1, 1, 9999);
  if (!imgs.length) return out(400, { erro: 'Nenhuma imagem enviada.' });
  const partes = [{ text: prompt(de, imgs.length) }];
  for (const im of imgs) {
    const mime = mimeDe(im);
    if (!mime || im.length < 200 || im.length > 2.4e6) return out(400, { erro: 'Imagem inválida ou grande demais.' });
    partes.push({ inline_data: { mime_type: mime, data: im } });
  }

  const custo = Math.ceil(imgs.length / 3);
  const ip = ev.headers['x-nf-client-connection-ip'] || ev.headers['client-ip'] || '0';
  const hash = crypto.createHash('sha256').update(ip + (process.env.SALT || '')).digest('hex');
  let idUso = null;
  try {
    const desde = new Date(Date.now() - 3600e3).toISOString();
    const r = await fetch(`${SB}/rest/v1/uso?select=n&ip_hash=eq.${hash}&criado_em=gte.${desde}&limit=1000`, { headers: H });
    const linhas = r.ok ? await r.json() : null;
    if (!Array.isArray(linhas)) throw new Error('uso');
    const usado = linhas.reduce((s, x) => s + (+x.n || 0), 0);
    if (usado + custo > LIMITE) return out(429, { erro: `Limite de uso por hora atingido (${usado} de ${LIMITE}). Tente de novo mais tarde.`, codigo: 'limite' });
    const ins = await fetch(`${SB}/rest/v1/uso`, { method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify({ ip_hash: hash, n: custo }) });
    const reg = await ins.json().catch(() => null);
    idUso = Array.isArray(reg) && reg[0] && reg[0].id ? reg[0].id : null;
  } catch (e) { return out(500, { erro: 'Falha ao acessar o banco de dados.' }); }

  const res = await chamarGemini(partes, t0);
  if (res.erro) {
    if (idUso) { try { await fetch(`${SB}/rest/v1/uso?id=eq.${idUso}`, { method: 'DELETE', headers: H }); } catch (e) { /* ignora */ } }
    if (res.fatal) return out(502, { erro: res.erro, codigo: 'chave' });
    if (res.altaDemanda) return out(503, { erro: 'O Gemini está com alta demanda agora. Tente de novo em cerca de 1 minuto.', codigo: 'alta_demanda' });
    return out(502, { erro: 'Erro ao ler as imagens: ' + res.erro, codigo: 'gerador' });
  }
  return out(200, { texto: res.texto, modelo: res.modelo });
};
