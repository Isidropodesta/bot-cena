import { crearDb } from './db.mjs';
import { crearEgrefest } from './egrefest.mjs';
import { crearEnviar } from './telegram.mjs';
import { corrida } from './corrida.mjs';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

Deno.serve((req) => {
  const secreto = Deno.env.get('CRON_SECRET');
  if (!secreto || req.headers.get('x-cron-secret') !== secreto) return new Response('no', { status: 401 });

  const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const tarea = corrida({
    db: crearDb({ url: Deno.env.get('SUPABASE_URL')!, key: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')! }),
    egrefest: crearEgrefest({ esperar }),
    enviar: crearEnviar({ token: Deno.env.get('TELEGRAM_TOKEN')! }),
  }).catch((e: Error) => console.log(JSON.stringify({ corrida: { error: e.message } })));
  EdgeRuntime.waitUntil(tarea);
  return new Response('ok', { status: 202 });
});
