import * as pdfjs from "./vendor/pdf.min.js";
import { gerarDocx } from "./word.js";
import { SCHEMA, montarPrompt } from "./prompt.js";
import { criarEditor } from "./editor.js";
import { extrairCapitulo } from "./extrair.js";
import { traduzirBlocosGoogle } from "./google.js";

pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.js";

const $ = (id) => document.getElementById(id);
const TAM = 2;              // páginas por trecho enviado ao Gemini
const LARG_ENVIO = 1600;    // largura (px) das imagens das páginas enviadas ao Gemini
const LARG_FIGURA = 2200;   // largura (px) usada para recortar as figuras do Word
const MAX_TENTATIVAS = 10;
const INTERVALO_FILA = 15000;

const estado = {
  caps: [], cap: null, pdf: null, pdfDe: null, modelos: [],
  fila: { itens: [], status: {}, estado: {} },
  selecao: new Set(), filtro: "todos",
  envios: [], enviando: null, erros: {}, rodando: false, parar: false,
};
let editor;

// ---------- utilidades ----------
const guardar = {
  ler(k, padrao = null) { try { const v = localStorage.getItem(k); return v == null ? padrao : JSON.parse(v); } catch { return padrao; } },
  gravar(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  apagar(k) { try { localStorage.removeItem(k); } catch {} },
};
const senha = () => guardar.ler("senha", "");
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hora = (t) => new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const enc = encodeURIComponent;

async function api(caminho, opcoes = {}) {
  const r = await fetch(caminho, { ...opcoes, headers: { ...(opcoes.headers || {}), "x-senha": senha() } });
  if (r.status === 401) { mostrarLogin("Senha incorreta."); throw new Error("Senha incorreta."); }
  return r;
}
function log(msg, classe = "") {
  const li = document.createElement("li");
  li.textContent = msg; if (classe) li.className = classe;
  $("log").appendChild(li); $("log").scrollTop = $("log").scrollHeight;
}
const status = (msg) => { $("status").textContent = msg; };
const barra = (f) => { $("barra").style.width = `${Math.round(f * 100)}%`; };

// ---------- login / início ----------
function mostrarLogin(erro) {
  $("tela-app").hidden = true; $("sair").hidden = true; $("tela-login").hidden = false;
  $("erro-login").hidden = !erro; $("erro-login").textContent = erro || "";
}
$("form-login").addEventListener("submit", (e) => { e.preventDefault(); guardar.gravar("senha", $("senha").value); iniciar(); });
$("sair").addEventListener("click", () => { guardar.apagar("senha"); mostrarLogin(); });

async function iniciar() {
  try {
    const r = await api("/api/capitulos"); const d = await r.json();
    if (!r.ok) throw new Error(d.erro || "Erro ao carregar capítulos.");
    estado.caps = d;
  } catch (e) {
    if (e.message !== "Senha incorreta.") mostrarLogin(e.message);
    return;
  }
  $("tela-login").hidden = true; $("tela-app").hidden = false; $("sair").hidden = false;
  carregarModelos(); carregarGlossario();
  await atualizarFila();
  setInterval(() => { if (!document.hidden) atualizarFila(); }, INTERVALO_FILA);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) atualizarFila(); });
}

async function carregarModelos() {
  const sel = $("modelo");
  try {
    const r = await api("/api/modelos"); const d = await r.json();
    if (!r.ok) throw new Error(d.erro);
    estado.modelos = d.modelos;
    const salvo = guardar.ler("modelo", null);
    const sugestao = d.padrao && d.modelos.includes(d.padrao) ? d.padrao : escolherPadrao(d.modelos);
    sel.innerHTML = d.modelos.map((m) => `<option>${esc(m)}</option>`).join("");
    sel.value = salvo && d.modelos.includes(salvo) ? salvo : sugestao;
  } catch (e) {
    sel.innerHTML = `<option>gemini-2.5-flash</option>`;
    faixa("⚠", "Não consegui falar com o Gemini", `Verifique a GEMINI_API_KEY no Cloudflare. (${e.message})`, "erro");
  }
}
const versao = (n) => parseFloat((n.match(/gemini-(\d+(\.\d+)?)/) || [])[1] || 0);
function escolherPadrao(lista) {
  const flash = lista.filter((n) => /flash/.test(n) && !/lite|preview|thinking/.test(n));
  return (flash.length ? flash : lista).sort((a, b) => versao(b) - versao(a) || a.length - b.length)[0];
}
// ordem de reserva: o escolhido, depois os "flash" mais novos, depois os "flash-lite"
function reservas(escolhido) {
  const lista = estado.modelos || [];
  const ordem = (f) => lista.filter(f).sort((a, b) => versao(b) - versao(a) || a.length - b.length);
  const flash = ordem((n) => /flash/.test(n) && !/lite/.test(n) && !/preview|thinking/.test(n));
  const lite = ordem((n) => /flash-lite/.test(n) && !/preview/.test(n));
  return [...new Set([escolhido, ...flash, ...lite])].filter(Boolean);
}
$("modelo").addEventListener("change", () => { guardar.gravar("modelo", $("modelo").value); estado.modeloAtivo = null; });

async function carregarGlossario() {
  try { const r = await api("/api/glossario"); $("glossario").value = await r.text(); } catch {}
}
$("btn-glossario").addEventListener("click", async () => {
  const r = await api("/api/glossario", { method: "PUT", body: $("glossario").value });
  $("ok-glossario").textContent = r.ok ? "Salvo ✓ (vale para os próximos capítulos colocados na fila)" : "Erro ao salvar";
  setTimeout(() => ($("ok-glossario").textContent = ""), 4000);
});

// ---------- trechos e cache local ----------
const chave = (cap, ini) => `trad:${cap.arquivo}:${TAM}:${ini}`;
const trechosDe = (cap) => Array.from({ length: Math.ceil(cap.paginas / TAM) }, (_, k) => ({ ini: k * TAM + 1, fim: Math.min((k + 1) * TAM, cap.paginas) }));
const prontosLocais = (cap) => trechosDe(cap).filter((t) => guardar.ler(chave(cap, t.ini))).length;

// ---------- situação de cada capítulo ----------
function situacao(cap) {
  const e = estado.fila.estado[cap.arquivo] || {};
  const item = estado.fila.itens.find((i) => i.arquivo === cap.arquivo);
  const total = trechosDe(cap).length;
  if (estado.enviando === cap.arquivo) return { tipo: "fila", rotulo: "Enviando…", classe: "enviando" };
  if (estado.envios.some((e) => e.arquivo === cap.arquivo)) return { tipo: "fila", rotulo: "Aguardando", classe: "fila" };
  if (item) {
    if (item.status === "enviando") return { tipo: "fila", rotulo: item.metodo === "google" ? "Google: incompleto" : `Envio incompleto (${item.enviados}/${item.total})`, classe: "alerta" };
    return { tipo: "fila", rotulo: `Na fila · ${Math.round((item.feitos / item.total) * 100)}%`, classe: "fila", progresso: item.feitos / item.total };
  }
  if (e.manual) return { tipo: "pronto", rotulo: "Feito à mão ✓", classe: "manual" };
  if (e.concluido || prontosLocais(cap) === total) return { tipo: "pronto", rotulo: "Traduzido ✓", classe: "pronto" };
  if (prontosLocais(cap)) return { tipo: "pendente", rotulo: "Parcial", classe: "alerta" };
  return { tipo: "pendente", rotulo: "", classe: "" };
}

function desenharCapitulos() {
  const f = estado.filtro;
  const lista = estado.caps.filter((c) => {
    const s = situacao(c).tipo;
    return f === "todos" || (f === "pendentes" && s === "pendente") || (f === "fila" && s === "fila") || (f === "prontos" && s === "pronto");
  });
  const nProntos = estado.caps.filter((c) => situacao(c).tipo === "pronto").length;
  $("contagem").textContent = `${nProntos} de ${estado.caps.length} prontos`;
  $("lista-caps").innerHTML = lista.map((c) => {
    const s = situacao(c);
    const sel = estado.selecao.has(c.arquivo);
    const aberto = estado.cap?.arquivo === c.arquivo;
    return `<li class="cap ${s.classe} ${aberto ? "aberto" : ""}" data-arq="${esc(c.arquivo)}">
      <label class="chk"><input type="checkbox" ${sel ? "checked" : ""} aria-label="Selecionar capítulo ${Number(c.id)}"></label>
      <button class="nome" title="Abrir capítulo"><span class="n">${Number(c.id)}</span> ${esc(c.titulo)} <span class="pg">${c.paginas} pág.</span></button>
      ${s.rotulo ? `<span class="selo-cap ${s.classe}">${esc(s.rotulo)}</span>` : ""}
      ${s.progresso != null ? `<span class="mini-barra"><i style="width:${Math.round(s.progresso * 100)}%"></i></span>` : ""}
    </li>`;
  }).join("") || `<li class="dica vazio">Nenhum capítulo aqui.</li>`;
  const n = estado.selecao.size;
  $("acoes-sel").hidden = n === 0;
  $("qtd-sel").textContent = `${n} selecionado${n > 1 ? "s" : ""}`;
}
$("lista-caps").addEventListener("click", (ev) => {
  const li = ev.target.closest("li.cap"); if (!li) return;
  const arq = li.dataset.arq;
  if (ev.target.closest(".chk")) {
    if (ev.target.tagName !== "INPUT") return;
    if (ev.target.checked) estado.selecao.add(arq); else estado.selecao.delete(arq);
    desenharCapitulos(); return;
  }
  if (ev.target.closest(".nome")) abrirCapitulo(estado.caps.find((c) => c.arquivo === arq));
});
document.querySelectorAll(".filtro").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".filtro").forEach((x) => x.classList.toggle("ativo", x === b));
  estado.filtro = b.dataset.f; desenharCapitulos();
}));

async function marcarSelecao(manual) {
  for (const arq of estado.selecao) {
    const r = await api("/api/estado", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ arquivo: arq, manual }) });
    const d = await r.json(); if (d.estado) estado.fila.estado = d.estado;
  }
  estado.selecao.clear(); desenharCapitulos();
}
$("btn-marcar").addEventListener("click", () => marcarSelecao(true));
$("btn-desmarcar").addEventListener("click", () => marcarSelecao(false));

// ---------- faixa de status do tradutor em segundo plano ----------
function faixa(icone, titulo, sub, classe = "") {
  $("faixa").className = "faixa " + classe;
  $("faixa-icone").textContent = icone; $("faixa-titulo").textContent = titulo; $("faixa-sub").textContent = sub || "";
}
function desenharFaixa() {
  const { itens, status: st, agora } = estado.fila;
  const relogio = agora || Date.now();
  const pend = itens.filter((i) => i.status === "pronto" && i.feitos < i.total);
  $("btn-acordar").hidden = true;
  if (estado.enviando) {
    if (estado.metodoEnvio === "google") faixa("⏳", "Traduzindo com o Google Tradutor…", "Mantenha o site aberto até terminar (costuma levar poucos minutos por capítulo).", "enviando");
    else faixa("⬆", "Enviando páginas para o tradutor…", "Mantenha o site aberto até o envio terminar. Depois a tradução continua sozinha.", "enviando");
  } else if (!pend.length) {
    faixa("♡", itens.length ? "Fila concluída!" : "Tudo tranquilo por aqui", "Coloque capítulos na fila para traduzir em segundo plano.", "");
  } else if (st.pausaAte && st.pausaAte > relogio) {
    faixa("⏸", "Esperando o Gemini liberar", `${st.mensagem || ""} Retoma sozinho às ${hora(st.pausaAte)}.`, "pausa");
    $("btn-acordar").hidden = false;
  } else if (st.ultimaExecucao && relogio - st.ultimaExecucao > 5 * 60000) {
    faixa("⚠", "O tradutor automático parece parado", `Última atividade às ${hora(st.ultimaExecucao)}. Clique em "Tentar agora".`, "erro");
    $("btn-acordar").hidden = false;
  } else {
    faixa("✿", "Traduzindo em segundo plano — pode fechar o site", st.mensagem || "Começando em instantes…", "ok");
  }
}
$("btn-acordar").addEventListener("click", async () => {
  $("btn-acordar").disabled = true; faixa("⏳", "Tentando agora…", "Isso pode levar até 1 minuto.", "ok");
  try { await api("/api/fila/acordar", { method: "POST" }); } catch {}
  $("btn-acordar").disabled = false; atualizarFila();
});

// ---------- fila ----------
function desenharFila() {
  const { itens, status: st } = estado.fila;
  const locais = estado.envios.map((e) => e.arquivo).filter((a) => !itens.some((i) => i.arquivo === a));
  $("fila-vazia").hidden = itens.length + locais.length > 0;
  const linha = (arq, titulo, id, texto, frac, classe, botoes) => `
    <li class="item-fila ${classe}" data-arq="${esc(arq)}">
      <div class="if-topo"><strong><span class="n">${Number(id)}</span> ${esc(titulo)}</strong>${botoes}</div>
      <div class="barra fina"><div style="width:${Math.round(frac * 100)}%"></div></div>
      <span class="if-texto">${texto}</span>
    </li>`;
  const btns = (i, n) => `<span class="if-botoes">
      <button data-a="sobe" title="Subir na fila" ${i === 0 ? "disabled" : ""}>↑</button>
      <button data-a="desce" title="Descer na fila" ${i === n - 1 ? "disabled" : ""}>↓</button>
      <button data-a="tira" class="perigo" title="Tirar da fila">✕</button></span>`;
  $("lista-fila").innerHTML = itens.map((it, i) => {
    let texto, classe = "";
    const atual = st.atual && st.atual.arquivo === it.arquivo;
    if (it.status === "enviando") {
      texto = estado.enviando === it.arquivo ? (it.metodo === "google" ? "Traduzindo com o Google Tradutor…" : "Enviando páginas…")
        : `Interrompido (o site foi fechado). Selecione o capítulo e clique em <b>Colocar na fila</b> de novo.`;
      classe = "alerta";
    }
    else if (it.feitos >= it.total) { texto = "Pronto ✓"; classe = "pronto"; }
    else if (atual) { texto = `Traduzindo agora as páginas ${st.atual.ini}–${st.atual.fim} · ${it.feitos} de ${it.total} trechos prontos`; classe = "atual"; }
    else texto = `${it.feitos} de ${it.total} trechos prontos · aguardando a vez`;
    if (it.metodo === "google") texto = "Google Tradutor · " + texto;
    return linha(it.arquivo, it.titulo, it.id, texto, it.status === "enviando" ? it.enviados / it.total : it.feitos / it.total, classe, btns(i, itens.length));
  }).join("") + locais.map((a) => {
    const c = estado.caps.find((x) => x.arquivo === a);
    const e = estado.envios.find((x) => x.arquivo === a);
    return linha(a, c.titulo, c.id, estado.enviando === a ? "Preparando…" : `Aguardando a vez (${e.metodo === "google" ? "Google Tradutor" : "Gemini"}) · deixe o site aberto`, 0, "local", "");
  }).join("");
}
$("lista-fila").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-a]"); if (!b) return;
  const arq = b.closest("li").dataset.arq;
  const ordem = estado.fila.itens.map((i) => i.arquivo);
  const i = ordem.indexOf(arq);
  if (b.dataset.a === "tira") {
    if (!confirm("Tirar este capítulo da fila? O que já foi traduzido fica guardado.")) return;
    await api("/api/fila/" + enc(arq) + "?manter=1", { method: "DELETE" });
  } else {
    const j = b.dataset.a === "sobe" ? i - 1 : i + 1;
    [ordem[i], ordem[j]] = [ordem[j], ordem[i]];
    await api("/api/fila/ordem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ordem }) });
  }
  atualizarFila();
});

let atualizando = false;
async function atualizarFila() {
  if (atualizando) return; atualizando = true;
  try {
    const r = await api("/api/fila"); const d = await r.json();
    if (r.ok) estado.fila = d;
  } catch {} finally { atualizando = false; }
  desenharFaixa(); desenharFila(); desenharCapitulos();
  if (estado.cap && !estado.rodando) {
    const item = estado.fila.itens.find((i) => i.arquivo === estado.cap.arquivo);
    if (item && item.feitos > prontosLocais(estado.cap)) sincronizar(estado.cap).then(atualizarCapitulo);
  }
}

// ---------- colocar na fila (prepara as páginas e envia ao Cloudflare) ----------
const metodoEscolhido = () => document.querySelector('input[name="metodo"]:checked')?.value || "gemini";
document.querySelectorAll('input[name="metodo"]').forEach((r) => {
  if (r.value === guardar.ler("metodo", "gemini")) r.checked = true;
  r.addEventListener("change", () => guardar.gravar("metodo", metodoEscolhido()));
});
$("btn-enfileirar").addEventListener("click", () => {
  const novos = [...estado.selecao].filter((a) => !estado.envios.some((e) => e.arquivo === a) && estado.enviando !== a);
  const jaProntos = novos.filter((a) => situacao(estado.caps.find((c) => c.arquivo === a)).tipo === "pronto");
  if (jaProntos.length && !confirm(`${jaProntos.length} capítulo(s) já estão prontos ou feitos à mão. Traduzir de novo mesmo assim?`)) {
    novos.splice(0, novos.length, ...novos.filter((a) => !jaProntos.includes(a)));
  }
  const metodo = metodoEscolhido();
  estado.envios.push(...novos.map((arquivo) => ({ arquivo, metodo })));
  estado.selecao.clear();
  desenharCapitulos(); desenharFila();
  processarEnvios();
});

function avisoSaida(ev) { ev.preventDefault(); ev.returnValue = ""; }

async function processarEnvios() {
  if (estado.enviando) return;
  window.addEventListener("beforeunload", avisoSaida);
  try {
    while (estado.envios.length) {
      const { arquivo: arq, metodo } = estado.envios[0];
      estado.enviando = arq; estado.metodoEnvio = metodo; desenharFaixa(); desenharFila(); desenharCapitulos();
      const cap = estado.caps.find((c) => c.arquivo === arq);
      try { await (metodo === "google" ? traduzirComGoogle(cap) : enviarCapitulo(cap)); }
      catch (e) { alert(`Não consegui enviar o capítulo: ${e.message}\nVocê pode tentar de novo depois.`); }
      estado.envios.shift();
    }
  } finally {
    estado.enviando = null; $("envio").hidden = true;
    window.removeEventListener("beforeunload", avisoSaida);
    atualizarFila();
  }
}

function corpoGemini(cap, imagens, paginas, anterior) {
  const prompt = montarPrompt({
    capitulo: cap.titulo, numero: Number(cap.id), paginas: imagens.length,
    glossario: $("glossario").value.trim(), anterior, inicio: paginas[0] === 1, primeiraPagina: paginas[0],
  });
  return JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }, ...imagens.map((data) => ({ inline_data: { mime_type: "image/jpeg", data } }))] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 60000, responseMimeType: "application/json", responseSchema: SCHEMA },
    safetySettings: ["HARASSMENT", "HATE_SPEECH", "SEXUALLY_EXPLICIT", "DANGEROUS_CONTENT"].map((k) => ({ category: "HARM_CATEGORY_" + k, threshold: "BLOCK_NONE" })),
  });
}

async function enviarCapitulo(cap) {
  const ts = trechosDe(cap);
  const caminho = "/api/fila/" + enc(cap.arquivo);
  const info = await (await api(caminho)).json();
  const feitos = new Set([...(info.enviados || []), ...(info.prontos || [])]);
  const job = { id: cap.id, titulo: cap.titulo, paginas: cap.paginas, trechos: ts, modelos: reservas($("modelo").value), status: "enviando", criado: Date.now() };
  await api(caminho + "/job", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(job) });
  await atualizarFila();

  $("envio").hidden = false;
  $("aviso-envio").textContent = "⚠ Mantenha o site aberto só até terminar este envio. Depois pode fechar.";
  $("envio-titulo").textContent = `Capítulo ${Number(cap.id)}: baixando o PDF…`;
  $("envio-barra").style.width = "0%";
  const pdfDoc = await abrirPdf(cap, (p) => { $("envio-titulo").textContent = `Capítulo ${Number(cap.id)}: baixando o PDF… ${p}%`; });

  let n = feitos.size; const pendentes = ts.filter((t) => !feitos.has(t.ini));
  const enviosAtivos = new Set();
  for (const t of pendentes) {
    const paginas = Array.from({ length: t.fim - t.ini + 1 }, (_, k) => t.ini + k);
    $("envio-titulo").textContent = `Capítulo ${Number(cap.id)}: preparando as páginas ${t.ini}–${t.fim} de ${cap.paginas}`;
    const imagens = [];
    for (const p of paginas) {
      const c = await renderizar(pdfDoc, p, LARG_ENVIO);
      imagens.push(c.toDataURL("image/jpeg", 0.85).split(",")[1]);
      if (p === paginas[0]) { $("miniatura").src = "data:image/jpeg;base64," + imagens[0]; $("mini-pag").textContent = `pág. ${p}`; }
    }
    const corpo = corpoGemini(cap, imagens, paginas, null);
    const envio = (async () => {
      for (let tent = 1; ; tent++) {
        try {
          const r = await api(`${caminho}/req/${t.ini}`, { method: "PUT", headers: { "content-type": "application/json" }, body: corpo });
          if (r.ok) break;
          throw new Error("HTTP " + r.status);
        } catch (e) { if (tent >= 4) throw e; await esperar(3000 * tent); }
      }
      n++; $("envio-barra").style.width = `${Math.round((n / ts.length) * 100)}%`;
    })();
    enviosAtivos.add(envio); envio.finally(() => enviosAtivos.delete(envio));
    if (enviosAtivos.size >= 3) await Promise.race(enviosAtivos);
  }
  await Promise.all(enviosAtivos);
  job.status = "pronto";
  await api(caminho + "/job", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(job) });
  $("envio-titulo").textContent = `Capítulo ${Number(cap.id)} enviado ✓`;
}

// ---------- modo Google Tradutor: lê o texto do PDF, traduz e salva (com o site aberto) ----------
async function traduzirComGoogle(cap) {
  const ts = trechosDe(cap);
  const caminho = "/api/fila/" + enc(cap.arquivo);
  const job = { id: cap.id, titulo: cap.titulo, paginas: cap.paginas, trechos: ts, metodo: "google", status: "enviando", criado: Date.now() };
  await api(caminho + "/job", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(job) });
  await atualizarFila();
  $("envio").hidden = false; $("envio-barra").style.width = "0%";
  $("aviso-envio").textContent = "⚠ Mantenha o site aberto até o Google terminar este capítulo (poucos minutos).";
  const titulo = (t) => { $("envio-titulo").textContent = `Capítulo ${Number(cap.id)}: ${t}`; };
  titulo("baixando o PDF…");
  const pdfDoc = await abrirPdf(cap, (p) => titulo(`baixando o PDF… ${p}%`));
  const ingles = await extrairCapitulo(pdfDoc, async (n) => agrupar(await retangulosDeImagens(n)), (n, total) => {
    titulo(`lendo a página ${n} de ${total}`); $("envio-barra").style.width = `${Math.round((n / total) * 30)}%`;
    if (n === 1 || n % 4 === 0) renderizar(pdfDoc, n, 300).then((c) => { $("miniatura").src = c.toDataURL("image/jpeg", 0.7); $("mini-pag").textContent = `pág. ${n}`; });
  });
  const pt = await traduzirBlocosGoogle(ingles, {
    api, glossario: $("glossario").value,
    progresso: (f, total) => { titulo(`traduzindo com o Google (${f} de ${total} trechos de texto)`); $("envio-barra").style.width = `${30 + Math.round((f / total) * 60)}%`; },
  });
  // guarda por trecho de páginas, no mesmo formato do Gemini (editor e Word funcionam igual)
  titulo("salvando…");
  const porTrecho = new Map(ts.map((t) => [t.ini, []]));
  for (const b of pt) {
    const pag = b._pag || b.figura?.pagina || 1;
    const ini = Math.floor((pag - 1) / TAM) * TAM + 1;
    const { _pag, ...limpo } = b;
    (porTrecho.get(ini) || porTrecho.get(ts[ts.length - 1].ini)).push(limpo);
  }
  let n = 0;
  for (const t of ts) {
    const blocos = porTrecho.get(t.ini) || [];
    guardar.gravar(chave(cap, t.ini), blocos);
    await api(`${caminho}/res/${t.ini}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ini: t.ini, fim: t.fim, metodo: "google", blocos }) });
    $("envio-barra").style.width = `${90 + Math.round((++n / ts.length) * 10)}%`;
  }
  job.status = "pronto";
  await api(caminho + "/job", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(job) });
  await api("/api/fila/acordar", { method: "POST" }).catch(() => {}); // fecha o capítulo na hora
  titulo("pronto ✓");
  if (estado.cap?.arquivo === cap.arquivo) { await editor.apagar(cap.arquivo); atualizarCapitulo(); }
}

// ---------- PDF ----------
async function abrirPdf(cap = estado.cap, progresso) {
  if (estado.pdf && estado.pdfDe === cap.arquivo) return estado.pdf;
  const r = await api("/api/pdf/" + enc(cap.arquivo));
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || "Erro ao baixar o PDF.");
  const total = Number(r.headers.get("content-length")) || 0;
  const leitor = r.body.getReader(); const partes = []; let recebido = 0;
  for (;;) {
    const { done, value } = await leitor.read(); if (done) break;
    partes.push(value); recebido += value.length;
    if (total && progresso) progresso(Math.round((recebido / total) * 100));
  }
  const dados = new Uint8Array(recebido); let o = 0;
  for (const p of partes) { dados.set(p, o); o += p.length; }
  if (estado.pdf) estado.pdf.destroy();
  estado.pdf = await pdfjs.getDocument({ data: dados }).promise;
  estado.pdfDe = cap.arquivo;
  estado.retangulos = new Map();
  return estado.pdf;
}

async function renderizar(pdfDoc, numPag, largura) {
  if (typeof pdfDoc === "number") { largura = numPag; numPag = pdfDoc; pdfDoc = estado.pdf; } // renderizar(pag, largura)
  const pagina = await pdfDoc.getPage(numPag);
  const v1 = pagina.getViewport({ scale: 1 });
  const vp = pagina.getViewport({ scale: largura / v1.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pagina.render({ canvasContext: ctx, viewport: vp }).promise;
  pagina.cleanup();
  return canvas;
}

// Retângulos (0–1000) das imagens embutidas numa página do PDF — usados para
// recortar as figuras com precisão, em vez de confiar só na caixa do Gemini.
async function retangulosDeImagens(numPag) {
  if (estado.retangulos?.has(numPag)) return estado.retangulos.get(numPag);
  const pagina = await estado.pdf.getPage(numPag);
  const vp = pagina.getViewport({ scale: 1 });
  const ops = await pagina.getOperatorList();
  const O = pdfjs.OPS;
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0]; const pilha = []; const rets = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], a = ops.argsArray[i];
    if (fn === O.save) pilha.push(ctm);
    else if (fn === O.restore) ctm = pilha.pop() || ctm;
    else if (fn === O.transform) ctm = mul(ctm, a);
    else if (fn === O.paintFormXObjectBegin) { pilha.push(ctm); if (Array.isArray(a?.[0]) && a[0].length === 6) ctm = mul(ctm, a[0]); }
    else if (fn === O.paintFormXObjectEnd) ctm = pilha.pop() || ctm;
    else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageXObjectRepeat || fn === O.paintImageMaskXObject) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => vp.convertToViewportPoint(ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const r = [Math.min(...ys) / vp.height * 1000, Math.min(...xs) / vp.width * 1000, Math.max(...ys) / vp.height * 1000, Math.max(...xs) / vp.width * 1000].map((v) => Math.max(0, Math.min(1000, v)));
      const h = r[2] - r[0], w = r[3] - r[1];
      if (h > 30 && w > 30 && !(h > 950 && w > 950)) rets.push(r);
    }
  }
  pagina.cleanup();
  estado.retangulos.set(numPag, rets);
  return rets;
}
const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const intersec = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const uniao = (rs) => [Math.min(...rs.map((r) => r[0])), Math.min(...rs.map((r) => r[1])), Math.max(...rs.map((r) => r[2])), Math.max(...rs.map((r) => r[3]))];
function agrupar(rets) { // junta imagens vizinhas (painéis A, B, C da mesma figura)
  const g = rets.map((r) => [...r]);
  for (let mudou = true; mudou;) {
    mudou = false;
    for (let i = 0; i < g.length && !mudou; i++) for (let j = i + 1; j < g.length && !mudou; j++) {
      const a = g[i], b = g[j], f = 12;
      if (a[0] - f <= b[2] && b[0] - f <= a[2] && a[1] - f <= b[3] && b[1] - f <= a[3]) { g[i] = uniao([a, b]); g.splice(j, 1); mudou = true; }
    }
  }
  return g;
}

// Ajusta as caixas das figuras às imagens reais do PDF e acha figuras que o Gemini não marcou
async function ajustarFiguras(blocos) {
  const usados = new Map(); // pag -> grupos já usados
  const grupos = async (pag) => agrupar(await retangulosDeImagens(pag));
  for (const b of blocos) {
    if (b.tipo !== "legenda" || !b.figura?.pagina || b.figura.caixa?.length !== 4) continue;
    const gs = await grupos(b.figura.pagina);
    const cx = b.figura.caixa;
    const bons = gs.filter((g) => area(intersec(g, cx)) >= 0.4 * area(g) || area(intersec(g, cx)) >= 0.6 * area(cx));
    if (bons.length) {
      b.figura.caixa = uniao(bons).map(Math.round); b.figura.exata = true;
      usados.set(b.figura.pagina, [...(usados.get(b.figura.pagina) || []), ...bons]);
    }
  }
  for (const b of blocos) {
    if (b.tipo !== "legenda" || b.figura?.caixa?.length === 4 || b.imagemId || !b._pags) continue;
    for (const pag of b._pags) {
      // imagens ainda sem legenda, na ordem de leitura (coluna da esquerda primeiro, de cima para baixo)
      const coluna = (g) => ((g[1] + g[3]) / 2 >= 500 ? 1 : 0);
      const livres = (await grupos(pag)).filter((g) => !(usados.get(pag) || []).some((u) => area(intersec(u, g)) > 0.5 * area(g)))
        .sort((a, c) => coluna(a) - coluna(c) || a[0] - c[0]);
      if (livres.length) {
        const g = livres[0];
        b.figura = { pagina: pag, caixa: g.map(Math.round), exata: true };
        usados.set(pag, [...(usados.get(pag) || []), g]);
        break;
      }
    }
  }
  return blocos;
}

// ---------- tradução de um trecho com o site aberto (para refazer trechos com problema) ----------
async function chamarGemini(paginas, anterior) {
  const imagens = [];
  for (const p of paginas) imagens.push((await renderizar(p, LARG_ENVIO)).toDataURL("image/jpeg", 0.85).split(",")[1]);
  const corpo = corpoGemini(estado.cap, imagens, paginas, anterior);
  let modelo = estado.modeloAtivo || $("modelo").value;
  const tentados = new Set([modelo]); let sobrecargas = 0;
  const trocarModelo = (motivo) => {
    const prox = reservas($("modelo").value).find((m) => !tentados.has(m));
    if (!prox) return false;
    log(`${modelo} ${motivo}; trocando para ${prox}.`);
    modelo = prox; tentados.add(prox); estado.modeloAtivo = prox; sobrecargas = 0; return true;
  };
  for (let tent = 1; tent <= MAX_TENTATIVAS; tent++) {
    status(`Traduzindo as páginas ${paginas[0]}–${paginas[paginas.length - 1]} (${modelo})…`);
    let r, d;
    try {
      r = await api("/api/traduzir?modelo=" + enc(modelo), { method: "POST", headers: { "content-type": "application/json" }, body: corpo });
      d = await r.json().catch(() => ({ erro: `Resposta inválida do servidor (${r.status}).` }));
    } catch (e) { if (e.message === "Senha incorreta.") throw e; d = { erro: "Falha de conexão." }; r = { ok: false, status: 0 }; }
    if (r.ok) return d.blocos;
    if (d.motivo === "MAX_TOKENS" && paginas.length > 1) throw Object.assign(new Error("GRANDE"), { grande: true });
    if (r.status === 429) {
      const semCota = /limit:\s*0\b/.test(d.erro || ""), diario = /per ?day|PerDay|daily/i.test(d.erro || "");
      if (semCota || diario) { if (trocarModelo("sem limite agora")) { tent--; continue; } throw new Error("Limite do Gemini atingido em todos os modelos. Tente mais tarde."); }
      const s = Math.min(Math.max(d.esperar || 30, 10), 120) + 2;
      status(`Limite por minuto do Gemini. Esperando ${s} s…`); await esperar(s * 1000); tent--; continue;
    }
    const sobrecarga = [500, 503, 504, 524].includes(d.status) || /overload|high demand|unavailable|try again later|Erro 52\d/i.test(d.erro || "");
    if (sobrecarga) {
      sobrecargas++;
      if (sobrecargas >= 2 && trocarModelo("está com muita demanda")) continue;
      const s = Math.min(15 * 2 ** (sobrecargas - 1), 90);
      status(`O Gemini está lotado. Tentando de novo em ${s} s…`); await esperar(s * 1000); continue;
    }
    if (tent < MAX_TENTATIVAS && (r.status === 0 || r.status >= 500)) { await esperar(4000 * tent); continue; }
    throw new Error(d.erro || "Erro desconhecido.");
  }
  throw new Error("O Gemini falhou várias vezes seguidas. Tente de novo daqui a pouco.");
}
const absolutos = (blocos, paginas) => blocos.map((b) => (b.figura?.pagina ? { ...b, figura: { ...b.figura, pagina: paginas[Math.min(b.figura.pagina, paginas.length) - 1], abs: true } } : b));
async function traduzirTrechoLocal(t, anterior) {
  const paginas = Array.from({ length: t.fim - t.ini + 1 }, (_, k) => t.ini + k);
  try { return absolutos(await chamarGemini(paginas, anterior), paginas); }
  catch (e) {
    if (!e.grande) throw e;
    let todos = [];
    for (const p of paginas) {
      const bl = absolutos(await chamarGemini([p], anterior), [p]);
      const ult = [...bl].reverse().find((b) => b.tipo === "paragrafo" && b.texto); if (ult) anterior = ult.texto.slice(-300);
      todos = todos.concat(bl);
    }
    return todos;
  }
}

// ---------- capítulo aberto ----------
async function sincronizar(cap) {
  let info;
  try { info = await (await api("/api/fila/" + enc(cap.arquivo))).json(); } catch { return; }
  const erros = [];
  const faltam = (info.prontos || []).filter((ini) => !guardar.ler(chave(cap, ini)));
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < faltam.length) {
      const ini = faltam[i++];
      try {
        const d = await (await api(`/api/fila/${enc(cap.arquivo)}/res/${ini}`)).json();
        if (d.erro) erros.push({ ini: d.ini, fim: d.fim, erro: d.erro });
        else if (Array.isArray(d.blocos)) guardar.gravar(chave(cap, ini), d.blocos);
      } catch {}
    }
  }));
  estado.erros[cap.arquivo] = erros.sort((a, b) => a.ini - b.ini);
  estado.info = info;
}

async function abrirCapitulo(cap) {
  if (!cap) return;
  estado.cap = cap;
  $("cartao-cap").hidden = false;
  $("titulo-previa").textContent = `✿ Capítulo ${Number(cap.id)} — ${cap.titulo}`;
  $("log").innerHTML = ""; status("Carregando…");
  desenharCapitulos();
  $("cartao-cap").scrollIntoView({ behavior: "smooth", block: "start" });
  await sincronizar(cap);
  atualizarCapitulo();
}

function atualizarCapitulo() {
  const cap = estado.cap; if (!cap) return;
  const ts = trechosDe(cap), feitos = prontosLocais(cap), erros = estado.erros[cap.arquivo] || [];
  const s = situacao(cap);
  barra(feitos / ts.length);
  if (feitos === ts.length) status("Tradução completa! ♡ Revise abaixo e baixe o Word.");
  else if (s.tipo === "fila") status(`Traduzindo em segundo plano: ${feitos} de ${ts.length} trechos prontos. A prévia atualiza sozinha.`);
  else if (s.classe === "manual" && !feitos) status("Você marcou este capítulo como feito à mão.");
  else if (feitos) status(`${feitos} de ${ts.length} trechos prontos.`);
  else status("Ainda não traduzido. Marque-o na lista e clique em Colocar na fila.");
  $("btn-word").disabled = feitos === 0;
  $("btn-limpar").textContent = feitos || s.tipo === "fila" ? "Traduzir de novo" : "Colocar na fila";
  $("erros-cap").hidden = !erros.length;
  $("erros-cap").innerHTML = erros.map((e) => `<li>Páginas ${e.ini}–${e.fim} não foram traduzidas (${esc(e.erro)}). <button data-ini="${e.ini}" data-fim="${e.fim}">Refazer agora</button></li>`).join("");
  mostrarPrevia();
}

$("erros-cap").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-ini]"); if (!b || estado.rodando) return;
  const cap = estado.cap, t = { ini: Number(b.dataset.ini), fim: Number(b.dataset.fim) };
  estado.rodando = true; b.disabled = true;
  try {
    await abrirPdf(cap, (p) => status(`Baixando o PDF… ${p}%`));
    const blocos = await traduzirTrechoLocal(t, null);
    guardar.gravar(chave(cap, t.ini), blocos);
    await api(`/api/fila/${enc(cap.arquivo)}/res/${t.ini}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ini: t.ini, fim: t.fim, blocos }) });
    estado.erros[cap.arquivo] = (estado.erros[cap.arquivo] || []).filter((e) => e.ini !== t.ini);
    log(`Páginas ${t.ini}–${t.fim} refeitas.`, "ok");
  } catch (e) { log(e.message, "erro"); }
  estado.rodando = false; atualizarCapitulo();
});

$("btn-limpar").addEventListener("click", async () => {
  const cap = estado.cap;
  const jaTem = prontosLocais(cap) || situacao(cap).tipo === "fila";
  if (jaTem && !confirm("Apagar a tradução deste capítulo (e as suas edições) e traduzir tudo de novo?")) return;
  if (jaTem) {
    await api("/api/fila/" + enc(cap.arquivo), { method: "DELETE" });
    await api("/api/estado", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ arquivo: cap.arquivo, limpar: true }) });
    for (const t of trechosDe(cap)) guardar.apagar(chave(cap, t.ini));
    await editor.apagar(cap.arquivo);
  }
  estado.envios.push({ arquivo: cap.arquivo, metodo: metodoEscolhido() });
  atualizarCapitulo(); desenharFila(); processarEnvios();
});

// ---------- junção dos trechos ----------
const CORRIDOS = ["paragrafo", "item_lista", "quadro_item", "caixa_item"];
const rotuloFig = (t) => ((t || "").match(/^\s*Fig\.?\s*(\d+\.\d+)/) || [])[1];
function blocosDoCapitulo() {
  const cap = estado.cap; const todos = []; const figs = new Map();
  for (const t of trechosDe(cap)) {
    const bl = guardar.ler(chave(cap, t.ini));
    if (!bl) continue;
    const paginas = Array.from({ length: t.fim - t.ini + 1 }, (_, k) => t.ini + k);
    let primeiroTexto = true; // o 1º texto do trecho pode continuar o parágrafo anterior (mesmo com figuras antes)
    bl.forEach((b0) => {
      const b = { ...b0, _pags: paginas };
      // página da figura: relativa ao trecho (1, 2) → página do capítulo; traduções antigas já vinham absolutas
      if (b.figura?.pagina && !b.figura.abs && b.figura.pagina <= paginas.length) b.figura = { ...b.figura, pagina: paginas[b.figura.pagina - 1], abs: true };
      const eraPrimeiro = primeiroTexto;
      if (!["legenda", "tabela"].includes(b.tipo)) primeiroTexto = false;
      // continuação de parágrafo do trecho anterior (mesmo que haja figura no meio)
      if (eraPrimeiro && b.continua && CORRIDOS.includes(b.tipo) && b.texto) {
        let k = todos.length - 1;
        while (k >= 0 && ["legenda", "tabela"].includes(todos[k].tipo)) k--;
        if (k >= 0 && CORRIDOS.includes(todos[k].tipo)) {
          const a = todos[k].texto.trimEnd();
          todos[k].texto = a.endsWith("-") ? a + b.texto.trimStart() : a + " " + b.texto.trimStart();
          return;
        }
      }
      // legenda repetida (mesma "Fig. N.N"): fica uma só
      const rot = b.tipo === "legenda" && rotuloFig(b.texto);
      if (rot && figs.has(rot)) {
        const ex = todos[figs.get(rot)];
        if (!ex.figura?.caixa && b.figura?.caixa) { ex.figura = b.figura; ex._pags = b._pags; }
        if ((b.texto || "").length > (ex.texto || "").length) ex.texto = b.texto;
        return;
      }
      if (rot) figs.set(rot, todos.length);
      todos.push(b);
    });
  }
  return todos;
}

function capituloCompleto() {
  const cap = estado.cap;
  return prontosLocais(cap) === trechosDe(cap).length && !(estado.erros[cap.arquivo] || []).length;
}

function mostrarPrevia() {
  const bl = blocosDoCapitulo();
  const completo = !estado.rodando && capituloCompleto();
  $("dica-editor").hidden = !completo; $("btn-resetar").hidden = !completo;
  if (completo) {
    if (editor.aberto && editor.arquivo === estado.cap.arquivo) return;
    (async () => {
      try {
        status("Preparando o editor (ajustando as figuras)…");
        await abrirPdf(estado.cap, (p) => status(`Baixando o PDF para as figuras… ${p}%`));
        await ajustarFiguras(bl);
      } catch (e) { log("Não consegui ajustar as figuras: " + e.message, "erro"); }
      await editor.abrir(estado.cap.arquivo, bl.map(({ _pags, ...b }) => b));
      status("Tradução completa! ♡ Revise abaixo e baixe o Word.");
    })().catch((e) => log("Erro ao abrir o editor: " + e.message, "erro"));
    return;
  }
  editor.fechar();
  if (!bl.length) { $("previa").innerHTML = '<p class="dica">A tradução aparece aqui conforme fica pronta.</p>'; return; }
  $("previa").innerHTML = '<div class="folha leitura">' + bl.map((b) => {
    if (b.tipo === "tabela") {
      const linhas = (b.linhas || []).map((l) => `<tr>${(l.celulas || []).map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
      return `${b.titulo ? `<p class="tab-titulo">${esc(b.titulo)}</p>` : ""}<table>${linhas}</table>`;
    }
    if (b.tipo === "legenda") {
      const m = (b.texto || "").match(/^(Fig\.?\s*[\d.]+[A-Za-z]?)(.*)$/s);
      const txt = m ? `<b>${esc(m[1])}</b>${esc(m[2])}` : esc(b.texto);
      return `<p class="legenda">${b.figura ? "🖼 " : ""}${txt}</p>`;
    }
    const cls = b.tipo + (b.marcador ? " marcador" : "");
    return `<p class="${cls}">${b.destaque ? `<span class="destaque">${esc(b.destaque)}</span> ` : ""}${esc(b.texto)}</p>`;
  }).join("") + "</div>";
}

$("btn-resetar").addEventListener("click", async () => {
  if (!confirm("Descartar TODAS as edições deste capítulo e voltar para a tradução original?")) return;
  const bl = blocosDoCapitulo();
  try { await abrirPdf(estado.cap); await ajustarFiguras(bl); } catch {}
  await editor.resetar(bl.map(({ _pags, ...b }) => b));
});

// ---------- Word ----------
async function recortarFiguras(blocos) {
  const figuras = new Map();
  for (const [i, b] of blocos.entries()) {
    const c = b.figura?.caixa;
    if (b.tipo !== "legenda" || !b.figura?.pagina || c?.length !== 4) continue;
    const canvas = await renderizar(b.figura.pagina, LARG_FIGURA);
    const f = b.figura.exata ? 0 : 6;
    const [y0, x0, y1, x1] = [Math.max(0, c[0] - f), Math.max(0, c[1] - f), Math.min(1000, c[2] + f), Math.min(1000, c[3] + f)];
    const sw = ((x1 - x0) / 1000) * canvas.width, sh = ((y1 - y0) / 1000) * canvas.height;
    if (sw < 40 || sh < 40) continue;
    const c2 = document.createElement("canvas"); c2.width = Math.round(sw); c2.height = Math.round(sh);
    c2.getContext("2d").drawImage(canvas, (x0 / 1000) * canvas.width, (y0 / 1000) * canvas.height, sw, sh, 0, 0, c2.width, c2.height);
    const blob = await new Promise((r) => c2.toBlob(r, "image/jpeg", 0.9));
    figuras.set(i, { dados: new Uint8Array(await blob.arrayBuffer()), largura: c2.width, altura: c2.height });
  }
  return figuras;
}

$("btn-word").addEventListener("click", async () => {
  const btn = $("btn-word"); btn.disabled = true;
  try {
    let blocos, figuras;
    await abrirPdf(estado.cap, (p) => status(`Baixando o PDF… ${p}%`));
    if (editor.aberto && editor.arquivo === estado.cap.arquivo) {
      ({ blocos, figuras } = await editor.paraWord(LARG_FIGURA, status));
    } else {
      blocos = await ajustarFiguras(blocosDoCapitulo());
      status("Recortando as figuras…");
      figuras = await recortarFiguras(blocos);
    }
    status("Montando o Word…");
    const blob = await gerarDocx(blocos, figuras);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Cap ${Number(estado.cap.id)} - Green 8ED.docx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    status("Word baixado ♡ Bons estudos, Vivi!");
  } catch (e) {
    status("Erro ao gerar o Word: " + e.message); log(e.message, "erro");
  } finally { btn.disabled = false; }
});

// ---------- arranque ----------
editor = criarEditor({ raiz: $("previa"), obterPdf: () => abrirPdf(estado.cap), renderizar: (p, l) => renderizar(p, l), aviso: log });
if (senha()) iniciar(); else mostrarLogin();
