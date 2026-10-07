create table public.usuarios (
  chat_id bigint primary key,
  nombre text not null,
  usuario text,
  primera_vez timestamptz not null default now(),
  ultima_vez timestamptz not null default now()
);

alter table public.usuarios enable row level security;
revoke all on public.usuarios from anon, authenticated;
