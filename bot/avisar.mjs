import { readFile } from 'node:fs/promises';
import { todasLasSuscripciones, enviosDesde, registrarEnvios, borrarChat } from './lib/db.mjs';
import { telegram, botonComprar } from './lib/telegram.mjs';
import { planificar, despachar, VENTANA_ENVIOS_MS } from './lib/avisos.mjs';

async function main() {
  for (const v of ['TELEGRAM_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']) {
    if (!process.env[v]) {
      console.log(`::warning::Avisos omitidos: falta ${v}`);
      return;
    }
  }
  const ahora = new Date().toISOString();
  const eventos = JSON.parse(await readFile(`${process.env.DATA_DIR ?? 'data'}/historial.json`, 'utf8'));
  const [subs, envios] = await Promise.all([todasLasSuscripciones(), enviosDesde(new Date(Date.parse(ahora) - VENTANA_ENVIOS_MS).toISOString())]);
  const mensajes = planificar({ eventos, subs, envios, ahora });
  const r = await despachar({
    mensajes,
    enviar: (m) => telegram('sendMessage', {
      chat_id: m.chatId,
      text: m.texto,
      link_preview_options: { is_disabled: true },
      ...(m.conBoton ? { reply_markup: botonComprar(m.link) } : {}),
    }),
    registrar: registrarEnvios,
    borrarChat,
  });
  console.log(`Avisos: ${r.enviados} enviados · ${r.fallidos} fallidos · ${r.bloqueados} chats bloqueados`);
  if (r.fallidos) console.log(`::warning::${r.fallidos} avisos quedaron pendientes para la próxima corrida`);
}

main().catch((e) => {
  console.log(`::warning::Avisos no enviados, quedan pendientes: ${e.message}`);
});
