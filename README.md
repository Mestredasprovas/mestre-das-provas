# Mestre das provas — Netlify + Supabase

Site público, sem login. O front fica em `public/`, a geração roda na função `netlify/functions/gerar.js`
(chave da Anthropic guardada só no servidor) e o Supabase controla o limite de uso por visitante.

## Passo a passo
1. **Supabase**: crie um projeto, abra *SQL Editor*, cole e rode `supabase/schema.sql`.
   Em *Project Settings > API* copie a **Project URL** e a chave **service_role** (secreta).
2. **Anthropic**: crie uma chave de API em console.anthropic.com (o custo das gerações sai dessa conta).
3. **Netlify**: suba esta pasta (GitHub + *Add new site > Import*, ou arraste a pasta em app.netlify.com/drop).
   Em *Site configuration > Environment variables* crie:
   - `ANTHROPIC_API_KEY` — chave da Anthropic
   - `SUPABASE_URL` — Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — chave service_role
   - `SALT` — qualquer texto aleatório (embaralha o IP guardado)
   - opcionais: `LIMITE_POR_HORA` (padrão 20 chamadas/visitante/hora) e `MODELO` (padrão claude-haiku-4-5-20251001)
4. Faça um novo deploy. Pronto: o site já funciona no endereço `.netlify.app`; depois é só ligar o domínio próprio.

## Observações
- Cada chamada gera até 4 questões, e as chamadas rodam em paralelo, para caber no tempo da função
  (10 s no plano gratuito do Netlify, 26 s se você aumentar em *Functions*). Se estourar tempo, use `MODELO` mais rápido ou troque 4 por 3 em `public/index.html`.
- Nunca coloque a `service_role` nem a chave da Anthropic no front.
- Teste local: `npm i -g netlify-cli && netlify dev` (com as variáveis em um arquivo `.env`).
