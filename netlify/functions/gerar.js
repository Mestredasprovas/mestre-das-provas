const crypto = require('crypto');
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIMITE = +process.env.LIMITE_POR_HORA || 20; // chamadas por visitante por hora
const MODELO = process.env.MODELO || 'claude-haiku-4-5-20251001';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const NIVEIS = ['intermediário', 'avançado', 'concurso/residência (muito difícil)'];
const out = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

const mk = (t, n, lv) => `Você é professor universitário e elaborador de provas. Com base APENAS no conteúdo abaixo, crie ${n} questões objetivas de múltipla escolha, nível ${lv}, com 4 alternativas e exatamente uma correta.
Regras: exigir análise, aplicação, comparação ou raciocínio (não só memorização); distratores plausíveis; variar a posição da correta; não repetir questões; enunciados claros, no idioma do conteúdo.
REGRA IMPORTANTE: se o enunciado disser "segundo o texto", "de acordo com o texto", "com base no texto", "o trecho", "o autor" ou qualquer referência a um texto, inclua obrigatoriamente no campo "texto" o trecho completo (2 a 8 frases, fiel ao conteúdo) a que a questão se refere. Nunca cite um texto que não esteja no campo "texto". Se a questão não se refere a um texto, use "texto":"".
Para cada questão inclua "explicacao" (por que a alternativa correta está certa, 1-3 frases) e "porque": lista de 4 frases curtas, na ordem das alternativas, dizendo por que cada alternativa está certa ou errada.
Responda SOMENTE com JSON: {"questoes":[{"texto":"...","enunciado":"...","alternativas":["...","...","...","..."],"correta":0,"explicacao":"...","porque":["...","...","...","..."],"tema":"..."}]} ("correta" = índice 0-3; alternativas sem prefixo de letra).

CONTEÚDO:
"""
${t}
"""`;

exports.handler = async (ev) => {
  if (ev.httpMethod !== 'POST') return out(405, { erro: 'Método não permitido.' });
  let b;
  try { b = JSON.parse(ev.body || '{}'); } catch { return out(400, { erro: 'Requisição inválida.' }); }
  const texto = String(b.texto || '').slice(0, 60000);
  const n = Math.min(Math.max(parseInt(b.n) || 0, 1), 5);
  const nivel = NIVEIS.includes(b.nivel) ? b.nivel : 'avançado';
  if (texto.length < 100) return out(400, { erro: 'Conteúdo muito curto.' });

  const ip = ev.headers['x-nf-client-connection-ip'] || ev.headers['client-ip'] || '0';
  const hash = crypto.createHash('sha256').update(ip + (process.env.SALT || '')).digest('hex');
  try {
    const desde = new Date(Date.now() - 3600e3).toISOString();
    const r = await fetch(`${SB}/rest/v1/uso?select=id&ip_hash=eq.${hash}&criado_em=gte.${desde}`,
      { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
    const total = +((r.headers.get('content-range') || '*/0').split('/')[1]) || 0;
    if (total >= LIMITE) return out(429, { erro: 'Limite de uso por hora atingido. Tente de novo mais tarde.' });
    await fetch(`${SB}/rest/v1/uso`, { method: 'POST', headers: H, body: JSON.stringify({ ip_hash: hash, n }) });
  } catch (e) { return out(500, { erro: 'Falha ao acessar o banco de dados.' }); }

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ac.signal,
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODELO, max_tokens: 4000, messages: [{ role: 'user', content: mk(texto, n, nivel) }] })
    });
    const j = await r.json();
    if (!r.ok) return out(502, { erro: 'Erro no gerador: ' + ((j.error && j.error.message) || r.status) });
    const txt = (j.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    const p = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    return out(200, { questoes: p.questoes || [] });
  } catch (e) {
    return out(504, { erro: e.name === 'AbortError' ? 'Demorou demais. Tente com menos questões.' : 'Não consegui gerar as questões. Tente de novo.' });
  } finally { clearTimeout(to); }
};
