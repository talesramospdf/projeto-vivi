import { pegarObjeto } from "./r2.js";

export async function capitulos(env) {
  const obj = await pegarObjeto(env, "capitulos.json");
  if (!obj) return Response.json({ erro: "capitulos.json não está no bucket R2 livro-vivi." }, { status: 404 });
  return new Response(obj.body, { headers: { "content-type": "application/json; charset=utf-8" } });
}
