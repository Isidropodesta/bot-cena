import { timingSafeEqual } from 'node:crypto';
import { suscribir, desuscribir, suscripcionesDe, todasLasCenas } from '../lib/db.mjs';
import { telegram, botonComprar } from '../lib/telegram.mjs';

const panel = () => process.env.PANEL_URL;

const pesos = (n) => '$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const iguales = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const ESTADOS = { EN_VENTA: 'En venta', AGOTADA: 'Agotada', PROXIMAMENTE: 'Próximamente' };

function estadoActual(c) {
  const v = c.vista;
  const cabecera = `Estado: ${ESTADOS[v.estado]}${v.pocas ? ' · Quedan pocas' : ''}`;
  if (!c.tipos.length) return `${cabecera}\nTodavía no tiene entradas cargadas.`;
  const lineas = c.tipos.map((t) => {
    const nombre = t.tipo ?? 'Entrada';
    const de = t.cantidadTotal != null ? ` de ${t.cantidadTotal}` : '';
    const precio = t.precio != null ? ` a ${pesos(t.precio)}` : '';
    switch (t.fase) {
      case 'EN_VENTA': return `• ${nombre}: ${t.cantidadDisponible} ${t.cantidadDisponible === 1 ? 'disponible' : 'disponibles'}${de}${precio}`;
      case 'AGOTADA': return `• ${nombre}: agotada`;
      case 'PROXIMA': return `• ${nombre}: ${t.cantidadTotal} ${t.cantidadTotal === 1 ? 'entrada cargada' : 'entradas cargadas'}${precio}, todavía sin habilitar`;
      default: return `• ${nombre}: cargada, todavía sin cantidad de entradas`;
    }
  });
  return [cabecera, ...lineas].join('\n');
}

const enviar = (chatId, text, extra = {}) => telegram('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...extra });

const saludo = (chatId) => enviar(chatId, `¡Hola! Te aviso cuando hay entradas, se agotan, reponen o cambian de precio en las cenas de egresados.\n\nElegí tus cenas tocando la campanita 🔔 en el panel: ${panel()}\n\nCon /avisos ves y quitás las que seguís.`);

const noExiste = (chatId) => enviar(chatId, `No encuentro esa cena, capaz ya no está publicada. Elegí otra desde el panel: ${panel()}`);

async function empezar(chatId, payload = '') {
  const alta = payload.match(/^c(\d{1,12})$/);
  const baja = payload.match(/^x(\d{1,12}|todas)$/);
  if (payload === 'todas') {
    await suscribir(chatId, 'todas');
    return enviar(chatId, 'Listo ✅ Te aviso de todas las cenas, incluidas las nuevas. Para dejar de recibir avisos usá /avisos.');
  }
  if (alta) {
    const id = String(Number(alta[1]));
    const c = (await todasLasCenas()).get(id);
    if (!c) return noExiste(chatId);
    await suscribir(chatId, id);
    return enviar(chatId, `Listo ✅ Te aviso cualquier cambio en ${c.nombre}\n\n${estadoActual(c)}`, { reply_markup: botonComprar(c.link) });
  }
  if (baja) {
    const id = baja[1] === 'todas' ? 'todas' : String(Number(baja[1]));
    await desuscribir(chatId, id);
    const nombre = id === 'todas' ? 'las cenas en general' : (await todasLasCenas().catch(() => new Map())).get(id)?.nombre ?? 'esa cena';
    return enviar(chatId, `Listo, ya no te aviso de ${nombre}.`);
  }
  return saludo(chatId);
}

async function avisos(chatId) {
  const mias = await suscripcionesDe(chatId);
  if (!mias.length) return enviar(chatId, `No tenés avisos activos. Tocá la campanita 🔔 de una cena en el panel: ${panel()}`);
  const porId = await todasLasCenas().catch(() => new Map());
  for (const s of mias) {
    const cena = porId.get(s.cena_id);
    const nombre = s.cena_id === 'todas' ? 'Todas las cenas (incluye las nuevas)' : cena ? `${cena.nombre}\n${ESTADOS[cena.vista.estado]}` : `Cena ${s.cena_id}`;
    await enviar(chatId, nombre, { reply_markup: { inline_keyboard: [[{ text: 'Dejar de avisar', callback_data: `x${s.cena_id}` }]] } });
  }
}

async function boton(cb) {
  const m = (cb.data ?? '').match(/^x(\d{1,12}|todas)$/);
  const chatId = cb.message?.chat?.id;
  if (!m || !chatId) return telegram('answerCallbackQuery', { callback_query_id: cb.id });
  await desuscribir(chatId, m[1]);
  await telegram('answerCallbackQuery', { callback_query_id: cb.id, text: 'Listo, ya no te aviso' });
  await telegram('editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text: `Listo, ya no te aviso de: ${cb.message.text.split('\n')[0]}`});
}

export async function procesar(update) {
  if (update.callback_query) return boton(update.callback_query);
  const msg = update.message;
  if (!msg || msg.chat?.type !== 'private') return;
  const chatId = msg.chat.id;
  const texto = (msg.text ?? '').trim();
  try {
    const start = texto.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/);
    if (start) return await empezar(chatId, start[1]);
    if (/^\/avisos(?:@\w+)?$/.test(texto)) return await avisos(chatId);
    return await saludo(chatId);
  } catch (e) {
    await enviar(chatId, 'Se me complicó algo de mi lado. Probá de nuevo en un rato.').catch(() => {});
    throw e;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const esperado = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!esperado || !iguales(req.headers['x-telegram-bot-api-secret-token'], esperado)) return res.status(401).end();
  try {
    await procesar(req.body ?? {});
  } catch (e) {
    console.error(e.message);
  }
  res.status(200).end();
}
