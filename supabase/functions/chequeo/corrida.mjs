import { normalizarCena, comparar } from './estado.mjs';
import { planificar, despachar, VENTANA_ENVIOS_MS, VENTANA_EVENTOS_MS } from './avisos.mjs';
import { ErrorLimite } from './egrefest.mjs';

const LOCK_SEGUNDOS = 100;
const PAUSA_POR_LIMITE_SEGUNDOS = 300;
const REVISION_COMPLETA_CADA_MS = 5 * 60000;
const REFRESCO_LECTURA_MS = 5 * 60000;
const MAX_NUEVAS_POR_CORRIDA = 3;

// jsonb no conserva el orden de las claves, así que se compara con las claves ordenadas.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const sinLectura = (c) => JSON.stringify(canon({ ...c, ultimaLectura: null }));

export async function corrida({ db, egrefest, enviar, ahora = new Date().toISOString(), esperar = (ms) => new Promise((r) => setTimeout(r, ms)), pausaDetalleMs = 300, log = console.log }) {
  const ctl = await db.iniciarCorrida(LOCK_SEGUNDOS);
  if (!ctl.ok) {
    log(JSON.stringify({ corrida: { omitida: ctl.motivo } }));
    return { omitida: ctl.motivo };
  }
  const t0 = Date.now();
  const r = { tipo: 'liviana', pedidos: 0, eventos: 0, mensajes: 0, enviados: 0 };
  let pausa = null;
  try {
    await revisar({ db, egrefest, enviar, ahora, esperar, pausaDetalleMs, log, ctl, r });
  } catch (e) {
    if (e instanceof ErrorLimite) pausa = PAUSA_POR_LIMITE_SEGUNDOS;
    r.error = e.message;
  } finally {
    try {
      await db.liberarCorrida(pausa);
    } catch (e) {
      r.errorLiberar = e.message;
    }
  }
  r.ms = Date.now() - t0;
  log(JSON.stringify({ corrida: r }));
  return r;
}

async function revisar({ db, egrefest, enviar, ahora, esperar, pausaDetalleMs, log, ctl, r }) {
  const previas = await db.leerCenas();
  const { eventos: lista, pedidos } = await egrefest.listar();
  r.pedidos += pedidos;
  if (lista.length === 0 && previas.length) throw new Error('El listado vino vacio pero habia cenas guardadas');

  const ultimaCompleta = ctl.ultima_completa ? Date.parse(ctl.ultima_completa) : 0;
  const sinPrevio = previas.length === 0;
  const completa = sinPrevio || Date.parse(ahora) - ultimaCompleta >= REVISION_COMPLETA_CADA_MS;
  if (completa) r.tipo = 'completa';

  const cambiadas = (nuevas, base) => {
    const prevPorId = new Map(base.map((c) => [c.id, c]));
    return nuevas.filter((c) => {
      const p = prevPorId.get(c.id);
      return !p || sinLectura(p) !== sinLectura(c) || Date.parse(c.ultimaLectura) - Date.parse(p.ultimaLectura) >= REFRESCO_LECTURA_MS;
    });
  };

  let estadoActual = previas;
  if (!sinPrevio) {
    const prevPorId = new Map(previas.map((c) => [c.id, c]));
    const livianas = new Map();
    for (const ev of lista) {
      const prev = prevPorId.get(ev.id);
      if (!prev) continue;
      const activas = new Set(ev.sales.map((s) => s.id));
      livianas.set(ev.id, normalizarCena(ev, ahora, prev.tipos.filter((t) => !activas.has(t.id))));
    }
    // Una cena que aparece en el listado se lee de inmediato (hasta 3 por corrida; el resto, en las siguientes).
    const nuevas = [];
    for (const ev of lista.filter((e) => !prevPorId.has(e.id)).slice(0, MAX_NUEVAS_POR_CORRIDA)) {
      await esperar(pausaDetalleMs);
      try {
        const det = await egrefest.detalle(ev.id);
        r.pedidos++;
        nuevas.push(normalizarCena(det, ahora));
      } catch (e) {
        if (e instanceof ErrorLimite) throw e;
        log(JSON.stringify({ cena: ev.id, error: e.message }));
      }
    }
    const tras = [...previas.map((c) => livianas.get(c.id) ?? c), ...nuevas];
    const eventos = comparar(previas, tras, ahora);
    r.eventos += eventos.length;
    await db.guardarRevision({ cenas: cambiadas(tras, previas), borrar: [], eventos, ahora, completa });
    estadoActual = tras;
    await avisar({ db, enviar, ahora, esperar, log, r });
  }

  if (!completa) return;

  const prevPorId = new Map(estadoActual.map((c) => [c.id, c]));
  const actuales = [];
  for (const ev of lista) {
    await esperar(pausaDetalleMs);
    const previa = prevPorId.get(ev.id);
    try {
      const det = await egrefest.detalle(ev.id);
      r.pedidos++;
      // Si antes tenia tipos y ahora llegan 0, se lo trata como lectura vacia, no como baja real.
      if (det.sales.length === 0 && previa?.tipos.length) throw new Error(`Cena ${ev.id} sin tipos de entrada`);
      actuales.push(normalizarCena(det, ahora));
    } catch (e) {
      if (e instanceof ErrorLimite) throw e;
      log(JSON.stringify({ cena: ev.id, error: e.message }));
      if (previa) actuales.push(previa);
    }
  }
  const eventos = sinPrevio ? [] : comparar(estadoActual, actuales, ahora);
  const vivas = new Set(actuales.map((c) => c.id));
  r.eventos += eventos.length;
  await db.guardarRevision({
    cenas: cambiadas(actuales, estadoActual),
    borrar: estadoActual.filter((c) => !vivas.has(c.id)).map((c) => c.id),
    eventos,
    ahora,
    completa: true,
  });
  if (eventos.length) await avisar({ db, enviar, ahora, esperar, log, r });
}

async function avisar({ db, enviar, ahora, esperar, log, r }) {
  try {
    const ahoraMs = Date.parse(ahora);
    const eventos = await db.historialDesde(new Date(ahoraMs - VENTANA_EVENTOS_MS).toISOString());
    if (!eventos.length) return;
    const subs = await db.suscripciones();
    if (!subs.length) return;
    const envios = await db.envios(new Date(ahoraMs - VENTANA_ENVIOS_MS).toISOString());
    const mensajes = planificar({ eventos, subs, envios, ahora });
    r.mensajes += mensajes.length;
    const res = await despachar({ mensajes, enviar, registrar: db.registrarEnvios, borrarChat: db.borrarChat, dormir: esperar, log: (m) => log(JSON.stringify({ aviso: m })) });
    r.enviados += res.enviados;
    if (res.fallidos) r.fallidos = (r.fallidos ?? 0) + res.fallidos;
  } catch (e) {
    r.errorAvisos = e.message;
  }
}
