import { pegarObjeto } from "./r2.js";

// GET /api/pdf/<nome do arquivo codificado>  -> PDF do capítulo guardado no R2
export async function pdf(env, nomeCodificado) {
  let nome = nomeCodificado;
  try { nome = decodeURIComponent(nomeCodificado); } catch {}
  if (!nome.toLowerCase().endsWith(".pdf")) return Response.json({ erro: "Arquivo inválido." }, { status: 400 });
  const obj = await pegarObjeto(env, nome);
  if (!obj) return Response.json({ erro: `Não achei "${nome}" no bucket.` }, { status: 404 });
  return new Response(obj.body, {
    headers: { "content-type": "application/pdf", "content-length": String(obj.size) },
  });
}
