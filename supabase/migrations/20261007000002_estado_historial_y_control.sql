create table public.cenas (
  id bigint primary key,
  datos jsonb not null
);

create table public.historial (
  id text primary key,
  fecha timestamptz not null,
  cena_id bigint not null,
  datos jsonb not null
);
create index historial_fecha on public.historial (fecha desc);

create table public.revision (
  id int primary key default 1 check (id = 1),
  ultima_revision timestamptz not null,
  desde timestamptz not null
);

create table public.control (
  id int primary key default 1 check (id = 1),
  lock_hasta timestamptz,
  ultima_completa timestamptz,
  pausa_hasta timestamptz
);
insert into public.control (id) values (1);

alter table public.cenas enable row level security;
alter table public.historial enable row level security;
alter table public.revision enable row level security;
alter table public.control enable row level security;

create policy lectura_publica on public.cenas for select to anon using (true);
create policy lectura_publica on public.historial for select to anon using (true);
create policy lectura_publica on public.revision for select to anon using (true);

revoke all on public.suscripciones, public.envios, public.control from anon, authenticated;
revoke all on public.cenas, public.historial, public.revision from anon, authenticated;
grant select on public.cenas, public.historial, public.revision to anon;

create function public.iniciar_corrida(p_segundos int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  fila control%rowtype;
begin
  update control
     set lock_hasta = now() + make_interval(secs => p_segundos)
   where id = 1
     and (lock_hasta is null or lock_hasta < now())
     and (pausa_hasta is null or pausa_hasta < now())
  returning * into fila;
  if not found then
    select * into fila from control where id = 1;
    return jsonb_build_object('ok', false, 'motivo', case when fila.pausa_hasta > now() then 'pausa' else 'lock' end);
  end if;
  return jsonb_build_object('ok', true, 'ultima_completa', fila.ultima_completa);
end;
$$;

create function public.liberar_corrida(p_pausa_segundos int default null)
returns void
language sql
security definer
set search_path = public
as $$
  update control
     set lock_hasta = null,
         pausa_hasta = case when p_pausa_segundos is null then pausa_hasta else now() + make_interval(secs => p_pausa_segundos) end
   where id = 1;
$$;

create function public.guardar_revision(p_cenas jsonb, p_borrar bigint[], p_eventos jsonb, p_ahora timestamptz, p_completa boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into cenas (id, datos)
  select (c->>'id')::bigint, c from jsonb_array_elements(p_cenas) c
  on conflict (id) do update set datos = excluded.datos;

  delete from cenas where id = any(p_borrar);

  insert into historial (id, fecha, cena_id, datos)
  select e->>'id', (e->>'fecha')::timestamptz, (e->>'cenaId')::bigint, e from jsonb_array_elements(p_eventos) e
  on conflict (id) do nothing;

  delete from historial where id in (select id from historial order by fecha desc, id offset 3000);

  update revision set ultima_revision = p_ahora where id = 1;
  if p_completa then
    update control set ultima_completa = p_ahora where id = 1;
  end if;
end;
$$;

revoke execute on function public.iniciar_corrida(int), public.liberar_corrida(int), public.guardar_revision(jsonb, bigint[], jsonb, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.iniciar_corrida(int), public.liberar_corrida(int), public.guardar_revision(jsonb, bigint[], jsonb, timestamptz, boolean) to service_role;
