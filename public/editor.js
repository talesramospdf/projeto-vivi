// Editor simples do capítulo traduzido (antes de baixar o Word).
// - clicar no texto para corrigir; Enter cria parágrafo novo; Backspace num bloco vazio apaga
// - trocar o tipo do bloco, mover, inserir e apagar (com "Desfazer")
// - imagens: colar (Ctrl+V), arrastar arquivo, trocar, ajustar recorte no PDF, tamanho P/M/G
// - tabelas: editar células, adicionar/remover linhas e colunas
// Tudo fica salvo no navegador (IndexedDB), por capítulo.

export const TIPOS = {
  titulo_capitulo: "Título do capítulo",
  autores: "Autores",
  agradecimentos: "Agradecimentos (itálico)",
  secao: "Seção (azul, MAIÚSCULAS)",
  subsecao: "Subseção (verde)",
  subsubsecao: "Sub-subseção (roxo)",
  paragrafo: "Parágrafo",
  item_lista: "Item de lista",
  legenda: "Imagem + legenda",
  tabela: "Tabela",
  metodo_preferido: "Faixa laranja (Método preferido)",
  caixa_titulo: "Box cinza: título",
  caixa_item: "Box cinza: linha",
  quadro_titulo: "Quadro: PONTOS CRÍTICOS",
  quadro_subtitulo: "Quadro: procedimento",
  quadro_secao: "Quadro: seção (Indicações...)",
  quadro_item: "Quadro: item (•)",
};
const TEXTO_CORRIDO = ["paragrafo", "item_lista", "quadro_item", "caixa_item"];
const ESCALAS = { P: 0.5, M: 0.75, G: 1 };
const VERSAO_DOC = 2; // aumentar quando a montagem do capítulo mudar

// ---------- IndexedDB ----------
let _db;
function db() {
  if (_db) return _db;
  _db = new Promise((ok, erro) => {
    const r = indexedDB.open("tradutor-vivi", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("docs"); r.result.createObjectStore("imagens"); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => erro(r.error);
  });
  return _db;
}
async function dbOp(loja, modo, fn) {
  const d = await db();
  return new Promise((ok, erro) => {
    const tx = d.transaction(loja, modo);
    const req = fn(tx.objectStore(loja));
    tx.oncomplete = () => ok(req?.result);
    tx.onerror = () => erro(tx.error);
  });
}
const dbLer = (loja, k) => dbOp(loja, "readonly", (s) => s.get(k));
const dbGravar = (loja, k, v) => dbOp(loja, "readwrite", (s) => s.put(v, k));
const dbApagar = (loja, k) => dbOp(loja, "readwrite", (s) => s.delete(k));

const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
const el = (tag, props = {}, ...filhos) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const f of filhos.flat()) if (f != null) e.append(f);
  return e;
};

export function criarEditor({ raiz, obterPdf, renderizar, aviso }) {
  let arquivo = null;          // capítulo aberto
  let doc = null;              // { blocos: [...] }
  let salvarTimer = null;
  let desfazer = null;         // { bloco, pos }
  const urls = new Map();      // cache de imagens exibidas
  const paginas = new Map();   // cache de páginas renderizadas
  let observador = null;

  // ---------- salvar ----------
  function salvar() {
    clearTimeout(salvarTimer);
    salvarTimer = setTimeout(() => dbGravar("docs", arquivo, doc).catch((e) => aviso?.("Não consegui salvar a edição: " + e.message, "erro")), 400);
  }
  const indice = (id) => doc.blocos.findIndex((b) => b.id === id);

  // ---------- imagens ----------
  async function paginaRenderizada(pag) {
    if (paginas.has(pag)) return paginas.get(pag);
    await obterPdf();
    const c = await renderizar(pag, 1400);
    paginas.set(pag, c);
    if (paginas.size > 4) paginas.delete(paginas.keys().next().value);
    return c;
  }
  function cortar(canvas, caixa) {
    let [y0, x0, y1, x1] = caixa.map((v) => Math.max(0, Math.min(1000, v)));
    if (y1 <= y0 || x1 <= x0) return null;
    const sx = (x0 / 1000) * canvas.width, sy = (y0 / 1000) * canvas.height;
    const sw = ((x1 - x0) / 1000) * canvas.width, sh = ((y1 - y0) / 1000) * canvas.height;
    if (sw < 8 || sh < 8) return null;
    const c = document.createElement("canvas");
    c.width = Math.round(sw); c.height = Math.round(sh);
    c.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }
  const comFolga = (cx, f = 6) => [Math.max(0, cx[0] - f), Math.max(0, cx[1] - f), Math.min(1000, cx[2] + f), Math.min(1000, cx[3] + f)];
  const temImagem = (b) => b.imagemId || (b.figura?.pagina && b.figura?.caixa?.length === 4);

  async function urlDaImagem(b) {
    const chave = b.imagemId ? "img:" + b.imagemId : `pdf:${b.figura.pagina}:${b.figura.caixa.join(",")}`;
    if (urls.has(chave)) return urls.get(chave);
    let blob;
    if (b.imagemId) blob = await dbLer("imagens", b.imagemId);
    else {
      const c = cortar(await paginaRenderizada(b.figura.pagina), b.figura.exata ? b.figura.caixa : comFolga(b.figura.caixa));
      if (c) blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
    }
    if (!blob) return null;
    const u = URL.createObjectURL(blob);
    urls.set(chave, u);
    return u;
  }

  async function guardarArquivoDeImagem(arq) {
    if (!arq || !arq.type.startsWith("image/")) return null;
    let blob = arq;
    if (!/^image\/(png|jpe?g)$/.test(arq.type)) { // converte webp/gif/etc. para PNG (o Word aceita)
      const bmp = await createImageBitmap(arq);
      const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      blob = await new Promise((r) => c.toBlob(r, "image/png"));
    }
    const id = novoId();
    await dbGravar("imagens", id, blob);
    return id;
  }

  async function inserirImagem(arq, depoisDe) {
    const imagemId = await guardarArquivoDeImagem(arq);
    if (!imagemId) return;
    const b = { id: novoId(), tipo: "legenda", texto: "", imagemId, tamanho: "G" };
    inserir(b, depoisDe);
  }

  // ---------- estrutura ----------
  function inserir(b, depoisDe) {
    const i = depoisDe ? indice(depoisDe) : doc.blocos.length - 1;
    doc.blocos.splice(i + 1, 0, b);
    salvar();
    const ref = depoisDe ? raiz.querySelector(`.bloco[data-id="${depoisDe}"]`) : null;
    const novo = desenharBloco(b);
    if (ref) ref.after(novo); else raiz.querySelector(".folha").append(novo);
    return novo;
  }
  function apagar(id) {
    const i = indice(id); if (i < 0) return;
    const [b] = doc.blocos.splice(i, 1);
    desfazer = { bloco: b, pos: i };
    salvar();
    raiz.querySelector(`.bloco[data-id="${id}"]`)?.remove();
    mostrarDesfazer();
  }
  function mover(id, delta) {
    const i = indice(id), j = i + delta;
    if (i < 0 || j < 0 || j >= doc.blocos.length) return;
    [doc.blocos[i], doc.blocos[j]] = [doc.blocos[j], doc.blocos[i]];
    salvar();
    const no = raiz.querySelector(`.bloco[data-id="${id}"]`);
    if (delta < 0) no.previousElementSibling?.before(no); else no.nextElementSibling?.after(no);
    no.scrollIntoView({ block: "nearest" });
  }
  function redesenhar(b) {
    const velho = raiz.querySelector(`.bloco[data-id="${b.id}"]`);
    const novo = desenharBloco(b);
    velho?.replaceWith(novo);
    return novo;
  }
  function mostrarDesfazer() {
    const barra = raiz.querySelector(".aviso-desfazer");
    barra.hidden = false;
    clearTimeout(barra._t);
    barra._t = setTimeout(() => { barra.hidden = true; }, 8000);
  }

  // ---------- texto editável ----------
  function editavel(b, campo, classe, placeholder, aoEnter) {
    const e = el("div", { class: "texto " + classe, contenteditable: "plaintext-only", spellcheck: "true", "data-placeholder": placeholder || "" });
    if (e.contentEditable !== "plaintext-only") {
      e.contentEditable = "true";
      e.addEventListener("paste", (ev) => {
        if ([...(ev.clipboardData?.items || [])].some((it) => it.type.startsWith("image/"))) return;
        ev.preventDefault();
        document.execCommand("insertText", false, ev.clipboardData.getData("text/plain"));
      });
    }
    e.textContent = b[campo] || "";
    e.addEventListener("input", () => { b[campo] = e.innerText.replace(/\n$/, ""); salvar(); });
    e.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        if (aoEnter) aoEnter(e);
      }
      if (ev.key === "Backspace" && aoEnter && e.innerText.trim() === "" && doc.blocos.length > 1) {
        ev.preventDefault();
        const ant = raiz.querySelector(`.bloco[data-id="${b.id}"]`)?.previousElementSibling;
        apagar(b.id);
        focarFim(ant?.querySelector(".texto"));
      }
    });
    return e;
  }
  function posicaoCursor(e) {
    const s = getSelection(); if (!s.rangeCount) return e.innerText.length;
    const r = s.getRangeAt(0).cloneRange(); r.selectNodeContents(e); r.setEnd(s.getRangeAt(0).endContainer, s.getRangeAt(0).endOffset);
    return r.toString().length;
  }
  function focarFim(e) {
    if (!e) return; e.focus();
    const r = document.createRange(); r.selectNodeContents(e); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  // Enter: divide o texto no cursor e cria um parágrafo novo embaixo
  const dividir = (b) => (e) => {
    const t = e.innerText.replace(/\n$/, ""), p = Math.min(posicaoCursor(e), t.length);
    b.texto = t.slice(0, p).trimEnd(); e.textContent = b.texto;
    const tipo = ["item_lista", "quadro_item"].includes(b.tipo) ? b.tipo : "paragrafo";
    const novo = inserir({ id: novoId(), tipo, texto: t.slice(p).trimStart() }, b.id);
    const alvo = novo.querySelector(".texto"); alvo.focus();
    const r = document.createRange(); r.setStart(alvo, 0); r.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  };

  // ---------- ferramentas do bloco ----------
  function ferramentas(b) {
    const sel = el("select", { title: "Tipo do bloco", onchange: (ev) => {
      const novoTipo = ev.target.value;
      if (novoTipo === "tabela" && !b.linhas) { b.linhas = [{ celulas: ["", ""] }, { celulas: ["", ""] }]; b.titulo = b.texto || ""; }
      if (b.tipo === "tabela" && novoTipo !== "tabela") b.texto = b.titulo || b.texto || "";
      b.tipo = novoTipo; salvar();
      const n = redesenhar(b); n.querySelector(".texto")?.focus();
    } }, Object.entries(TIPOS).map(([v, r]) => el("option", { value: v, selected: v === b.tipo }, r)));
    const arquivoImg = el("input", { type: "file", accept: "image/*", hidden: true, onchange: async (ev) => { await inserirImagem(ev.target.files[0], b.id); ev.target.value = ""; } });
    return el("div", { class: "ferramentas", contenteditable: "false" },
      sel,
      el("button", { type: "button", title: "Subir", onclick: () => mover(b.id, -1) }, "↑"),
      el("button", { type: "button", title: "Descer", onclick: () => mover(b.id, 1) }, "↓"),
      el("button", { type: "button", title: "Novo parágrafo abaixo", onclick: () => { const n = inserir({ id: novoId(), tipo: "paragrafo", texto: "" }, b.id); n.querySelector(".texto").focus(); } }, "+ texto"),
      el("button", { type: "button", title: "Inserir imagem abaixo", onclick: () => arquivoImg.click() }, "+ imagem"),
      arquivoImg,
      el("button", { type: "button", class: "perigo", title: "Apagar bloco", onclick: () => apagar(b.id) }, "🗑"),
    );
  }

  function figuraUI(b) {
    const caixa = el("div", { class: "figura tam-" + (b.tamanho || "G") });
    const trocar = el("input", { type: "file", accept: "image/*", hidden: true, onchange: async (ev) => {
      const id = await guardarArquivoDeImagem(ev.target.files[0]); ev.target.value = "";
      if (!id) return;
      b.imagemId = id; delete b.figura; salvar(); redesenhar(b);
    } });
    const botoes = el("div", { class: "botoes-fig", contenteditable: "false" },
      el("button", { type: "button", onclick: () => trocar.click() }, temImagem(b) ? "Trocar imagem" : "Escolher imagem"),
      el("button", { type: "button", onclick: () => abrirRecorte(b) }, temImagem(b) && !b.imagemId ? "Ajustar recorte" : "Recortar do PDF"),
      temImagem(b) ? el("span", { class: "tamanhos" }, "Tamanho:",
        ...Object.keys(ESCALAS).map((t) => el("button", { type: "button", class: (b.tamanho || "G") === t ? "ativo" : "", title: { P: "Pequena", M: "Média", G: "Coluna inteira" }[t],
          onclick: () => { b.tamanho = t; salvar(); redesenhar(b); } }, t))) : null,
      temImagem(b) ? el("button", { type: "button", class: "perigo", onclick: () => { delete b.imagemId; delete b.figura; salvar(); redesenhar(b); } }, "Remover imagem") : null,
      trocar,
    );
    if (temImagem(b)) {
      const img = el("img", { alt: "Figura", draggable: "false" });
      img.dataset.carregar = "1";
      caixa.append(img);
      img._bloco = b;
      observador?.observe(img);
    } else {
      caixa.append(el("div", { class: "sem-imagem", contenteditable: "false" }, "Sem imagem. Cole com Ctrl+V, arraste um arquivo aqui ou use os botões."));
    }
    caixa.append(botoes);
    return caixa;
  }

  function tabelaUI(b) {
    b.linhas = (b.linhas || []).filter((l) => l?.celulas);
    if (!b.linhas.length) b.linhas = [{ celulas: [""] }];
    const ncol = () => Math.max(1, ...b.linhas.map((l) => l.celulas.length));
    const t = el("table");
    b.linhas.forEach((l, i) => {
      const tr = el("tr");
      for (let k = 0; k < ncol(); k++) {
        const td = el("td", { contenteditable: "plaintext-only" });
        if (td.contentEditable !== "plaintext-only") td.contentEditable = "true";
        td.textContent = l.celulas[k] || "";
        td.addEventListener("input", () => { b.linhas[i].celulas[k] = td.innerText.replace(/\n$/, ""); salvar(); });
        td.addEventListener("keydown", (ev) => { if (ev.key === "Enter") ev.preventDefault(); });
        tr.append(td);
      }
      t.append(tr);
    });
    const mudar = (fn) => () => { fn(); salvar(); redesenhar(b); };
    return el("div", { class: "tabela-edit" },
      editavel(b, "titulo", "tab-titulo", "TABELA N.N — título"),
      t,
      el("div", { class: "botoes-fig", contenteditable: "false" },
        el("button", { type: "button", onclick: mudar(() => b.linhas.push({ celulas: Array(ncol()).fill("") })) }, "+ linha"),
        el("button", { type: "button", onclick: mudar(() => b.linhas.length > 1 && b.linhas.pop()) }, "− linha"),
        el("button", { type: "button", onclick: mudar(() => { const n = ncol(); b.linhas.forEach((l) => { l.celulas.length = n; l.celulas.push(""); }); }) }, "+ coluna"),
        el("button", { type: "button", onclick: mudar(() => { const n = ncol(); if (n > 1) b.linhas.forEach((l) => { l.celulas.length = n - 1; }); }) }, "− coluna"),
      ));
  }

  function desenharBloco(b) {
    const corpo = b.tipo === "legenda"
      ? [figuraUI(b), editavel(b, "texto", "legenda", "Legenda (opcional) — ex.: Fig. 34.1 ...")]
      : b.tipo === "tabela"
        ? [tabelaUI(b)]
        : [
          b.destaque != null ? editavel(b, "destaque", "destaque", "Título embutido (laranja)") : null,
          editavel(b, "texto", b.tipo + (b.marcador ? " marcador" : ""), "Digite aqui…", dividir(b)),
        ].filter(Boolean);
    return el("div", { class: "bloco", "data-id": b.id, "data-tipo": b.tipo }, ferramentas(b), ...corpo);
  }

  // ---------- recorte no PDF ----------
  let modal;
  function criarModal() {
    modal = el("dialog", { class: "modal-recorte" });
    modal.innerHTML = `
      <div class="topo-modal">
        <strong>Arraste para marcar a figura</strong>
        <span class="nav-pag"><button type="button" data-a="ant">◀</button> Página <input type="number" min="1" class="num-pag"> de <span class="tot-pag"></span> <button type="button" data-a="prox">▶</button></span>
      </div>
      <div class="area-recorte"><div class="pagina-rec"><canvas></canvas><div class="retangulo" hidden></div></div><p class="carregando">Carregando página…</p></div>
      <div class="rodape-modal"><button type="button" data-a="cancelar">Cancelar</button><button type="button" class="primario" data-a="ok">Usar este recorte</button></div>`;
    document.body.append(modal);
  }
  async function abrirRecorte(b) {
    if (!modal) criarModal();
    const pdf = await obterPdf();
    const total = pdf.numPages;
    const anterior = (() => { // página provável: a da figura ou a da figura anterior
      if (b.figura?.pagina) return b.figura.pagina;
      for (let i = indice(b.id); i >= 0; i--) if (doc.blocos[i].figura?.pagina) return doc.blocos[i].figura.pagina;
      return 1;
    })();
    let pag = anterior, caixa = b.figura?.caixa ? [...b.figura.caixa] : null;
    const canvas = modal.querySelector("canvas"), ret = modal.querySelector(".retangulo"), area = modal.querySelector(".pagina-rec");
    const num = modal.querySelector(".num-pag"); modal.querySelector(".tot-pag").textContent = total;

    const desenharRet = () => {
      if (!caixa) { ret.hidden = true; return; }
      const [y0, x0, y1, x1] = caixa;
      Object.assign(ret.style, { left: x0 / 10 + "%", top: y0 / 10 + "%", width: (x1 - x0) / 10 + "%", height: (y1 - y0) / 10 + "%" });
      ret.hidden = false;
    };
    const carregar = async () => {
      num.value = pag;
      modal.querySelector(".carregando").hidden = false;
      const c = await paginaRenderizada(pag);
      canvas.width = c.width; canvas.height = c.height;
      canvas.getContext("2d").drawImage(c, 0, 0);
      modal.querySelector(".carregando").hidden = true;
      desenharRet();
    };
    let inicio = null;
    const ponto = (ev) => {
      const r = canvas.getBoundingClientRect();
      return [Math.max(0, Math.min(1000, ((ev.clientY - r.top) / r.height) * 1000)), Math.max(0, Math.min(1000, ((ev.clientX - r.left) / r.width) * 1000))];
    };
    area.onpointerdown = (ev) => { if (ev.button !== 0) return; area.setPointerCapture(ev.pointerId); inicio = ponto(ev); caixa = [...inicio, ...inicio]; desenharRet(); };
    area.onpointermove = (ev) => { if (!inicio) return; const [y, x] = ponto(ev); caixa = [Math.min(inicio[0], y), Math.min(inicio[1], x), Math.max(inicio[0], y), Math.max(inicio[1], x)]; desenharRet(); };
    area.onpointerup = () => { inicio = null; };
    num.onchange = () => { pag = Math.max(1, Math.min(total, Number(num.value) || 1)); caixa = null; carregar(); };
    modal.onclick = async (ev) => {
      const a = ev.target.dataset?.a; if (!a) return;
      if (a === "ant" && pag > 1) { pag--; caixa = null; carregar(); }
      if (a === "prox" && pag < total) { pag++; caixa = null; carregar(); }
      if (a === "cancelar") modal.close();
      if (a === "ok") {
        if (!caixa || caixa[2] - caixa[0] < 10 || caixa[3] - caixa[1] < 10) { alert("Arraste sobre a página para marcar a figura."); return; }
        b.figura = { pagina: pag, caixa: caixa.map(Math.round), exata: true }; delete b.imagemId;
        if (!b.tamanho) b.tamanho = "G";
        salvar(); modal.close(); redesenhar(b);
      }
    };
    modal.showModal();
    carregar();
  }

  // ---------- montar ----------
  function montar() {
    raiz.innerHTML = "";
    observador?.disconnect();
    observador = new IntersectionObserver((ents) => {
      for (const en of ents) {
        if (!en.isIntersecting) continue;
        const img = en.target; observador.unobserve(img);
        urlDaImagem(img._bloco).then((u) => { if (u) img.src = u; else img.alt = "Não consegui recortar esta figura"; })
          .catch(() => { img.alt = "Erro ao carregar a figura"; });
      }
    }, { root: null, rootMargin: "400px" });

    const folha = el("div", { class: "folha" });
    const barra = el("div", { class: "aviso-desfazer", hidden: true },
      "Bloco apagado. ",
      el("button", { type: "button", onclick: () => {
        if (!desfazer) return;
        doc.blocos.splice(desfazer.pos, 0, desfazer.bloco); salvar();
        const prox = doc.blocos[desfazer.pos + 1];
        const novo = desenharBloco(desfazer.bloco);
        const ref = prox ? raiz.querySelector(`.bloco[data-id="${prox.id}"]`) : null;
        if (ref) ref.before(novo); else folha.append(novo);
        desfazer = null; barra.hidden = true;
      } }, "Desfazer"));
    raiz.append(barra, folha);
    for (const b of doc.blocos) folha.append(desenharBloco(b));

    // colar imagem (Ctrl+V) e arrastar arquivos
    raiz.onpaste = async (ev) => {
      const item = [...(ev.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
      if (!item) return;
      ev.preventDefault();
      const bloco = ev.target.closest?.(".bloco");
      const b = bloco ? doc.blocos[indice(bloco.dataset.id)] : null;
      if (b && b.tipo === "legenda" && !temImagem(b)) { // bloco de imagem vazio: preenche ele
        b.imagemId = await guardarArquivoDeImagem(item.getAsFile()); b.tamanho = b.tamanho || "G"; salvar(); redesenhar(b);
      } else await inserirImagem(item.getAsFile(), bloco?.dataset.id);
    };
    raiz.ondragover = (ev) => { if ([...ev.dataTransfer.items].some((i) => i.kind === "file")) { ev.preventDefault(); raiz.classList.add("soltando"); } };
    raiz.ondragleave = () => raiz.classList.remove("soltando");
    raiz.ondrop = async (ev) => {
      raiz.classList.remove("soltando");
      const arqs = [...ev.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
      if (!arqs.length) return;
      ev.preventDefault();
      let depois = ev.target.closest?.(".bloco")?.dataset.id;
      for (const f of arqs) {
        const b = depois ? doc.blocos[indice(depois)] : null;
        if (b && b.tipo === "legenda" && !temImagem(b)) { b.imagemId = await guardarArquivoDeImagem(f); b.tamanho = "G"; salvar(); redesenhar(b); continue; }
        await inserirImagem(f, depois);
        depois = doc.blocos[(depois ? indice(depois) : doc.blocos.length - 2) + 1]?.id;
      }
    };
  }

  function limparCache() {
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear(); paginas.clear();
  }

  return {
    get aberto() { return !!arquivo; },
    get arquivo() { return arquivo; },

    // abre o editor do capítulo; usa as edições salvas, ou cria a partir da tradução
    async abrir(arq, blocosTraduzidos) {
      if (arquivo === arq && doc) return;
      limparCache();
      arquivo = arq;
      doc = await dbLer("docs", arq).catch(() => null);
      if (doc && (doc.versao || 1) < VERSAO_DOC) doc = null; // documento de uma versão antiga do site: refaz com as melhorias
      if (!doc) {
        doc = { versao: VERSAO_DOC, blocos: blocosTraduzidos.map((b) => ({ ...b, id: novoId(), tamanho: "G" })) };
        await dbGravar("docs", arq, doc);
      }
      if (arquivo !== arq) return; // trocou de capítulo enquanto carregava
      montar();
    },

    fechar() { arquivo = null; doc = null; observador?.disconnect(); limparCache(); },

    // descarta as edições e volta para a tradução original
    async resetar(blocosTraduzidos) {
      const arq = arquivo;
      await this.apagar(arq);
      await this.abrir(arq, blocosTraduzidos);
    },

    async apagar(arq) {
      const d = await dbLer("docs", arq).catch(() => null);
      for (const b of d?.blocos || []) if (b.imagemId) await dbApagar("imagens", b.imagemId).catch(() => {});
      await dbApagar("docs", arq).catch(() => {});
      if (arquivo === arq) this.fechar();
    },

    // blocos + figuras prontos para o word.js
    async paraWord(largura, progresso) {
      clearTimeout(salvarTimer); await dbGravar("docs", arquivo, doc);
      const blocos = doc.blocos.map((b) => ({ ...b }));
      const figuras = new Map();
      const pendentes = blocos.map((b, i) => [b, i]).filter(([b]) => b.tipo === "legenda" && temImagem(b));
      let n = 0;
      const cachePag = new Map();
      for (const [b, i] of pendentes) {
        progresso?.(`Preparando imagens… (${++n}/${pendentes.length})`);
        let blob, tipo = "jpg";
        if (b.imagemId) {
          blob = await dbLer("imagens", b.imagemId);
          if (!blob) continue;
          tipo = blob.type === "image/png" ? "png" : "jpg";
        } else {
          if (!cachePag.has(b.figura.pagina)) { cachePag.clear(); await obterPdf(); cachePag.set(b.figura.pagina, await renderizar(b.figura.pagina, largura)); }
          const c = cortar(cachePag.get(b.figura.pagina), b.figura.exata ? b.figura.caixa : comFolga(b.figura.caixa));
          if (!c) continue;
          blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
        }
        const bmp = await createImageBitmap(blob);
        figuras.set(i, { dados: new Uint8Array(await blob.arrayBuffer()), largura: bmp.width, altura: bmp.height, tipo, escala: ESCALAS[b.tamanho || "G"] });
        bmp.close?.();
      }
      return { blocos, figuras };
    },
  };
}
