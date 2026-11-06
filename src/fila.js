// Fila de tradução em segundo plano (funciona com o site fechado).
//
// O navegador prepara cada trecho (2 páginas) como o pedido completo ao Gemini e
// guarda no R2. A cada minuto o Cloudflare roda `processarFila`, que repassa esses
// pedidos ao Gemini (sem processar o conteúdo, para caber no limite de CPU grátis)
// e guarda os resultados no R2.
//
// R2:
//   fila/ordem.json                      ["arquivo.pdf", ...] (ordem da fila)
//   fila/<arquivo>/job.json              { arquivo, id, titulo, trechos:[{ini,fim}], modelos:[...], status }
//   fila/<arquivo>/req/<ini>.json        pedido pronto para o Gemini
//   fila/<arquivo>/res/<ini>.json        resultado { blocos } ou { erro }
//   fila/<arquivo>/trava/<ini>           trecho em andamento (evita processar 2x)
//   fila/status.json                     o que o processo está fazendo agora
//   estado/capitulos.json                { arquivo: { manual: true } | { concluido: data } }

const API = "https://generativelanguage.googleapis.com/v1beta";
const P = (arq) => `fila/${arq}/`;
const agora = () => Date.now();

async function lerJSON(env, chave, padrao = null) {
  const o = await env.LIVRO.get(chave);
  if (!o) return padrao;
  try { return await o.json(); } catch { return padrao; }
}
const gravarJSON = (env, chave, v) => env.LIVRO.put(chave, JSON.stringify(v), { httpMetadata: { contentType: "application/json" } });

async function listar(env, prefixo) {
  const chaves = []; let cursor;
  do {
    const r = await env.LIVRO.list({ prefix: prefixo, cursor });
    for (const o of r.objects) chaves.push(o.key);
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return chaves;
}
const iniDe = (chave) => Number(chave.split("/").pop().replace(/\.json$/, ""));

async function apagarPrefixo(env, prefixo) {
  const ks = await listar(env, prefixo);
  for (let i = 0; i < ks.length; i += 1000) await env.LIVRO.delete(ks.slice(i, i + 1000));
}

// ---------------- rotas usadas pelo site ----------------

// GET /api/fila  -> estado geral (ordem, progresso de cada capítulo, status do processo, capítulos marcados)
export async function verFila(env) {
  const [ordem, status, estado] = await Promise.all([
    lerJSON(env, "fila/ordem.json", []),
    lerJSON(env, "fila/status.json", {}),
    lerJSON(env, "estado/capitulos.json", {}),
  ]);
  const itens = [];
  for (const arq of ordem) {
    const job = await lerJSON(env, P(arq) + "job.json");
    if (!job) continue;
    const res = await listar(env, P(arq) + "res/");
    const reqs = job.status === "enviando" ? (await listar(env, P(arq) + "req/")).length : job.trechos.length;
    itens.push({ arquivo: arq, id: job.id, titulo: job.titulo, total: job.trechos.length, feitos: res.length, enviados: reqs, status: job.status, metodo: job.metodo || "gemini" });
  }
  return Response.json({ itens, status, estado, agora: agora() });
}

// GET /api/fila/<arquivo>  -> trechos já enviados e prontos
export async function verCapitulo(env, arq) {
  const [job, reqs, res] = await Promise.all([lerJSON(env, P(arq) + "job.json"), listar(env, P(arq) + "req/"), listar(env, P(arq) + "res/")]);
  return Response.json({ job, enviados: reqs.map(iniDe), prontos: res.map(iniDe) });
}

// PUT /api/fila/<arquivo>/req/<ini>  (corpo = pedido do Gemini; só repassa ao R2, sem ler)
export async function guardarPedido(env, arq, ini, request) {
  await env.LIVRO.put(P(arq) + `req/${Number(ini)}.json`, request.body, { httpMetadata: { contentType: "application/json" } });
  return Response.json({ ok: true });
}

// GET /api/fila/<arquivo>/res/<ini>
export async function lerResultado(env, arq, ini) {
  const o = await env.LIVRO.get(P(arq) + `res/${Number(ini)}.json`);
  if (!o) return Response.json({ erro: "Ainda não traduzido." }, { status: 404 });
  return new Response(o.body, { headers: { "content-type": "application/json; charset=utf-8" } });
}

// PUT /api/fila/<arquivo>/res/<ini>  (trecho refeito pelo site)
export async function guardarResultado(env, arq, ini, request) {
  await env.LIVRO.put(P(arq) + `res/${Number(ini)}.json`, request.body, { httpMetadata: { contentType: "application/json" } });
  return Response.json({ ok: true });
}

// DELETE /api/fila/<arquivo>/res/<ini>  (para refazer um trecho)
export async function apagarResultado(env, arq, ini) {
  await env.LIVRO.delete(P(arq) + `res/${Number(ini)}.json`);
  return Response.json({ ok: true });
}

// PUT /api/fila/<arquivo>/job  (cria/atualiza o capítulo na fila)
export async function guardarJob(env, arq, request) {
  const job = await request.json();
  job.arquivo = arq;
  await gravarJSON(env, P(arq) + "job.json", job);
  const ordem = await lerJSON(env, "fila/ordem.json", []);
  if (!ordem.includes(arq)) { ordem.push(arq); await gravarJSON(env, "fila/ordem.json", ordem); }
  return Response.json({ ok: true });
}

// POST /api/fila/ordem  { ordem: [...] }  (reordenar)
export async function reordenar(env, request) {
  const { ordem } = await request.json();
  const atual = await lerJSON(env, "fila/ordem.json", []);
  const nova = ordem.filter((a) => atual.includes(a)).concat(atual.filter((a) => !ordem.includes(a)));
  await gravarJSON(env, "fila/ordem.json", nova);
  return Response.json({ ok: true, ordem: nova });
}

// DELETE /api/fila/<arquivo>  (tira da fila; mantém o que já foi traduzido se manter=1)
export async function removerDaFila(env, arq, manter) {
  const ordem = await lerJSON(env, "fila/ordem.json", []);
  await gravarJSON(env, "fila/ordem.json", ordem.filter((a) => a !== arq));
  await apagarPrefixo(env, P(arq) + "req/");
  await apagarPrefixo(env, P(arq) + "trava/");
  if (!manter) { await apagarPrefixo(env, P(arq)); }
  return Response.json({ ok: true });
}

// PUT /api/estado  { arquivo, manual: true|false }
export async function marcar(env, request) {
  const { arquivo, manual, limpar } = await request.json();
  const estado = await lerJSON(env, "estado/capitulos.json", {});
  estado[arquivo] = limpar ? {} : { ...(estado[arquivo] || {}) };
  if (manual) estado[arquivo].manual = true; else delete estado[arquivo].manual;
  if (!Object.keys(estado[arquivo]).length) delete estado[arquivo];
  await gravarJSON(env, "estado/capitulos.json", estado);
  return Response.json({ ok: true, estado });
}

// POST /api/fila/acordar  -> limpa a pausa (botão "tentar agora")
export async function acordar(env) {
  const st = await lerJSON(env, "fila/status.json", {});
  st.pausaAte = 0; st.mensagem = "Retomando…";
  await gravarJSON(env, "fila/status.json", st);
  return Response.json({ ok: true });
}

// ---------------- processamento (Cron, a cada minuto) ----------------

async function chamarGemini(env, req, modelo) {
  // repassa o pedido salvo direto do R2 para o Gemini, sem ler o conteúdo
  const { readable, writable } = new FixedLengthStream(req.size);
  req.body.pipeTo(writable);
  const base = env.GEMINI_API_BASE || API;
  const r = await fetch(`${base}/models/${modelo}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: readable,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = dados?.error?.message || `Erro ${r.status} do Gemini`;
    const retry = (dados?.error?.details || []).find((d) => d.retryDelay)?.retryDelay;
    return { ok: false, status: r.status, erro: msg, esperar: retry ? parseFloat(retry) : null };
  }
  const cand = dados.candidates?.[0];
  const motivo = cand?.finishReason || dados.promptFeedback?.blockReason;
  const texto = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
  if (!cand || (motivo && motivo !== "STOP")) return { ok: false, status: 200, erro: `O Gemini parou antes do fim (${motivo || "sem resposta"}).`, motivo };
  try { return { ok: true, blocos: JSON.parse(texto).blocos || [] }; }
  catch { return { ok: false, status: 200, erro: "Resposta do Gemini em formato inválido.", motivo: "JSON" }; }
}

export async function processarFila(env) {
  const t0 = agora();
  const st = await lerJSON(env, "fila/status.json", {});
  st.ultimaExecucao = t0;
  const salvarSt = () => gravarJSON(env, "fila/status.json", st);
  if (!env.GEMINI_API_KEY) { st.mensagem = "Falta a GEMINI_API_KEY no Cloudflare."; return salvarSt(); }
  if (st.pausaAte && st.pausaAte > t0) return salvarSt();

  const ordem = await lerJSON(env, "fila/ordem.json", []);
  let fezAlgo = false;
  for (const arq of ordem) {
    const job = await lerJSON(env, P(arq) + "job.json");
    if (!job || job.status !== "pronto") continue;
    const prontos = new Set((await listar(env, P(arq) + "res/")).map(iniDe));
    const pendentes = job.trechos.filter((t) => !prontos.has(t.ini));
    if (!pendentes.length) {
      // capítulo concluído: sai da fila, marca como traduzido e apaga os pedidos
      const estado = await lerJSON(env, "estado/capitulos.json", {});
      estado[arq] = { ...(estado[arq] || {}), concluido: agora() };
      await gravarJSON(env, "estado/capitulos.json", estado);
      await gravarJSON(env, "fila/ordem.json", (await lerJSON(env, "fila/ordem.json", [])).filter((a) => a !== arq));
      await apagarPrefixo(env, P(arq) + "req/");
      await apagarPrefixo(env, P(arq) + "trava/");
      continue;
    }
    for (const t of pendentes) {
      if (agora() - t0 > 40000) { await salvarSt(); return; } // deixa o resto para o próximo minuto
      const trava = await lerJSON(env, P(arq) + `trava/${t.ini}`);
      if (trava && trava.ate > agora()) continue;
      const req = await env.LIVRO.get(P(arq) + `req/${t.ini}.json`);
      if (!req) continue;
      await gravarJSON(env, P(arq) + `trava/${t.ini}`, { ate: agora() + 5 * 60000 });

      const modelos = job.modelos?.length ? job.modelos : ["gemini-2.5-flash"];
      if (!st.modeloAtivo || !modelos.includes(st.modeloAtivo)) st.modeloAtivo = modelos[0];
      st.atual = { arquivo: arq, id: job.id, ini: t.ini, fim: t.fim, desde: agora() };
      st.mensagem = `Traduzindo o capítulo ${Number(job.id)}, páginas ${t.ini}–${t.fim}`;
      await salvarSt();

      const r = await chamarGemini(env, req, st.modeloAtivo);
      await env.LIVRO.delete(P(arq) + `trava/${t.ini}`);
      fezAlgo = true;

      if (r.ok) {
        await gravarJSON(env, P(arq) + `res/${t.ini}.json`, { ini: t.ini, fim: t.fim, modelo: st.modeloAtivo, blocos: r.blocos, quando: agora() });
        st.falhas = 0; st.ultimoOk = agora(); st.atual = null;
        st.mensagem = `Capítulo ${Number(job.id)}: páginas ${t.ini}–${t.fim} prontas`;
        continue;
      }

      const proximo = () => {
        const i = modelos.indexOf(st.modeloAtivo);
        st.modeloAtivo = modelos[(i + 1) % modelos.length];
        return i + 1 < modelos.length;
      };
      const diario = r.status === 429 && /per ?day|PerDay|daily|limit:\s*0\b/i.test(r.erro);
      const sobrecarga = [500, 503, 504, 524].includes(r.status) || /overload|high demand|unavailable|try again later/i.test(r.erro);
      st.atual = null;
      if (diario) {
        if (proximo()) { st.mensagem = `Limite diário de um modelo; usando ${st.modeloAtivo}.`; }
        else { st.pausaAte = agora() + 60 * 60000; st.mensagem = "Limite diário do Gemini atingido em todos os modelos. Tentando de novo a cada hora."; }
      } else if (r.status === 429) {
        st.pausaAte = agora() + Math.min(Math.max(r.esperar || 30, 15), 120) * 1000;
        st.mensagem = "Limite por minuto do Gemini. Aguardando…";
      } else if (sobrecarga) {
        st.falhas = (st.falhas || 0) + 1;
        if (st.falhas % 2 === 0) proximo();
        st.pausaAte = agora() + Math.min(30 * st.falhas, 300) * 1000;
        st.mensagem = `O Gemini está lotado agora. Tentando de novo em breve (${st.modeloAtivo}).`;
      } else {
        // erro do próprio trecho (ex.: resposta grande demais): registra para refazer pelo site
        const tent = (trava?.tentativas || 0) + 1;
        if (tent >= 3 || r.motivo === "MAX_TOKENS") {
          await gravarJSON(env, P(arq) + `res/${t.ini}.json`, { ini: t.ini, fim: t.fim, erro: r.erro, motivo: r.motivo || null, quando: agora() });
        } else {
          await gravarJSON(env, P(arq) + `trava/${t.ini}`, { ate: agora() + 60000, tentativas: tent });
        }
        st.mensagem = `Problema nas páginas ${t.ini}–${t.fim}: ${r.erro}`;
        continue;
      }
      await salvarSt();
      return;
    }
  }
  if (!fezAlgo) { st.atual = null; if (!ordem.length) st.mensagem = "Fila vazia."; }
  await salvarSt();
}
