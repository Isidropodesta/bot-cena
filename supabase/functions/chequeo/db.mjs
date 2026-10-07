export function crearDb({ url, key, fetchFn = fetch }) {
  const rest = async (ruta, { metodo = 'GET', cuerpo, extra } = {}) => {
    const res = await fetchFn(`${url}/rest/v1/${ruta}`, {
      method: metodo,
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extra },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(15000),
    });
    const texto = await res.text();
    if (!res.ok) throw new Error(`Supabase ${metodo} ${ruta.split('?')[0]} -> HTTP ${res.status} ${texto}`);
    return texto ? JSON.parse(texto) : null;
  };

  const todas = async (ruta) => {
    const filas = [];
    for (let desde = 0; ; desde += 1000) {
      const lote = await rest(`${ruta}&limit=1000&offset=${desde}`);
      filas.push(...lote);
      if (lote.length < 1000) return filas;
    }
  };

  const rpc = (nombre, args) => rest(`rpc/${nombre}`, { metodo: 'POST', cuerpo: args });
  const sinRespuesta = { prefer: 'return=minimal' };

  return {
    iniciarCorrida: (segundos) => rpc('iniciar_corrida', { p_segundos: segundos }),
    liberarCorrida: (pausaSegundos) => rpc('liberar_corrida', { p_pausa_segundos: pausaSegundos ?? null }),
    leerCenas: async () => (await rest('cenas?select=datos&order=id')).map((f) => f.datos),
    guardarRevision: ({ cenas, borrar, eventos, ahora, completa }) =>
      rpc('guardar_revision', { p_cenas: cenas, p_borrar: borrar, p_eventos: eventos, p_ahora: ahora, p_completa: completa }),
    historialDesde: async (iso) => (await todas(`historial?fecha=gte.${encodeURIComponent(iso)}&select=datos&order=fecha`)).map((f) => f.datos),
    suscripciones: () => todas('suscripciones?select=chat_id,cena_id,creada_en&order=chat_id'),
    envios: (iso) => todas(`envios?enviado_en=gte.${encodeURIComponent(iso)}&select=evento_id,chat_id,cena_id,tipo_evento,enviado_en&order=evento_id`),
    registrarEnvios: (filas) =>
      rest('envios?on_conflict=evento_id,chat_id', { metodo: 'POST', cuerpo: filas, extra: { prefer: 'resolution=ignore-duplicates,return=minimal' } }),
    borrarChat: (chatId) => rest(`suscripciones?chat_id=eq.${chatId}`, { metodo: 'DELETE', extra: sinRespuesta }),
  };
}
