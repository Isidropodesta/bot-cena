export class ErrorTelegram extends Error {
  constructor(metodo, status, cuerpo) {
    super(`Telegram ${metodo} -> HTTP ${status} ${cuerpo?.description ?? ''}`);
    this.status = status;
    this.retryAfter = cuerpo?.parameters?.retry_after ?? null;
  }
}

export async function telegram(metodo, datos, fetchFn = fetch) {
  const res = await fetchFn(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/${metodo}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(datos),
    signal: AbortSignal.timeout(15000),
  });
  const cuerpo = await res.json().catch(() => null);
  if (!res.ok || !cuerpo?.ok) throw new ErrorTelegram(metodo, res.status, cuerpo);
  return cuerpo.result;
}

export const botonComprar = (link) => ({ inline_keyboard: [[{ text: 'Ir a comprar', url: link }]] });
