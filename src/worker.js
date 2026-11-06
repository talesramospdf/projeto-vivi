import { capitulos } from "./capitulos.js";
import { pdf } from "./pdf.js";
import { lerGlossario, salvarGlossario } from "./glossario.js";
import { modelos } from "./modelos.js";
import { traduzir } from "./traduzir.js";

// Worker do Tradutor: arquivos do site vêm de /public (ASSETS); /api/* passa por aqui.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const caminho = url.pathname;
    if (!caminho.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (!env.SENHA) return Response.json({ erro: "Falta a variável SENHA no Cloudflare." }, { status: 500 });
    if ((request.headers.get("x-senha") || "") !== env.SENHA) {
      return Response.json({ erro: "Senha incorreta." }, { status: 401 });
    }

    const m = request.method;
    try {
      if (caminho === "/api/capitulos" && m === "GET") return await capitulos(env);
      if (caminho.startsWith("/api/pdf/") && m === "GET") return await pdf(env, caminho.slice("/api/pdf/".length));
      if (caminho === "/api/glossario" && m === "GET") return await lerGlossario(env);
      if (caminho === "/api/glossario" && m === "PUT") return await salvarGlossario(env, request);
      if (caminho === "/api/modelos" && m === "GET") return await modelos(env);
      if (caminho === "/api/traduzir" && m === "POST") return await traduzir(env, request, url);
      return Response.json({ erro: "Rota não encontrada." }, { status: 404 });
    } catch (e) {
      return Response.json({ erro: e.message || String(e) }, { status: 500 });
    }
  },
};
