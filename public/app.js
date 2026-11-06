import * as pdfjs from "./vendor/pdf.min.js";
import { gerarDocx } from "./word.js";
import { SCHEMA, montarPrompt } from "./prompt.js";
import { criarEditor } from "./editor.js";

pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.js";

const $ = (id) => document.getElementById(id);
const LARG_ENVIO = 1600;   // largura (px) das imagens das páginas enviadas ao Gemini
const LARG_FIGURA = 2200;  // largura (px) usada para recortar as figuras do Word
const MAX_TENTATIVAS = 10;

const estado = { caps: [], cap: null, pdf: null, pdfDe: null, rodando: false, parar: false };
let editor; // criado depois que as funções abaixo existem

// ---------- utilidades ----------
const guardar = {
  ler(k, padrao = null) { try { const v = localStorage.getItem(k); return v == null ? padrao : JSON.parse(v); } catch { return padrao; } },
  gravar(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  apagar(k) { try { localStorage.removeItem(k); } catch {} },
};
const senha = () => guardar.ler("senha", "");
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(caminho, opcoes = {}) {
  const r = await fetch(caminho, { ...opcoes, headers: { ...(opcoes.headers || {}), "x-senha": senha() } });
  if (r.status === 401) { mostrarLogin("Senha incorreta."); throw new Error("Senha incorreta."); }
  return r;
}

function log(msg, classe = "") {
  const li = document.createElement("li");
  li.textContent = msg;
  if (classe) li.className = classe;
  $("log").appendChild(li);
  $("log").scrollTop = $("log").scrollHeight;
}
const status = (msg) => { $("status").textContent = msg; };
const barra = (f) => { $("barra").style.width = `${Math.round(f * 100)}%`; };

// ---------- login ----------
function mostrarLogin(erro) {
  $("tela-app").hidden = true; $("sair").hidden = true; $("tela-login").hidden = false;
  $("erro-login").hidden = !erro; $("erro-login").textContent = erro || "";
}
$("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  guardar.gravar("senha", $("senha").value);
  iniciar();
});
$("sair").addEventListener("click", () => { guardar.apagar("senha"); mostrarLogin(); });

// ---------- início ----------
async function iniciar() {
  try {
    const r = await api("/api/capitulos");
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro || "Erro ao carregar capítulos.");
    estado.caps = d;
  } catch (e) {
    if (e.message !== "Senha incorreta.") { mostrarLogin(); $("erro-login").hidden = false; $("erro-login").textContent = e.message; }
    return;
  }
  $("tela-login").hidden = true; $("tela-app").hidden = false; $("sair").hidden = false;

  $("capitulo").innerHTML = estado.caps.map((c, i) =>
    `<option value="${i}">${Number(c.id)} — ${c.titulo} (${c.paginas} pág.)</option>`).join("");
  const ultimo = guardar.ler("ultimoCap", 0);
  $("capitulo").value = String(Math.min(ultimo, estado.caps.length - 1));
  $("tam").value = String(guardar.ler("tam", 2));
  trocarCapitulo();
  carregarModelos();
  carregarGlossario();
}

async function carregarModelos() {
  const sel = $("modelo");
  try {
    const r = await api("/api/modelos"); const d = await r.json();
    if (!r.ok) throw new Error(d.erro);
    const lista = d.modelos;
    estado.modelos = lista;
    const salvo = guardar.ler("modelo", null);
    const sugestao = d.padrao && lista.includes(d.padrao) ? d.padrao : escolherPadrao(lista);
    sel.innerHTML = lista.map((m) => `<option>${m}</option>`).join("");
    sel.value = salvo && lista.includes(salvo) ? salvo : sugestao;
  } catch (e) {
    sel.innerHTML = `<option>gemini-2.5-flash</option>`;
    log(`Não consegui listar os modelos (${e.message}). Verifique a GEMINI_API_KEY.`, "erro");
  }
}
// prefere o "flash" mais novo (não "lite"), que é o que o plano grátis mais libera
function escolherPadrao(lista) {
  const versao = (n) => parseFloat((n.match(/gemini-(\d+(\.\d+)?)/) || [])[1] || 0);
  const flash = lista.filter((n) => /flash/.test(n) && !/lite|preview|thinking/.test(n));
  const pool = flash.length ? flash : lista;
  return pool.sort((a, b) => versao(b) - versao(a) || a.length - b.length)[0];
}
$("modelo").addEventListener("change", () => { guardar.gravar("modelo", $("modelo").value); estado.modeloAtivo = null; });
$("tam").addEventListener("change", () => { guardar.gravar("tam", Number($("tam").value)); atualizarResumo(); });

// ---------- glossário ----------
async function carregarGlossario() {
  try { const r = await api("/api/glossario"); $("glossario").value = await r.text(); } catch {}
}
$("btn-glossario").addEventListener("click", async () => {
  const r = await api("/api/glossario", { method: "PUT", body: $("glossario").value });
  $("ok-glossario").textContent = r.ok ? "Salvo ✓" : "Erro ao salvar";
  setTimeout(() => ($("ok-glossario").textContent = ""), 2500);
});

// ---------- capítulo / cache ----------
const chave = (cap, tam, ini) => `trad:${cap.arquivo}:${tam}:${ini}`;

function trechos() {
  const cap = estado.cap, tam = Number($("tam").value);
  const total = cap.paginas;
  let a = Number($("pag-ini").value) || 1, b = Number($("pag-fim").value) || total;
  a = Math.max(1, Math.min(a, total)); b = Math.max(a, Math.min(b, total));
  const lista = [];
  for (let p = a; p <= b; p += tam) lista.push({ ini: p, fim: Math.min(p + tam - 1, b), tam });
  return lista;
}

function trocarCapitulo() {
  estado.cap = estado.caps[Number($("capitulo").value)];
  guardar.gravar("ultimoCap", Number($("capitulo").value));
  $("pag-ini").value = ""; $("pag-fim").value = "";
  $("log").innerHTML = "";
  atualizarResumo();
}
$("capitulo").addEventListener("change", trocarCapitulo);
$("pag-ini").addEventListener("change", atualizarResumo);
$("pag-fim").addEventListener("change", atualizarResumo);

function atualizarResumo() {
  const cap = estado.cap; if (!cap) return;
  const ts = trechos();
  const feitos = ts.filter((t) => guardar.ler(chave(cap, t.tam, t.ini))).length;
  $("info-cap").textContent = `${cap.paginas} páginas · ${cap.tamanho_mb} MB · ${ts.length} envios ao Gemini`;
  barra(feitos / ts.length);
  if (feitos === ts.length) status("Tradução completa! ♡ Agora é só baixar o Word.");
  else if (feitos) status(`${feitos} de ${ts.length} trechos prontos. Clique em Traduzir para continuar.`);
  else status("Pronto para traduzir.");
  $("btn-traduzir").textContent = feitos && feitos < ts.length ? "Continuar" : "Traduzir";
  $("btn-word").disabled = feitos === 0;
  mostrarPrevia();
}

$("btn-limpar").addEventListener("click", async () => {
  if (!confirm("Apagar a tradução salva deste capítulo (e as edições) e começar do zero?")) return;
  await editor.apagar(estado.cap.arquivo);
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(`trad:${estado.cap.arquivo}:`)) localStorage.removeItem(k);
  }
  $("log").innerHTML = "";
  atualizarResumo();
});

// ---------- PDF ----------
async function abrirPdf() {
  const cap = estado.cap;
  if (estado.pdf && estado.pdfDe === cap.arquivo) return estado.pdf;
  status(`Baixando o PDF do capítulo (${cap.tamanho_mb} MB)…`);
  const r = await api("/api/pdf/" + encodeURIComponent(cap.arquivo));
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || "Erro ao baixar o PDF.");
  const total = Number(r.headers.get("content-length")) || 0;
  const leitor = r.body.getReader(); const partes = []; let recebido = 0;
  for (;;) {
    const { done, value } = await leitor.read(); if (done) break;
    partes.push(value); recebido += value.length;
    if (total) status(`Baixando o PDF do capítulo… ${Math.round((recebido / total) * 100)}%`);
  }
  const dados = new Uint8Array(recebido); let o = 0;
  for (const p of partes) { dados.set(p, o); o += p.length; }
  if (estado.pdf) estado.pdf.destroy();
  estado.pdf = await pdfjs.getDocument({ data: dados }).promise;
  estado.pdfDe = cap.arquivo;
  return estado.pdf;
}

async function renderizar(numPag, largura) {
  const pagina = await estado.pdf.getPage(numPag);
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

// ---------- tradução ----------
function ultimoTexto(cap, lista, idx) {
  for (let i = idx - 1; i >= 0; i--) {
    const bl = guardar.ler(chave(cap, lista[i].tam, lista[i].ini));
    if (!bl) return "";
    const t = [...bl].reverse().find((b) => ["paragrafo", "item_lista", "quadro_item"].includes(b.tipo) && b.texto);
    if (t) return t.texto.slice(-300);
  }
  return "";
}

async function chamarGemini(paginas, anterior) {
  const imagens = [];
  for (const p of paginas) {
    const c = await renderizar(p, LARG_ENVIO);
    imagens.push(c.toDataURL("image/jpeg", 0.85).split(",")[1]);
  }
  const prompt = montarPrompt({
    capitulo: estado.cap.titulo, numero: Number(estado.cap.id), paginas: imagens.length,
    glossario: $("glossario").value.trim(), anterior,
  });
  const corpo = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }, ...imagens.map((data) => ({ inline_data: { mime_type: "image/jpeg", data } }))] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 60000, responseMimeType: "application/json", responseSchema: SCHEMA },
    safetySettings: ["HARASSMENT", "HATE_SPEECH", "SEXUALLY_EXPLICIT", "DANGEROUS_CONTENT"].map((k) => ({ category: "HARM_CATEGORY_" + k, threshold: "BLOCK_NONE" })),
  });
  let modelo = estado.modeloAtivo || $("modelo").value;
  const tentados = new Set([modelo]);
  let sobrecargas = 0;
  // troca para o próximo modelo da lista de reserva (se houver)
  const trocarModelo = (motivo) => {
    const prox = reservas($("modelo").value).find((m) => !tentados.has(m));
    if (!prox) return false;
    log(`${modelo} ${motivo}; trocando para ${prox}.`);
    modelo = prox; tentados.add(prox); estado.modeloAtivo = prox; sobrecargas = 0;
    return true;
  };
  for (let tent = 1; tent <= MAX_TENTATIVAS; tent++) {
    if (estado.parar) throw new Error("PAUSADO");
    const rota = "/api/traduzir?modelo=" + encodeURIComponent(modelo);
    let r, d;
    try {
      r = await api(rota, { method: "POST", headers: { "content-type": "application/json" }, body: corpo });
      d = await r.json().catch(() => ({ erro: `Resposta inválida do servidor (${r.status}).` }));
    } catch (e) {
      if (e.message === "Senha incorreta.") throw e;
      d = { erro: "Falha de conexão." }; r = { ok: false, status: 0 };
    }
    if (r.ok) return d.blocos;

    // Resposta grande demais: o chamador divide em páginas avulsas
    if (d.motivo === "MAX_TOKENS" && paginas.length > 1) throw Object.assign(new Error("GRANDE"), { grande: true });
    if (r.status === 429) {
      const semCota = /limit:\s*0\b/.test(d.erro || "");
      const diario = /per ?day|PerDay|daily/i.test(d.erro || "");
      if (semCota || diario) {
        if (trocarModelo(semCota ? "não está liberado no plano grátis" : "atingiu o limite de hoje")) { tent--; continue; }
        throw new Error(diario
          ? "Limite diário do Gemini atingido em todos os modelos. Continue amanhã (o progresso fica salvo)."
          : `Nenhum modelo liberado no plano grátis. (${d.erro})`);
      }
      const s = Math.min(Math.max(d.esperar || 30, 10), 120) + 2;
      log(`Limite por minuto do Gemini. Esperando ${Math.round(s)} s…`);
      status(`Aguardando o limite do Gemini (${Math.round(s)} s)…`);
      await esperar(s * 1000);
      tent--; // esperar o limite por minuto não conta como falha
      continue;
    }
    // "muita demanda" / sobrecarga do Google: espera cada vez mais e, depois de 2 seguidas, troca de modelo
    const sobrecarga = [500, 503, 504, 524].includes(d.status) || /overload|high demand|unavailable|try again later|Erro 52\d/i.test(d.erro || "");
    if (sobrecarga) {
      sobrecargas++;
      if (sobrecargas >= 2 && trocarModelo("está com muita demanda")) { continue; }
      const s = Math.min(15 * 2 ** (sobrecargas - 1), 90);
      log(`Gemini com muita demanda. Tentando de novo em ${s} s…`);
      status(`Gemini ocupado, aguardando ${s} s…`);
      await esperar(s * 1000);
      continue;
    }
    if (tent < MAX_TENTATIVAS && (r.status === 0 || r.status >= 500)) {
      log(`Tentativa ${tent} falhou (${d.erro}). Tentando de novo…`);
      await esperar(4000 * tent);
      continue;
    }
    throw new Error(d.erro || "Erro desconhecido.");
  }
  throw new Error("O Gemini falhou várias vezes seguidas. Clique em Continuar daqui a pouco (o progresso fica salvo).");
}

// ordem de reserva: o escolhido, depois os "flash" mais novos, depois os "flash-lite"
function reservas(escolhido) {
  const lista = estado.modelos || [];
  const versao = (n) => parseFloat((n.match(/gemini-(\d+(\.\d+)?)/) || [])[1] || 0);
  const ordem = (f) => lista.filter(f).sort((a, b) => versao(b) - versao(a) || a.length - b.length);
  const flash = ordem((n) => /flash/.test(n) && !/lite/.test(n) && !/preview|thinking/.test(n));
  const lite = ordem((n) => /flash-lite/.test(n) && !/preview/.test(n));
  return [...new Set([escolhido, ...flash, ...lite])];
}

// converte a página da figura (1 = primeira imagem enviada) para a página do PDF
function absolutizar(blocos, paginas) {
  for (const b of blocos) {
    if (b.figura && b.figura.pagina) b.figura.pagina = paginas[Math.min(b.figura.pagina, paginas.length) - 1];
  }
  return blocos;
}

async function traduzirTrecho(t, anterior) {
  const paginas = Array.from({ length: t.fim - t.ini + 1 }, (_, k) => t.ini + k);
  try {
    return absolutizar(await chamarGemini(paginas, anterior), paginas);
  } catch (e) {
    if (!e.grande) throw e;
    log(`Páginas ${t.ini}–${t.fim} grandes demais juntas; enviando uma por vez.`);
    let todos = [];
    for (const p of paginas) {
      const bl = absolutizar(await chamarGemini([p], anterior), [p]);
      const ult = [...bl].reverse().find((b) => b.tipo === "paragrafo" && b.texto);
      if (ult) anterior = ult.texto.slice(-300);
      todos = todos.concat(bl);
    }
    return todos;
  }
}

$("btn-traduzir").addEventListener("click", async () => {
  if (estado.rodando) return;
  estado.rodando = true; estado.parar = false;
  $("btn-traduzir").disabled = true; $("btn-parar").hidden = false; $("capitulo").disabled = true;
  const cap = estado.cap, lista = trechos();
  try {
    await abrirPdf();
    for (let i = 0; i < lista.length; i++) {
      const t = lista[i], k = chave(cap, t.tam, t.ini);
      if (guardar.ler(k)) continue;
      if (estado.parar) throw new Error("PAUSADO");
      status(`Traduzindo páginas ${t.ini}–${t.fim} de ${cap.paginas}…`);
      const blocos = await traduzirTrecho(t, ultimoTexto(cap, lista, i));
      if (!guardar.gravar(k, blocos)) throw new Error("O navegador ficou sem espaço para salvar. Clique em 'Recomeçar capítulo' em capítulos antigos já baixados.");
      log(`Páginas ${t.ini}–${t.fim} traduzidas (${blocos.length} blocos).`, "ok");
      barra((i + 1) / lista.length);
      mostrarPrevia();
    }
    status("Tradução completa! ♡ Agora é só baixar o Word.");
    log("Capítulo concluído.", "ok");
  } catch (e) {
    if (e.message === "PAUSADO") { status("Pausado. Clique em Continuar quando quiser."); log("Pausado."); }
    else { status("Parou: " + e.message); log(e.message, "erro"); }
  } finally {
    estado.rodando = false;
    $("btn-traduzir").disabled = false; $("btn-parar").hidden = true; $("capitulo").disabled = false;
    atualizarResumo();
  }
});
$("btn-parar").addEventListener("click", () => { estado.parar = true; status("Pausando após o trecho atual…"); });

// ---------- junção e prévia ----------
const CORRIDOS = ["paragrafo", "item_lista", "quadro_item"];
function blocosDoCapitulo() {
  const cap = estado.cap; const todos = [];
  for (const t of trechos()) {
    const bl = guardar.ler(chave(cap, t.tam, t.ini));
    if (!bl) continue;
    bl.forEach((b, j) => {
      const ant = todos[todos.length - 1];
      if (j === 0 && b.continua && ant && CORRIDOS.includes(ant.tipo) && CORRIDOS.includes(b.tipo) && b.texto) {
        const a = ant.texto.trimEnd();
        ant.texto = a.endsWith("-") ? a + b.texto.trimStart() : a + " " + b.texto.trimStart();
      } else {
        todos.push({ ...b });
      }
    });
  }
  return todos;
}

const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function capituloCompleto() {
  if ($("pag-ini").value || $("pag-fim").value) return false;
  const ts = trechos();
  return ts.length > 0 && ts.every((t) => guardar.ler(chave(estado.cap, t.tam, t.ini)));
}

function mostrarPrevia() {
  const bl = blocosDoCapitulo();
  const completo = !estado.rodando && capituloCompleto();
  $("titulo-previa").textContent = completo ? "✿ Editor do capítulo" : "✿ Prévia da tradução";
  $("dica-editor").hidden = !completo; $("btn-resetar").hidden = !completo;
  if (completo) { editor.abrir(estado.cap.arquivo, bl).catch((e) => log("Erro ao abrir o editor: " + e.message, "erro")); return; }
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
    return `<p class="${b.tipo}">${esc(b.texto)}</p>`;
  }).join("") + "</div>";
}

$("btn-resetar").addEventListener("click", async () => {
  if (!confirm("Descartar TODAS as edições deste capítulo e voltar para a tradução original?")) return;
  await editor.resetar(blocosDoCapitulo());
});

// ---------- Word ----------
async function recortarFiguras(blocos) {
  const figuras = new Map();
  const porPagina = new Map();
  blocos.forEach((b, i) => {
    const c = b.figura?.caixa;
    if (b.tipo === "legenda" && b.figura?.pagina && Array.isArray(c) && c.length === 4) {
      if (!porPagina.has(b.figura.pagina)) porPagina.set(b.figura.pagina, []);
      porPagina.get(b.figura.pagina).push(i);
    }
  });
  let n = 0;
  for (const [pag, idxs] of porPagina) {
    status(`Recortando figuras… (${++n}/${porPagina.size} páginas)`);
    const canvas = await renderizar(pag, LARG_FIGURA);
    for (const i of idxs) {
      let [y0, x0, y1, x1] = blocos[i].figura.caixa.map((v) => Math.max(0, Math.min(1000, v)));
      if (y1 <= y0 || x1 <= x0) continue;
      const pad = 6; y0 = Math.max(0, y0 - pad); x0 = Math.max(0, x0 - pad); y1 = Math.min(1000, y1 + pad); x1 = Math.min(1000, x1 + pad);
      const sx = (x0 / 1000) * canvas.width, sy = (y0 / 1000) * canvas.height;
      const sw = ((x1 - x0) / 1000) * canvas.width, sh = ((y1 - y0) / 1000) * canvas.height;
      if (sw < 40 || sh < 40) continue;
      const c2 = document.createElement("canvas");
      c2.width = Math.round(sw); c2.height = Math.round(sh);
      c2.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, c2.width, c2.height);
      const blob = await new Promise((r) => c2.toBlob(r, "image/jpeg", 0.9));
      figuras.set(i, { dados: new Uint8Array(await blob.arrayBuffer()), largura: c2.width, altura: c2.height });
    }
  }
  return figuras;
}

$("btn-word").addEventListener("click", async () => {
  const btn = $("btn-word"); btn.disabled = true;
  try {
    let blocos, figuras;
    if (editor.aberto && editor.arquivo === estado.cap.arquivo) {
      ({ blocos, figuras } = await editor.paraWord(LARG_FIGURA, status));
    } else {
      blocos = blocosDoCapitulo();
      await abrirPdf();
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
editor = criarEditor({ raiz: $("previa"), obterPdf: abrirPdf, renderizar, aviso: log });
if (senha()) iniciar(); else mostrarLogin();
