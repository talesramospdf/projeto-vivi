const API = "https://generativelanguage.googleapis.com/v1beta";

// POST /api/traduzir?modelo=...
// O corpo já vem pronto do navegador (prompt + imagens das páginas) e é repassado
// direto ao Gemini, sem ser lido aqui: assim o Worker gasta quase nada de CPU.
export async function traduzir(env, request, url) {
  if (!env.GEMINI_API_KEY) return Response.json({ erro: "Falta GEMINI_API_KEY nas variáveis do Cloudflare." }, { status: 500 });
  const modelo = (url.searchParams.get("modelo") || env.GEMINI_MODEL || "gemini-2.5-flash").replace(/[^\w.\-]/g, "");
  const base = env.GEMINI_API_BASE || API; // GEMINI_API_BASE só é usado em testes locais

  const r = await fetch(`${base}/models/${modelo}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: request.body,
  });
  const dados = await r.json().catch(() => ({}));

  if (!r.ok) {
    const msg = dados?.error?.message || `Erro ${r.status} do Gemini`;
    const retry = (dados?.error?.details || []).find((d) => d.retryDelay)?.retryDelay;
    return Response.json(
      { erro: msg, status: r.status, esperar: retry ? parseFloat(retry) : null },
      { status: r.status === 429 ? 429 : 502 },
    );
  }

  const cand = dados.candidates?.[0];
  const motivo = cand?.finishReason || dados.promptFeedback?.blockReason;
  const texto = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
  if (!cand || (motivo && motivo !== "STOP")) {
    return Response.json({ erro: `O Gemini parou antes do fim (${motivo || "sem resposta"}).`, motivo }, { status: 502 });
  }
  try {
    const json = JSON.parse(texto);
    return Response.json({ blocos: json.blocos || [], uso: dados.usageMetadata || null });
  } catch {
    return Response.json({ erro: "Resposta do Gemini veio em formato inválido.", motivo: "JSON" }, { status: 502 });
  }
}
