import { pegarObjeto } from "../../lib/r2.js";

export async function onRequestGet({ env }) {
  try {
    const obj = await pegarObjeto(env, "capitulos.json");
    if (!obj) return Response.json({ erro: "capitulos.json não está no bucket R2." }, { status: 404 });
    return new Response(obj.body, { headers: { "content-type": "application/json; charset=utf-8" } });
  } catch (e) {
    return Response.json({ erro: e.message }, { status: 500 });
  }
}
