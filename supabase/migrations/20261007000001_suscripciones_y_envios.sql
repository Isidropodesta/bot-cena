create table public.suscripciones (
  chat_id bigint not null,
  cena_id text not null,
  creada_en timestamptz not null default now(),
  primary key (chat_id, cena_id)
);

create table public.envios (
  evento_id text not null,
  chat_id bigint not null,
  cena_id text not null,
  tipo_evento text not null,
  enviado_en timestamptz not null default now(),
  primary key (evento_id, chat_id)
);

create index envios_chat_cena_tipo on public.envios (chat_id, cena_id, tipo_evento, enviado_en desc);

alter table public.suscripciones enable row level security;
alter table public.envios enable row level security;
