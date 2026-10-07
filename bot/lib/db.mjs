const cabeceras = (extra = {}) => ({
  apikey: process.env.SUPABASE_SERVICE_KEY,
  authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
  'content-type': 'application/json',
  ...extra,
});

async function rest(ruta, { metodo = 'GET', cuerpo, extra, fetchFn = fetch } = {}) {
  const res = await fetchFn(`${process.env.SUPABASE_URL}/rest/v1/${ruta}`, {
    method: metodo,
    headers: cabeceras(extra),
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(15000),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`Supabase ${metodo} ${ruta.split('?')[0]} -> HTTP ${res.status} ${texto}`);
  return texto ? JSON.parse(texto) : null;
}

export const suscribir = (chatId, cenaId) =>
  rest('suscripciones?on_conflict=chat_id,cena_id', {
    metodo: 'POST',
    cuerpo: { chat_id: chatId, cena_id: cenaId },
    extra: { prefer: 'resolution=ignore-duplicates,return=minimal' },
  });

export const desuscribir = (chatId, cenaId) =>
  rest(`suscripciones?chat_id=eq.${chatId}&cena_id=eq.${encodeURIComponent(cenaId)}`, { metodo: 'DELETE', extra: { prefer: 'return=minimal' } });

export const suscripcionesDe = (chatId) => rest(`suscripciones?chat_id=eq.${chatId}&select=cena_id,creada_en&order=creada_en`);

export const todasLasCenas = async () => new Map((await rest('cenas?select=datos')).map((f) => [String(f.datos.id), f.datos]));
