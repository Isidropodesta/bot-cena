import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API = 'https://egrefest.com.ar/api';
const SITIO = 'https://www.egrefest.com.ar';
const PRECIO_MINIMO_REAL = Number(process.env.PRECIO_MINIMO_REAL ?? 10);
const UMBRAL_POCAS = Number(process.env.UMBRAL_POCAS ?? 20);
const MAX_EVENTOS = 3000;
const PAUSA_MS = 1000;
const TIMEOUT_MS = 20000;
// La API no trae el lugar: el front del sitio lo muestra fijo ("📍 Terraoliva") en todas las cenas.
const LUGAR = 'Terraoliva';

const ORDEN_ESTADOS = ['EN_VENTA', 'POCAS', 'NO_SE_PUEDE_COMPRAR', 'AGOTADA', 'NO_HABILITADA', 'SIN_DATO'];

const numero = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const linkCena = (id) => `${SITIO}/buy-ticket/${id}`;

function calcularEstado(t, cenaHabilitada) {
  const habilitada = cenaHabilitada && t.estadoOrigen === 'active';
  const disp = t.cantidadDisponible;
  if (habilitada && disp > 0 && t.precio !== null && t.precio <= PRECIO_MINIMO_REAL) return 'NO_SE_PUEDE_COMPRAR';
  if (disp === 0 || /agot|sold/i.test(t.estadoOrigen ?? '')) return 'AGOTADA';
  if (t.estadoOrigen === null) return 'SIN_DATO';
  if (!habilitada) return 'NO_HABILITADA';
  if (disp === null || t.precio === null) return 'SIN_DATO';
  if (disp <= UMBRAL_POCAS) return 'POCAS';
  return 'EN_VENTA';
}

export function normalizarCena(ev, ahora) {
  const finalizada = ev.date_end ? new Date(ev.date_end) < new Date(ahora) : false;
  const cenaHabilitada = ev.status === 'active' && !finalizada;
  const tipos = ev.sales
    .map((s) => {
      const t = {
        id: s.id,
        cenaId: ev.id,
        tipo: s.name ?? null,
        cantidadDisponible: numero(s.current_stock),
        cantidadTotal: numero(s.stock),
        precio: numero(s.price),
        estadoOrigen: s.status ?? null,
      };
      t.estado = calcularEstado(t, cenaHabilitada);
      return t;
    })
    .sort((a, b) => a.id - b.id);
  const estado = tipos.length
    ? ORDEN_ESTADOS[Math.min(...tipos.map((t) => ORDEN_ESTADOS.indexOf(t.estado)))]
    : 'NO_HABILITADA';
  return {
    id: ev.id,
    nombre: ev.name,
    fechaInicio: ev.date_start ?? null,
    fechaFin: ev.date_end ?? null,
    lugar: LUGAR,
    descripcion: ev.description || null,
    link: linkCena(ev.id),
    estadoOrigen: ev.status ?? null,
    estado,
    tipos,
    ultimaLectura: ahora,
  };
}

const esSimbolico = (precio) => precio !== null && precio <= PRECIO_MINIMO_REAL;

export function comparar(previas, actuales, ahora) {
  const eventos = [];
  const base = (cena, t) => ({
    fecha: ahora,
    cenaId: cena.id,
    cenaNombre: cena.nombre,
    tipoEntradaId: t?.id ?? null,
    tipoEntrada: t?.tipo ?? null,
    link: cena.link,
  });
  const push = (cena, t, evento, antes, despues) => {
    eventos.push({
      id: `${ahora}|${cena.id}|${t?.id ?? '-'}|${evento}`,
      evento,
      ...base(cena, t),
      antes,
      despues,
      precio: t?.precio ?? null,
      estado: t?.estado ?? cena.estado,
    });
  };

  const prevPorId = new Map(previas.map((c) => [c.id, c]));
  const actPorId = new Map(actuales.map((c) => [c.id, c]));

  for (const cena of actuales) {
    const prev = prevPorId.get(cena.id);
    if (!prev) {
      push(cena, null, 'NUEVA_CENA', null, cena.estado);
      continue;
    }
    const prevTipos = new Map(prev.tipos.map((t) => [t.id, t]));
    for (const t of cena.tipos) {
      const p = prevTipos.get(t.id);
      if (!p) {
        push(cena, t, 'NUEVO_TIPO_ENTRADA', null, t.cantidadDisponible);
        continue;
      }
      const buenos = ['EN_VENTA', 'POCAS'];
      if (p.estado === 'NO_HABILITADA' && buenos.includes(t.estado)) {
        push(cena, t, 'APERTURA_VENTA', p.estado, t.estado);
      }
      const a = p.cantidadDisponible;
      const n = t.cantidadDisponible;
      if (a !== null && n !== null) {
        if (n === 0 && a > 0) push(cena, t, 'AGOTADA', a, n);
        else if (n < a && n > 0) push(cena, t, 'BAJA_STOCK', a, n);
        else if (a === 0 && n > 0) push(cena, t, 'REPOSICION', a, n);
      }
      if (p.precio !== null && t.precio !== null && p.precio !== t.precio) {
        if (!esSimbolico(p.precio) && esSimbolico(t.precio)) push(cena, t, 'PRECIO_SIMBOLICO_ACTIVADO', p.precio, t.precio);
        else if (esSimbolico(p.precio) && !esSimbolico(t.precio)) push(cena, t, 'PRECIO_SIMBOLICO_RESUELTO', p.precio, t.precio);
        else push(cena, t, 'PRECIO_CAMBIO', p.precio, t.precio);
      }
    }
  }
  for (const prev of previas) {
    if (!actPorId.has(prev.id)) push(prev, null, 'CENA_ELIMINADA', prev.estado, null);
  }
  return eventos;
}

async function getJson(url, fetchFn) {
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'egrefest-panel (lectura de stock publico)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function listarIds(fetchFn, esperar) {
  const ids = [];
  let pagina = 1;
  let total = null;
  let paginas = 1;
  do {
    if (pagina > 1) await esperar();
    const j = await getJson(`${API}/events?page=${pagina}&per_page=100`, fetchFn);
    if (!Array.isArray(j.events)) throw new Error('El listado no trae "events"');
    total = j.total;
    paginas = j.page_total ?? 1;
    ids.push(...j.events.map((e) => e.id));
    pagina++;
  } while (pagina <= paginas);
  if (typeof total === 'number' && total !== ids.length) {
    throw new Error(`Listado incompleto: total=${total}, leidas=${ids.length}`);
  }
  return [...new Set(ids)];
}

async function leerCena(id, fetchFn) {
  const j = await getJson(`${API}/events/${id}`, fetchFn);
  const ev = j?.event;
  if (!ev || ev.id !== id || !Array.isArray(ev.sales)) throw new Error(`Detalle invalido de la cena ${id}`);
  return ev;
}

export async function revisar({ fetchFn = fetch, previo, ahora = new Date().toISOString(), esperar = () => new Promise((r) => setTimeout(r, PAUSA_MS)), log = console.error }) {
  const ids = await listarIds(fetchFn, esperar);
  if (ids.length === 0 && previo?.cenas.length) throw new Error('El listado vino vacio pero habia cenas en la corrida anterior');

  const previasPorId = new Map((previo?.cenas ?? []).map((c) => [c.id, c]));
  const cenas = [];
  for (const id of ids) {
    await esperar();
    const previa = previasPorId.get(id);
    try {
      const ev = await leerCena(id, fetchFn);
      // Si antes tenia tipos y ahora llegan 0, se lo trata como lectura vacia, no como baja real.
      if (ev.sales.length === 0 && previa?.tipos.length) throw new Error(`Cena ${id} sin tipos de entrada`);
      cenas.push(normalizarCena(ev, ahora));
    } catch (e) {
      log(`Cena ${id}: ${e.message}`);
      if (previa) cenas.push(previa);
    }
  }

  const eventos = previo ? comparar(previo.cenas, cenas, ahora) : [];
  const historial = [...eventos, ...(previo?.historial ?? [])].slice(0, MAX_EVENTOS);
  return {
    cenas: { ultimaRevision: ahora, desde: previo?.desde ?? ahora, cenas },
    historial,
    eventosNuevos: eventos,
  };
}

async function leerOpcional(ruta) {
  try {
    return JSON.parse(await readFile(ruta, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function escribirAtomico(ruta, obj) {
  await writeFile(`${ruta}.tmp`, JSON.stringify(obj, null, 1));
  await rename(`${ruta}.tmp`, ruta);
}

async function main() {
  const dir = process.env.DATA_DIR ?? 'data';
  const rCenas = await leerOpcional(`${dir}/cenas.json`);
  const rHistorial = await leerOpcional(`${dir}/historial.json`);
  if (!!rCenas !== !!rHistorial) throw new Error('Estado anterior incompleto: falta cenas.json o historial.json');
  const previo = rCenas ? { cenas: rCenas.cenas, desde: rCenas.desde, historial: rHistorial } : null;

  const r = await revisar({ previo });
  await mkdir(dir, { recursive: true });
  await escribirAtomico(`${dir}/historial.json`, r.historial);
  await escribirAtomico(`${dir}/cenas.json`, r.cenas);
  console.log(`Cenas: ${r.cenas.cenas.length} · eventos nuevos: ${r.eventosNuevos.length}`);
  for (const e of r.eventosNuevos) console.log(`  ${e.evento} · ${e.cenaNombre}${e.tipoEntrada ? ' · ' + e.tipoEntrada : ''} · ${e.antes} -> ${e.despues}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
