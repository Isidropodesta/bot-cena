const env = (k) => globalThis.Deno?.env.get(k) ?? globalThis.process?.env?.[k];

const SITIO = 'https://www.egrefest.com.ar';
const PRECIO_MINIMO_REAL = Number(env('PRECIO_MINIMO_REAL') ?? 10);
const UMBRAL_POCAS = Number(env('UMBRAL_POCAS') ?? 20);
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

const esSimbolico = (precio) => precio !== null && precio <= PRECIO_MINIMO_REAL;

// Lo que ve la persona: En venta / Agotada / Próximamente. "Quedan pocas" es solo una etiqueta dentro de En venta.
// Los estados internos de cada tanda (y los eventos) no cambian.
function calcularVista(tipos, cenaHabilitada) {
  const enVenta = (t) => t.estado === 'EN_VENTA' || t.estado === 'POCAS';
  const agotada = (t) => cenaHabilitada && (t.estadoOrigen === 'active' ? t.cantidadDisponible === 0 : /agot|sold/i.test(t.estadoOrigen ?? ''));
  const vendibles = tipos.filter(enVenta);
  const agotadas = tipos.filter((t) => !enVenta(t) && agotada(t));
  const cargada = tipos.find((t) => !enVenta(t) && !agotada(t) && t.estado === 'NO_HABILITADA' && t.cantidadDisponible > 0);
  const suma = (lista, campo) => (lista.some((t) => t[campo] !== null) ? lista.reduce((n, t) => n + (t[campo] ?? 0), 0) : null);
  const estado = vendibles.length ? 'EN_VENTA' : agotadas.length ? 'AGOTADA' : 'PROXIMAMENTE';
  const disponibles = suma(vendibles, 'cantidadDisponible');
  return {
    estado,
    pocas: estado === 'EN_VENTA' && disponibles !== null && disponibles <= UMBRAL_POCAS,
    disponibles,
    total: suma(vendibles, 'cantidadTotal'),
    tandaId: (vendibles[0] ?? agotadas[agotadas.length - 1])?.id ?? null,
    proxima: cargada ? { id: cargada.id, tipo: cargada.tipo, cantidad: cargada.cantidadTotal ?? cargada.cantidadDisponible, precio: esSimbolico(cargada.precio) ? null : cargada.precio } : null,
  };
}

// `retenidos` son fases de la lectura anterior que el listado no trae (el listado solo incluye las activas):
// se conservan con su estado recalculado hasta la próxima revisión completa.
export function normalizarCena(ev, ahora, retenidos = []) {
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
    .concat(retenidos.map((t) => ({ ...t, estado: calcularEstado(t, cenaHabilitada) })))
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
    vista: calcularVista(tipos, cenaHabilitada),
    tipos,
    ultimaLectura: ahora,
  };
}

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
