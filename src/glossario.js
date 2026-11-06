// Glossário de termos fixos, guardado no R2 como glossario.txt
export async function lerGlossario(env) {
  const obj = await env.LIVRO.get("glossario.txt");
  return new Response(obj ? await obj.text() : "", { headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function salvarGlossario(env, request) {
  const texto = (await request.text()).slice(0, 100000);
  await env.LIVRO.put("glossario.txt", texto, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  return Response.json({ ok: true });
}
