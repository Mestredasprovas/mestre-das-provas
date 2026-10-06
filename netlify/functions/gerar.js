const crypto = require('crypto');
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIMITE = +process.env.LIMITE_QUESTOES_POR_HORA || 100; // questões por visitante por hora
const MODELO = process.env.MODELO || 'gemini-3.1-flash-lite';
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

  // Limite por QUESTÕES na última hora (soma da coluna n), não por número de chamadas.
  let idUso = null;
  try {
    const desde = new Date(Date.now() - 3600e3).toISOString();
    const r = await fetch(
      `${SB}/rest/v1/uso?select=n,criado_em&ip_hash=eq.${hash}&criado_em=gte.${desde}&order=criado_em.asc&limit=1000`,
      { headers: H });
    const linhas = r.ok ? await r.json() : null;
    if (!Array.isArray(linhas)) throw new Error('uso');
    const usado = linhas.reduce((s, x) => s + (+x.n || 0), 0);
    if (usado + n > LIMITE) {
      // calcula quando as questões mais antigas saem da janela de 1 hora e liberam espaço
      let livre = usado, espera = 0;
      for (const x of linhas) {
        if (livre + n <= LIMITE) break;
        livre -= (+x.n || 0);
        espera = new Date(x.criado_em).getTime() + 3600e3 - Date.now();
      }
      const min = Math.max(1, Math.ceil(espera / 60000));
      return out(429, { erro: `Limite de uso por hora atingido (${usado} de ${LIMITE} questões). Libera mais questões em cerca de ${min} min.` });
    }
    const ins = await fetch(`${SB}/rest/v1/uso`, {
      method: 'POST', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ ip_hash: hash, n })
    });
    const reg = await ins.json().catch(() => null);
    idUso = Array.isArray(reg) && reg[0] && reg[0].id ? reg[0].id : null;
  } catch (e) { return out(500, { erro: 'Falha ao acessar o banco de dados.' }); }

  // Se a geração falhar, devolve as questões ao contador do visitante.
  const devolver = async () => {
    if (!idUso) return;
    try { await fetch(`${SB}/rest/v1/uso?id=eq.${idUso}`, { method: 'DELETE', headers: H }); } catch {}
  };

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`, {
      method: 'POST', signal: ac.signal,
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: mk(texto, n, nivel) }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8000, temperature: 0.7 }
      })
    });
    const j = await r.json();
    if (r.status === 429) { await devolver(); return out(429, { erro: 'O gerador gratuito atingiu o limite agora. Tente de novo em alguns minutos.' }); }
    if (!r.ok) { await devolver(); return out(502, { erro: 'Erro no gerador: ' + ((j.error && j.error.message) || r.status) }); }
    const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    const txt = parts.map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    const p = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    return out(200, { questoes: p.questoes || [] });
  } catch (e) {
    await devolver();
    return out(504, { erro: e.name === 'AbortError' ? 'Demorou demais. Tente com menos questões.' : 'Não consegui gerar as questões. Tente de novo.' });
  } finally { clearTimeout(to); }
};
