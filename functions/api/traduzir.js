import { SCHEMA, montarPrompt } from "../../lib/prompt.js";

const API = "https://generativelanguage.googleapis.com/v1beta";

// POST /api/traduzir
// corpo: { modelo, imagens: [base64 jpeg], capitulo, numero, glossario, anterior }
export async function onRequestPost({ env, request }) {
  if (!env.GEMINI_API_KEY) return Response.json({ erro: "Falta GEMINI_API_KEY nas variáveis do Cloudflare." }, { status: 500 });
  const c = await request.json();
  const modelo = (c.modelo || env.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, "");

  const corpo = {
    contents: [{
      role: "user",
      parts: [
        { text: montarPrompt({ capitulo: c.capitulo, numero: c.numero, paginas: c.imagens.length, glossario: c.glossario, anterior: c.anterior }) },
        ...c.imagens.map((data) => ({ inline_data: { mime_type: "image/jpeg", data } })),
      ],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 60000,
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
    },
    safetySettings: ["HARASSMENT", "HATE_SPEECH", "SEXUALLY_EXPLICIT", "DANGEROUS_CONTENT"].map((k) => ({
      category: "HARM_CATEGORY_" + k, threshold: "BLOCK_NONE",
    })),
  };

  const base = env.GEMINI_API_BASE || API; // GEMINI_API_BASE só é usado em testes locais
  const r = await fetch(`${base}/models/${modelo}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(corpo),
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
  const motivo = cand?.finishReason;
  const texto = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
  if (motivo && motivo !== "STOP") {
    return Response.json({ erro: `O Gemini parou antes do fim (${motivo}).`, motivo }, { status: 502 });
  }
  try {
    const json = JSON.parse(texto);
    return Response.json({ blocos: json.blocos || [], uso: dados.usageMetadata || null });
  } catch {
    return Response.json({ erro: "Resposta do Gemini veio em formato inválido.", motivo: "JSON" }, { status: 502 });
  }
}
