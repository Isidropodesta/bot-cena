const API = 'https://egrefest.com.ar/api';
const TIMEOUT_MS = 8000;

export class ErrorLimite extends Error {}

async function getJson(url, fetchFn) {
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'egrefest-panel (lectura de stock publico)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429 || res.status === 403) throw new ErrorLimite(`${url} -> HTTP ${res.status}`);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

export function crearEgrefest({ fetchFn = fetch, esperar }) {
  return {
    async listar() {
      const eventos = [];
      let pagina = 1;
      let total = null;
      let paginas = 1;
      do {
        if (pagina > 1) await esperar(300);
        const j = await getJson(`${API}/events?page=${pagina}&per_page=100`, fetchFn);
        if (!Array.isArray(j.events)) throw new Error('El listado no trae "events"');
        total = j.total;
        paginas = j.page_total ?? 1;
        eventos.push(...j.events);
        pagina++;
      } while (pagina <= paginas);
      const unicos = [...new Map(eventos.map((e) => [e.id, e])).values()];
      if (typeof total === 'number' && total !== eventos.length) {
        throw new Error(`Listado incompleto: total=${total}, leidas=${eventos.length}`);
      }
      if (unicos.some((e) => !Array.isArray(e.sales))) throw new Error('El listado trae cenas sin "sales"');
      return { eventos: unicos, pedidos: pagina - 1 };
    },

    async detalle(id) {
      const ev = (await getJson(`${API}/events/${id}`, fetchFn))?.event;
      if (!ev || ev.id !== id || !Array.isArray(ev.sales)) throw new Error(`Detalle invalido de la cena ${id}`);
      return ev;
    },
  };
}
