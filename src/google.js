// POST /api/google  (corpo: q=texto)  -> repassa ao Google Tradutor (mesmo serviço gratuito dos plugins)
export async function google(request, env) {
  const base = env.GOOGLE_API_BASE || "https://translate.googleapis.com"; // GOOGLE_API_BASE só em testes locais
  const r = await fetch(`${base}/translate_a/single?client=gtx&sl=en&tl=pt&dt=t`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": "Mozilla/5.0" },
    body: request.body,
  });
  return new Response(r.body, { status: r.status, headers: { "content-type": "application/json; charset=utf-8" } });
}
