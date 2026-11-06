import { capitulos } from "./capitulos.js";
import { pdf } from "./pdf.js";
import { lerGlossario, salvarGlossario } from "./glossario.js";
import { modelos } from "./modelos.js";
import { traduzir } from "./traduzir.js";
import {
  verFila, verCapitulo, guardarPedido, lerResultado, apagarResultado, guardarResultado, guardarJob,
  reordenar, removerDaFila, marcar, acordar, processarFila,
} from "./fila.js";

// Worker do Tradutor: arquivos do site vêm de /public (ASSETS); /api/* passa por aqui.
// A cada minuto (Cron) o Worker traduz os trechos da fila, mesmo com o site fechado.
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
    const partes = caminho.split("/").slice(2).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    try {
      if (caminho === "/api/capitulos" && m === "GET") return await capitulos(env);
      if (caminho.startsWith("/api/pdf/") && m === "GET") return await pdf(env, caminho.slice("/api/pdf/".length));
      if (caminho === "/api/glossario" && m === "GET") return await lerGlossario(env);
      if (caminho === "/api/glossario" && m === "PUT") return await salvarGlossario(env, request);
      if (caminho === "/api/modelos" && m === "GET") return await modelos(env);
      if (caminho === "/api/traduzir" && m === "POST") return await traduzir(env, request, url);
      if (caminho === "/api/estado" && m === "PUT") return await marcar(env, request);

      // fila
      if (partes[0] === "fila") {
        if (partes.length === 1 && m === "GET") return await verFila(env);
        if (partes[1] === "ordem" && m === "POST") return await reordenar(env, request);
        if (partes[1] === "acordar" && m === "POST") { await acordar(env); await processarFila(env); return Response.json({ ok: true }); }
        const arq = partes[1];
        if (!arq || !arq.toLowerCase().endsWith(".pdf")) return Response.json({ erro: "Capítulo inválido." }, { status: 400 });
        if (partes.length === 2 && m === "GET") return await verCapitulo(env, arq);
        if (partes.length === 2 && m === "DELETE") return await removerDaFila(env, arq, url.searchParams.get("manter") === "1");
        if (partes[2] === "job" && m === "PUT") return await guardarJob(env, arq, request);
        if (partes[2] === "req" && m === "PUT") return await guardarPedido(env, arq, partes[3], request);
        if (partes[2] === "res" && m === "GET") return await lerResultado(env, arq, partes[3]);
        if (partes[2] === "res" && m === "PUT") return await guardarResultado(env, arq, partes[3], request);
        if (partes[2] === "res" && m === "DELETE") return await apagarResultado(env, arq, partes[3]);
      }
      return Response.json({ erro: "Rota não encontrada." }, { status: 404 });
    } catch (e) {
      return Response.json({ erro: e.message || String(e) }, { status: 500 });
    }
  },

  // Cron: roda sozinho a cada minuto
  async scheduled(_evento, env, ctx) {
    ctx.waitUntil(processarFila(env));
  },
};
