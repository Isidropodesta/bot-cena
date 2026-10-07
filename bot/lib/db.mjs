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

async function todas(ruta) {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const lote = await rest(`${ruta}&limit=1000&offset=${desde}`);
    filas.push(...lote);
    if (lote.length < 1000) return filas;
  }
}

// primera_vez no viaja en el pedido: el upsert solo actualiza las columnas enviadas, así que queda la de la primera vez.
export const registrarUsuario = (chatId, from) =>
  rest('usuarios?on_conflict=chat_id', {
    metodo: 'POST',
    cuerpo: {
      chat_id: chatId,
      nombre: [from.first_name, from.last_name].filter(Boolean).join(' '),
      usuario: from.username ? `@${from.username}` : null,
      ultima_vez: new Date().toISOString(),
    },
    extra: { prefer: 'resolution=merge-duplicates,return=minimal' },
  });

export const listarUsuarios = () => todas('usuarios?select=chat_id,nombre,usuario,primera_vez&order=primera_vez.desc,chat_id.desc');

export const todasLasSuscripciones = () => todas('suscripciones?select=chat_id,cena_id&order=chat_id');
