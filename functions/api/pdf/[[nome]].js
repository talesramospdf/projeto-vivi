import { pegarObjeto } from "../../../lib/r2.js";

// GET /api/pdf/<nome do arquivo>  -> devolve o PDF do capítulo guardado no R2
export async function onRequestGet({ env, params }) {
  let nome = (Array.isArray(params.nome) ? params.nome.join("/") : params.nome) || "";
  if (nome.includes("%")) { try { nome = decodeURIComponent(nome); } catch {} }
  if (!nome.toLowerCase().endsWith(".pdf")) return Response.json({ erro: "Arquivo inválido." }, { status: 400 });
  try {
    const obj = await pegarObjeto(env, nome);
    if (!obj) return Response.json({ erro: `Não achei "${nome}" no bucket.` }, { status: 404 });
    return new Response(obj.body, {
      headers: { "content-type": "application/pdf", "content-length": String(obj.size) },
    });
  } catch (e) {
    return Response.json({ erro: e.message }, { status: 500 });
  }
}
