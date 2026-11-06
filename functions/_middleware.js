// Protege todas as rotas /api com a senha definida na variável SENHA do Cloudflare.
export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/") && env.SENHA) {
    const senha = request.headers.get("x-senha") || "";
    if (senha !== env.SENHA) {
      return Response.json({ erro: "Senha incorreta." }, { status: 401 });
    }
  }
  return next();
}
