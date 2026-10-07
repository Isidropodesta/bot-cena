class ErrorTelegram extends Error {
  constructor(status, cuerpo) {
    super(`Telegram sendMessage -> HTTP ${status} ${cuerpo?.description ?? ''}`);
    this.status = status;
    this.retryAfter = cuerpo?.parameters?.retry_after ?? null;
  }
}

export function crearEnviar({ token, fetchFn = fetch }) {
  return async (m) => {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: m.chatId,
        text: m.texto,
        link_preview_options: { is_disabled: true },
        ...(m.conBoton ? { reply_markup: { inline_keyboard: [[{ text: 'Ir a comprar', url: m.link }]] } } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    const cuerpo = await res.json().catch(() => null);
    if (!res.ok || !cuerpo?.ok) throw new ErrorTelegram(res.status, cuerpo);
  };
}
