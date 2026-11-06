// Lista os modelos do Gemini disponíveis para a chave, para escolher no site.
export async function modelos(env) {
  if (!env.GEMINI_API_KEY) return Response.json({ erro: "Falta GEMINI_API_KEY nas variáveis do Cloudflare." }, { status: 500 });
  const base = env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta";
  const r = await fetch(`${base}/models?pageSize=200`, { headers: { "x-goog-api-key": env.GEMINI_API_KEY } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return Response.json({ erro: d?.error?.message || `Erro ${r.status}` }, { status: 502 });
  const lista = (d.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^gemini-/.test(n) && !/(image|tts|audio|live|embedding|robotics|computer|nano|exp)/.test(n));
  return Response.json({ modelos: lista, padrao: env.GEMINI_MODEL || null });
}
