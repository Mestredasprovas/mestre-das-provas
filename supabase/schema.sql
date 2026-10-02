-- Controle de uso (limite por visitante/hora). Rode no SQL Editor do Supabase.
create table if not exists public.uso (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  n int not null default 0,
  criado_em timestamptz not null default now()
);
create index if not exists uso_ip_hora on public.uso (ip_hash, criado_em desc);
-- RLS ligado e sem políticas: só a função (chave service_role) acessa a tabela.
alter table public.uso enable row level security;
