const HORA = 3600000;
export const VENTANA_EVENTOS_MS = 6 * HORA;
export const VENTANA_ENVIOS_MS = 12 * HORA;
const PAUSA_ENTRE_ENVIOS_MS = 45;

const EVENTOS_AVISABLES = new Set([
  'APERTURA_VENTA', 'REPOSICION', 'AGOTADA', 'BAJA_STOCK', 'PRECIO_CAMBIO',
  'PRECIO_SIMBOLICO_ACTIVADO', 'PRECIO_SIMBOLICO_RESUELTO', 'NUEVO_TIPO_ENTRADA', 'CENA_ELIMINADA', 'NUEVA_CENA',
]);

export const pesos = (n) => '$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const donde = (e, conCena) => [conCena ? e.cenaNombre : null, e.tipoEntrada].filter(Boolean).join(' · ');

function linea(e, conCena) {
  const d = donde(e, conCena);
  const dos = d ? `${d}: ` : '';
  switch (e.evento) {
    case 'NUEVA_CENA': return `🆕 Nueva cena: ${e.cenaNombre}`;
    case 'CENA_ELIMINADA': return `🗑️ Sacaron la cena ${e.cenaNombre}`;
    case 'APERTURA_VENTA': return `🟢 Abrió la venta: ${d}${e.precio != null ? ` a ${pesos(e.precio)}` : ''}`;
    case 'REPOSICION':
      if (e.estado === 'NO_SE_PUEDE_COMPRAR') return `🟣 Cargaron entradas pero a ${pesos(e.precio)}: todavía no se pueden comprar${d ? ` (${d})` : ''}`;
      return `🟢 Repusieron entradas: ${dos}${e.despues} disponibles${e.precio != null ? ` a ${pesos(e.precio)}` : ''}`;
    case 'AGOTADA': return `🔴 Se agotó ${d}`;
    case 'PRECIO_CAMBIO': return `💲 Cambió el precio: ${dos}${pesos(e.antes)} → ${pesos(e.despues)}`;
    case 'PRECIO_SIMBOLICO_ACTIVADO': return `🟣 Precio simbólico: ${dos}${pesos(e.antes)} → ${pesos(e.despues)}. Todavía no se puede comprar`;
    case 'PRECIO_SIMBOLICO_RESUELTO': return `✅ Ya se pueden comprar: el precio pasó a ${pesos(e.despues)}${d ? ` (${d})` : ''}`;
    case 'NUEVO_TIPO_ENTRADA': return `🆕 Nuevo tipo de entrada: ${dos}${e.despues ?? 's/d'} disponibles${e.precio != null ? ` a ${pesos(e.precio)}` : ''}`;
    default: return e.evento;
  }
}

function lineasBajas(bajas, conCena) {
  const porTipo = new Map();
  for (const e of bajas) {
    if (!porTipo.has(e.tipoEntradaId)) porTipo.set(e.tipoEntradaId, []);
    porTipo.get(e.tipoEntradaId).push(e);
  }
  return [...porTipo.values()].map((es) => {
    const primero = es[0];
    const ultimo = es[es.length - 1];
    return `📉 ${donde(ultimo, conCena)}: quedan ${ultimo.despues} · bajó ${primero.antes - ultimo.despues} en la última hora`;
  });
}

function armarTexto(otros, bajas) {
  const cena = (otros[0] ?? bajas[0]).cenaNombre;
  const lineasBaja = lineasBajas(bajas, otros.length === 0);
  if (otros.length === 1 && !bajas.length) return linea(otros[0], true);
  if (!otros.length && lineasBaja.length === 1) return lineasBaja[0];
  return [`Novedades en ${cena}:`, ...otros.map((e) => `• ${linea(e, false)}`), ...lineasBajas(bajas, false).map((l) => `• ${l}`)].join('\n');
}

export function planificar({ eventos, subs, envios, ahora }) {
  const ahoraMs = Date.parse(ahora);
  const yaEnviado = new Set(envios.map((x) => `${x.chat_id}|${x.evento_id}`));
  const ultimaBaja = new Map();
  for (const x of envios) {
    if (x.tipo_evento !== 'BAJA_STOCK') continue;
    const k = `${x.chat_id}|${x.cena_id}`;
    ultimaBaja.set(k, Math.max(ultimaBaja.get(k) ?? 0, Date.parse(x.enviado_en)));
  }

  const porChat = new Map();
  for (const s of subs) {
    if (!porChat.has(s.chat_id)) porChat.set(s.chat_id, new Map());
    porChat.get(s.chat_id).set(s.cena_id, Date.parse(s.creada_en));
  }

  const candidatos = eventos
    .filter((e) => Date.parse(e.fecha) >= ahoraMs - VENTANA_EVENTOS_MS && EVENTOS_AVISABLES.has(e.evento))
    .sort((a, b) => Date.parse(a.fecha) - Date.parse(b.fecha));

  const mensajes = [];
  for (const [chatId, mis] of porChat) {
    const grupos = new Map();
    for (const e of candidatos) {
      const desde = e.evento === 'NUEVA_CENA'
        ? (mis.get('todas') ?? Infinity)
        : Math.min(mis.get('todas') ?? Infinity, mis.get(String(e.cenaId)) ?? Infinity);
      if (desde === Infinity || !(Date.parse(e.fecha) > desde)) continue;
      if (yaEnviado.has(`${chatId}|${e.id}`)) continue;
      if (!grupos.has(e.cenaId)) grupos.set(e.cenaId, []);
      grupos.get(e.cenaId).push(e);
    }
    for (const [cenaId, evs] of grupos) {
      const bajas = evs.filter((e) => e.evento === 'BAJA_STOCK');
      const otros = evs.filter((e) => e.evento !== 'BAJA_STOCK');
      const retenidas = bajas.length > 0 && ahoraMs - (ultimaBaja.get(`${chatId}|${cenaId}`) ?? 0) < HORA;
      const bajasAhora = retenidas ? [] : bajas;
      const incluidos = [...otros, ...bajasAhora];
      if (!incluidos.length) continue;
      mensajes.push({
        chatId,
        cenaId,
        texto: armarTexto(otros, bajasAhora),
        link: incluidos[0].link,
        conBoton: incluidos.some((e) => e.evento !== 'CENA_ELIMINADA'),
        eventos: incluidos.map((e) => ({ evento_id: e.id, chat_id: chatId, cena_id: String(e.cenaId), tipo_evento: e.evento })),
      });
    }
  }
  return mensajes;
}

export async function despachar({ mensajes, enviar, registrar, borrarChat, dormir = (ms) => new Promise((r) => setTimeout(r, ms)), pausaMs = PAUSA_ENTRE_ENVIOS_MS, log = console.error }) {
  const bloqueados = new Set();
  const r = { enviados: 0, fallidos: 0, bloqueados: 0 };
  for (const m of mensajes) {
    if (bloqueados.has(m.chatId)) continue;
    try {
      for (let intento = 1; ; intento++) {
        try {
          await enviar(m);
          break;
        } catch (e) {
          if (e.status === 429 && e.retryAfter && e.retryAfter <= 30 && intento < 3) await dormir(e.retryAfter * 1000);
          else throw e;
        }
      }
    } catch (e) {
      if (e.status === 403) {
        bloqueados.add(m.chatId);
        r.bloqueados++;
        try { await borrarChat(m.chatId); } catch (err) { log(`No se pudieron borrar las suscripciones de ${m.chatId}: ${err.message}`); }
      } else {
        r.fallidos++;
        log(`Falló el envío a ${m.chatId} (cena ${m.cenaId}): ${e.message}`);
      }
      await dormir(pausaMs);
      continue;
    }
    r.enviados++;
    try { await registrar(m.eventos); } catch (e) { log(`Enviado a ${m.chatId} pero no se pudo registrar (puede repetirse): ${e.message}`); }
    await dormir(pausaMs);
  }
  return r;
}
