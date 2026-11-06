// Lê o texto do capítulo direto do PDF e reconstrói a estrutura (para o modo Google Tradutor).
// O livro usa uma fonte/tamanho diferente para cada elemento, então a estrutura sai da fonte:
//   Univers-Light 21 ............ título            Univers-CondensedOblique 13 .. autores
//   Univers-CondensedBold 12 .... SEÇÃO / subseção   Univers-CondensedBold 11/10 ... subseção / sub-subseção
//   MinionPro 9 ................. texto             MinionPro-Bold / CondensedBoldObl no início .. título embutido
//   Univers-Bold/Light 8 ........ legenda           Univers-Extended .............. TABLE / BOX
//   Univers-Bold 11 "CRITICAL POINTS", Univers-BoldOblique 10 (procedimento), Univers-Bold 8,5 (Indicações…)
//   MinionPro 6,3 (citações) e 8 (referências), cabeçalhos, nº de página e rótulos de figura são descartados.

const fam = (nome) => (nome || "").replace(/^[A-Z]{6}\+/, "");
const limpar = (s) => s.replace(/-­/g, "‑").replace(/­/g, "").replace(/[\x07\t  ]+/g, " ").replace(/\s+/g, " ");

async function itensDaPagina(pdf, n) {
  const pagina = await pdf.getPage(n);
  await pagina.getOperatorList(); // carrega as fontes (para saber o nome real)
  const tc = await pagina.getTextContent();
  const vp = pagina.getViewport({ scale: 1 });
  const nomes = {};
  const itens = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim() && !it.hasEOL) { if (!it.str) continue; }
    if (!(it.fontName in nomes)) { try { nomes[it.fontName] = fam(pagina.commonObjs.get(it.fontName).name); } catch { nomes[it.fontName] = ""; } }
    const t = it.transform;
    const tam = Math.round(Math.hypot(t[2], t[3]) * 10) / 10;
    itens.push({ s: it.str, f: nomes[it.fontName], tam, x: t[4], y: vp.height - t[5], w: it.width, pag: n });
  }
  pagina.cleanup();
  return { itens, larg: vp.width, alt: vp.height };
}

function descartar(it, larg, alt, imagens) {
  if (!it.s.trim()) return true;
  if (/^[†‡*]?\s*Deceased\.?$/.test(it.s.trim()) || /^[†‡]$/.test(it.s.trim())) return true; // nota de rodapé dos autores
  if (/^(Helvetica|Arial)/.test(it.f)) return true;            // rótulos dentro de desenhos
  if (it.tam > 30) return true;                                  // número grande do capítulo
  if (it.y < 40 || it.y > alt - 38) return true;                 // cabeçalho e nº de página
  const nx = (it.x / larg) * 1000, ny = (it.y / alt) * 1000;
  if (imagens.some((r) => ny > r[0] + 2 && ny < r[2] - 2 && nx > r[1] + 2 && nx < r[3] - 2)) return true; // texto dentro de figura
  return false;
}

// classifica uma linha pela fonte do primeiro trecho
function classe(l) {
  const { f, tam } = l;
  if (/^Univers-Light$/.test(f) && tam >= 18) return "titulo";
  if (/^Univers-CondensedOblique/.test(f) && tam >= 12) return "autores";
  if (/^Univers-CondensedBold$/.test(f) && tam >= 11.5) return "h12";
  if (/^Univers-CondensedBold$/.test(f) && tam >= 10.5) return "subsecao";
  if (/^Univers-CondensedBold$/.test(f) && tam >= 9.5) return "subsubsecao";
  if (/^Univers-Extended/.test(f)) return "tab_titulo";
  if (/^Univers-Bold$/.test(f) && tam >= 10.5) return "quadro_ou_caixa";
  if (/^Univers-BoldOblique/.test(f)) return "quadro_subtitulo";
  if (/^Univers-Bold$/.test(f) && tam >= 8.3) return "rotulo85";
  if (/^Univers/.test(f) && tam < 8.3) return "legenda";
  if (/^Univers.*Light/.test(f) && tam >= 8.3 && tam < 9) return "pequeno85";
  if (/^MinionPro/.test(f) && tam < 8.6) return "ref";
  return "texto";
}

const ehRunIn = (f) => /^MinionPro-Bold$/.test(f) || /CondensedBoldObl/.test(f);

// junta os trechos de uma linha, recolocando os espaços (o PDF guarda só a posição das palavras)
function juntarItens(itens) {
  let out = ""; let ant = null;
  for (const it of itens) {
    if (ant) {
      const lacuna = it.x - (ant.x + ant.w);
      const aposHifen = /[-‑­]$/.test(out) && lacuna < Math.min(ant.tam, it.tam) * 0.6; // "C5-" + "C6"
      if (lacuna > Math.min(ant.tam, it.tam) * 0.12 && !aposHifen && !/\s$/.test(out) && !/^\s/.test(it.s)) out += " ";
    }
    out += it.s; ant = it;
  }
  return out;
}

// monta as linhas de uma coluna a partir dos trechos
function linhas(itens) {
  itens.sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const it of itens) {
    const l = out[out.length - 1];
    if (l && Math.abs(l.y - it.y) < 2.5) { l.itens.push(it); continue; }
    out.push({ y: it.y, itens: [it] });
  }
  for (const l of out) {
    // números de citação (pequenos e acima da linha) saem; subscritos (T1, T2…) ficam
    const maior = Math.max(...l.itens.map((i) => i.tam));
    const base = Math.max(...l.itens.filter((i) => i.tam === maior).map((i) => i.y));
    if (l.itens.some((i) => i.tam >= maior * 0.85)) l.itens = l.itens.filter((i) => i.tam >= maior * 0.85 || i.y > base - 0.8);
    l.itens.sort((a, b) => a.x - b.x);
    // a fonte da linha é a da primeira palavra (o "•" e os números usam outras fontes)
    const prim = l.itens.find((i) => /[A-Za-zÀ-ÿ]/.test(i.s)) || l.itens.find((i) => i.s.trim()) || l.itens[0];
    l.f = prim.f; l.tam = prim.tam; l.x = prim.x; l.pag = prim.pag;
    l.texto = limpar(juntarItens(l.itens)).trim();
    // título embutido em negrito no começo da linha ("Contraindications. ...") — só se houver texto normal depois
    const runIn = []; let k = 0;
    for (; k < l.itens.length; k++) { const i = l.itens[k]; if (ehRunIn(i.f)) runIn.push(i); else if (i.s.trim()) break; }
    const temResto = l.itens.slice(k).some((i) => i.s.trim());
    l.runIn = runIn.length && temResto ? limpar(juntarItens(runIn)).trim() : "";
    l.runInFonte = runIn.length ? l.f : "";
  }
  return out;
}

// tabela: junta trechos por linha (y) e separa colunas por espaço em x
function montarTabela(itens) {
  itens.sort((a, b) => a.y - b.y || a.x - b.x);
  const linhasT = [];
  for (const it of itens) {
    const l = linhasT[linhasT.length - 1];
    if (l && Math.abs(l.y - it.y) < 3) l.itens.push(it); else linhasT.push({ y: it.y, itens: [it] });
  }
  // colunas: bordas esquerdas mais frequentes
  const xs = [];
  for (const l of linhasT) for (const it of l.itens) if (it.s.trim()) xs.push(Math.round(it.x));
  xs.sort((a, b) => a - b);
  const cols = [];
  for (const x of xs) if (!cols.length || x - cols[cols.length - 1] > 25) cols.push(x);
  const colDe = (x) => { let k = 0; for (let i = 0; i < cols.length; i++) if (x >= cols[i] - 3) k = i; return k; };
  const rows = [];
  for (const l of linhasT) {
    const cel = Array(cols.length).fill("");
    const porCol = new Map();
    for (const it of l.itens) { const k = colDe(it.x); if (!porCol.has(k)) porCol.set(k, []); porCol.get(k).push(it); }
    for (const [k, its] of porCol) cel[k] = limpar(juntarItens(its.sort((a, b) => a.x - b.x))).trim();
    // linha que só continua a célula de cima (texto quebrado, bem colada): junta
    const ant = rows[rows.length - 1];
    if (ant && !cel[0] && rows.length > 1 && l.y - ant._y < 10.5 && cel.every((c, k) => !c || ant[k])) {
      cel.forEach((c, k) => { if (c) ant[k] = (ant[k] ? ant[k] + " " : "") + c; });
      ant._y = l.y;
    } else { cel._y = l.y; rows.push(cel); }
  }
  const usadas = cols.map((_, k) => rows.some((r) => r[k]));
  return rows.filter((r) => r.some(Boolean)).map((r) => ({ celulas: r.filter((_, k) => usadas[k]) }));
}

const ehFonteLegenda = (it) => /^Univers/.test(it.f) && it.tam < 8.3 && !/Extended/.test(it.f);
const ehCitacaoSolta = (t) => /^[\d,\s\-–]+$/.test(t) || /^[≤≥<>=±-]$/.test(t);

// legendas: monta pela página inteira (há legendas largas que atravessam as duas colunas)
function legendasDaPagina(itens, larg) {
  const its = itens.filter(ehFonteLegenda).sort((a, b) => a.y - b.y || a.x - b.x);
  const linhasL = [];
  for (const it of its) {
    const l = linhasL[linhasL.length - 1];
    if (l && Math.abs(l.y - it.y) < 2.5) l.itens.push(it); else linhasL.push({ y: it.y, itens: [it] });
  }
  // cada linha pode ter 2 segmentos (uma legenda em cada coluna): separa pelo vão entre colunas
  const segs = [];
  for (const l of linhasL) {
    l.itens.sort((a, b) => a.x - b.x);
    let atualSeg = [l.itens[0]];
    for (let i = 1; i < l.itens.length; i++) {
      const a = l.itens[i - 1], b = l.itens[i];
      if (b.x - (a.x + a.w) > 9) { segs.push(atualSeg); atualSeg = []; }
      atualSeg.push(b);
    }
    segs.push(atualSeg);
  }
  const caps = [];
  for (const seg of segs) {
    const x0 = seg[0].x, x1 = seg[seg.length - 1].x + seg[seg.length - 1].w, y = seg[0].y;
    const texto = limpar(juntarItens(seg)).trim();
    if (!texto) continue;
    if (/^Fig\.?\s*\d/.test(texto)) { caps.push({ x0, x1, y0: y, yl: y, texto, itens: [...seg] }); continue; }
    const dono = caps.filter((c) => x0 >= c.x0 - 6 && x0 <= c.x1 + 2 && y - c.yl < 14 && y >= c.yl)
      .sort((a, b) => b.yl - a.yl)[0]
      || caps.filter((c) => y >= c.y0 && x0 >= c.x0 - 6).sort((a, b) => b.yl - a.yl)[0];
    if (dono) { juntar(dono, texto); dono.yl = Math.max(dono.yl, y); dono.x1 = Math.max(dono.x1, x1); dono.itens.push(...seg); }
    else caps.push({ x0, x1, y0: y, yl: y, texto, itens: [...seg], orfa: true });
  }
  return caps.map((c) => ({ ...c, larga: c.x0 < larg / 2 - 20 && c.x1 > larg / 2 + 20, col: c.x0 < larg / 2 ? 0 : 1 }));
}

function tabelasDaPagina(validos, larg, n) {
  const usados = new Set(); const tabelas = [];
  for (const tt of validos.filter((it) => /^Univers-Extended/.test(it.f) && /^\s*TABLE/.test(it.s))) {
    const larga = validos.some((it) => it !== tt && /Univers.*(Light|Bold)/.test(it.f) && it.tam >= 8.3 && it.tam < 9 && it.y > tt.y && it.y < tt.y + 40 && (it.x > larg / 2) !== (tt.x > larg / 2));
    const naCol = (it) => larga || (it.x > larg / 2) === (tt.x > larg / 2);
    // título: o que está na mesma linha (qualquer fonte) + a linha de baixo, se for a continuação do título
    const linha1 = validos.filter((it) => Math.abs(it.y - tt.y) < 3 && it.x >= tt.x - 2 && naCol(it));
    const fontesTit = new Set(linha1.map((i) => i.f));
    const linha2 = validos.filter((it) => it.y > tt.y + 3 && it.y < tt.y + 16 && naCol(it) && fontesTit.has(it.f) && !(it.tam >= 8.3 && it.tam < 9));
    const titulo = [...linha1, ...linha2];
    const yTit = Math.max(...titulo.map((i) => i.y));
    const cand = validos.filter((it) => it.y > yTit + 2 && naCol(it) && /^Univers/.test(it.f) && it.tam >= 8.3 && it.tam < 9.5 && !titulo.includes(it)).sort((a, b) => a.y - b.y);
    const corpo = []; let ultY = yTit;
    for (const it of cand) { if (it.y - ultY > 30) break; corpo.push(it); ultY = Math.max(ultY, it.y); }
    [...corpo, ...titulo].forEach((it) => usados.add(it));
    const textoTit = limpar(juntarItens(linha1.sort((a, b) => a.x - b.x)) + " " + juntarItens(linha2.sort((a, b) => a.x - b.x))).trim();
    tabelas.push({ y: tt.y, col: larga ? 0 : (tt.x > larg / 2 ? 1 : 0), bloco: { tipo: "tabela", titulo: textoTit, linhas: montarTabela(corpo), _pag: n } });
  }
  return { tabelas, usados };
}

/**
 * Extrai o capítulo inteiro em blocos (em inglês), com figuras ligadas às legendas.
 * imagensDaPagina(n) -> retângulos [y0,x0,y1,x1] 0..1000 das imagens embutidas (agrupados)
 */
export async function extrairCapitulo(pdf, imagensDaPagina, progresso) {
  const blocos = [];
  let modo = "texto"; // texto | quadro | caixa | refs
  let atual = null;   // bloco em construção
  let pagAtual = 1;
  const fechar = () => {
    if (atual && !atual._ja && ((atual.texto || "").trim() || atual.destaque)) { atual._pag = atual._pag || pagAtual; blocos.push(atual); }
    if (atual?._depois) { blocos.push(...atual._depois); delete atual._depois; } // figuras/tabelas que apareceram no meio do parágrafo
    atual = null;
  };
  const textoDasPaginas = new Map(); // pág -> retângulos (0..1000) das linhas de texto, p/ achar figuras desenhadas
  let ultimaLinha = null;

  for (let n = 1; n <= pdf.numPages; n++) {
    progresso?.(n, pdf.numPages); pagAtual = n;
    const { itens, larg, alt } = await itensDaPagina(pdf, n);
    const imagens = await imagensDaPagina(n);
    let validos = itens.filter((it) => !descartar(it, larg, alt, imagens));
    if (modo === "refs") { // referências até o fim, a não ser que apareça um novo título de seção
      if (!validos.some((it) => /^Univers-CondensedBold$/.test(it.f) && it.tam >= 11.5 && !/^REFERENCES/.test(it.s))) continue;
    }

    // 1) título e autores (pág. 1) vêm sempre primeiro
    if (n === 1) {
      for (const [tipo, teste] of [["titulo_capitulo", (it) => /^Univers-Light$/.test(it.f) && it.tam >= 18], ["autores", (it) => /^Univers-CondensedOblique/.test(it.f) && it.tam >= 12]]) {
        const its = validos.filter(teste);
        if (!its.length) continue;
        const ls = linhas(its);
        blocos.push({ tipo, texto: ls.map((l) => l.texto).join(" ").replace(/[†*‡]/g, "").replace(/\s+/g, " ").trim(), _pag: 1 });
        validos = validos.filter((it) => !its.includes(it));
      }
    }

    // 2) tabelas e legendas (podem atravessar as colunas)
    const { tabelas, usados } = tabelasDaPagina(validos, larg, n);
    validos = validos.filter((it) => !usados.has(it));
    const caps = legendasDaPagina(validos, larg);
    const nosCaps = new Set(caps.flatMap((c) => c.itens));
    validos = validos.filter((it) => !nosCaps.has(it));
    const eventos = [
      ...tabelas.map((t) => ({ y: t.y, col: t.col, bloco: t.bloco })),
      ...caps.map((c) => ({ y: c.y0, col: c.col, bloco: c.orfa ? { tipo: "paragrafo", texto: c.texto, _pag: n } : { tipo: "legenda", texto: c.texto, _pag: n, _cap: c } })),
    ];

    const linhasTexto = [];
    const colunas = [validos.filter((it) => it.x < larg / 2), validos.filter((it) => it.x >= larg / 2)];
    for (let c = 0; c < 2; c++) {
      const ls = linhas(colunas[c]);
      for (const l of ls) linhasTexto.push([(l.y - l.tam) / alt * 1000, (Math.min(...l.itens.map((i) => i.x)) / larg) * 1000, (l.y + 2) / alt * 1000, (Math.max(...l.itens.map((i) => i.x + i.w)) / larg) * 1000]);
      const margem = Math.min(...ls.filter((l) => classe(l) === "texto").map((l) => l.x), Infinity);
      const evAqui = eventos.filter((e) => e.col === c).sort((a, b) => a.y - b.y);
      const soltarEventos = (ate) => {
        while (evAqui.length && evAqui[0].y <= ate) {
          const e = evAqui.shift();
          if (e.bloco.tipo === "legenda" || e.bloco.tipo === "tabela") {
            // não corta o parágrafo em andamento: a figura/tabela entra logo depois dele
            if (atual && !atual._ja && ["paragrafo", "item_lista"].includes(atual.tipo)) { (atual._depois ||= []).push(e.bloco); continue; }
            fechar(); blocos.push(e.bloco);
          } else { fechar(); blocos.push(e.bloco); }
        }
      };
      for (const l of ls) {
        soltarEventos(l.y);
        const k = classe(l);
        const t = l.texto;
        if (!t || ehCitacaoSolta(t)) continue;
        if (modo === "refs" && k !== "h12") continue;

        if (k === "h12") {
          const caixaAlta = t === t.toUpperCase();
          if (/^REFERENCES|^SELECTED READINGS?/.test(t)) { fechar(); modo = "refs"; continue; }
          modo = "texto";
          const tipo = !caixaAlta ? "subsecao" : /^AUTHORS[’']? PREFERRED/.test(t) ? "metodo_preferido" : "secao";
          const mesmoTitulo = atual && (atual.tipo === tipo || (atual.tipo === "metodo_preferido" && caixaAlta));
          if (mesmoTitulo && ultimaLinha && l.y - ultimaLinha.y < 18 && ultimaLinha.pag === l.pag) { atual.texto += " " + t; ultimaLinha = { ...l, col: c }; continue; }
          fechar(); atual = { _pag: n, tipo, texto: t }; ultimaLinha = { ...l, col: c }; continue;
        }
        if (k === "subsecao" || k === "subsubsecao") {
          modo = "texto";
          if (atual && atual.tipo === k && ultimaLinha && l.y - ultimaLinha.y < 16) { atual.texto += " " + t; ultimaLinha = { ...l, col: c }; continue; }
          fechar(); atual = { _pag: n, tipo: k, texto: t.replace(/\s*\d+(,\s*\d+|[-–]\s*\d+)*$/, "") }; ultimaLinha = { ...l, col: c }; continue;
        }
        if (k === "tab_titulo") { // BOX
          fechar(); modo = "caixa"; atual = { _pag: n, tipo: "caixa_titulo", texto: t.replace(/^BOX\s*[\d.]+\s*/, "") }; ultimaLinha = { ...l, col: c }; continue;
        }
        if (k === "quadro_ou_caixa") {
          if (/CRITICAL POINTS/i.test(t)) { fechar(); modo = "quadro"; blocos.push({ tipo: "quadro_titulo", texto: "CRITICAL POINTS", _pag: n }); }
          else if (atual?.tipo === "caixa_titulo" && l.y - ultimaLinha.y < 16) { atual.texto += " " + t; } // título do box em 2 linhas
          else { fechar(); blocos.push({ tipo: modo === "quadro" ? "quadro_secao" : "caixa_item", texto: t, _pag: n }); }
          ultimaLinha = { ...l, col: c }; continue;
        }
        if (k === "quadro_subtitulo") {
          if (atual?.tipo === "quadro_subtitulo" && l.y - ultimaLinha.y < 16) { atual.texto += " " + t; ultimaLinha = { ...l, col: c }; continue; }
          fechar(); modo = "quadro"; atual = { _pag: n, tipo: "quadro_subtitulo", texto: t }; ultimaLinha = { ...l, col: c }; continue;
        }
        if (k === "rotulo85") {
          fechar(); blocos.push({ tipo: modo === "quadro" ? "quadro_secao" : "caixa_item", texto: t, _pag: n }); ultimaLinha = { ...l, col: c }; continue;
        }
        if (k === "pequeno85") {
          const item = /^[•▪◦]/.test(t);
          const tipo = modo === "quadro" ? "quadro_item" : "caixa_item";
          if (modo === "quadro" && !item && atual && atual.tipo === tipo) { juntar(atual, t); ultimaLinha = { ...l, col: c }; continue; }
          fechar(); atual = { _pag: n, tipo, texto: t.replace(/^[•▪◦]\s*/, ""), marcador: item || undefined }; ultimaLinha = { ...l, col: c }; continue;
        }
        if (k === "legenda" || k === "ref" || k === "titulo" || k === "autores") continue;

        // texto corrido
        modo = "texto";
        const recuo = l.x - margem > 6;
        const lista = /^(\d+\.\s|[a-z]\.\s|•)/.test(t);
        const lacuna = ultimaLinha && ultimaLinha.pag === l.pag && ultimaLinha.col === c && l.y - ultimaLinha.y > 16;
        const novaColuna = !ultimaLinha || ultimaLinha.pag !== l.pag || ultimaLinha.col !== c;
        const minuscula = /^[a-z(]/.test(t);
        // 2ª linha de um item de lista (recuada); na troca de coluna, só se começar com minúscula
        const continuaItem = atual && atual.tipo === "item_lista" && !lista && !l.runIn && !lacuna
          && (novaColuna ? minuscula : Math.abs(l.x - (atual._xTexto ?? l.x)) < 3);
        const continuaPar = atual && ["paragrafo", "caixa_item", "quadro_item"].includes(atual.tipo) && !recuo && !lista && !l.runIn
          && (!lacuna || (novaColuna && minuscula)) && (!novaColuna || minuscula || !/[.:?!”)]$/.test(atual.texto.trim()));
        // parágrafo interrompido por figura/tabela/título de outra coluna: volta a emendar no parágrafo de antes
        const anterior = [...blocos].reverse().find((b) => !["legenda", "tabela"].includes(b.tipo));
        const retomar = !continuaItem && !continuaPar && !atual && !lista && !l.runIn && minuscula
          && anterior && ["paragrafo", "item_lista"].includes(anterior.tipo) && !/[.:?!”)]$/.test(anterior.texto.trim());
        // frase claramente inacabada + linha começando com minúscula = continuação, mesmo após um espaço
        const fraseAberta = atual && ["paragrafo", "item_lista", "caixa_item", "quadro_item"].includes(atual.tipo) && minuscula && !lista && !l.runIn
          && !/[.:?!”)]$/.test(atual.texto.trim());
        if (continuaItem || continuaPar || fraseAberta) juntar(atual, t);
        else if (retomar) { atual = anterior; atual._ja = true; juntar(atual, t); }
        else {
          fechar();
          if (lista) {
            const depoisDoNumero = l.itens.find((i, k) => k > 0 && i.s.trim() && !/^\s*(\d+\.|[a-z]\.|•)\s*$/.test(i.s));
            atual = { _pag: n, tipo: "item_lista", texto: t.replace(/^•\s*/, ""), marcador: /^•/.test(t) || undefined, _xTexto: depoisDoNumero ? depoisDoNumero.x : l.x + 12 };
          }
          else if (l.runIn) atual = { _pag: n, tipo: "paragrafo", destaque: l.runIn, destaqueCor: /MinionPro-Bold/.test(l.runInFonte) ? "7030A0" : "ED7D31", texto: t.slice(l.runIn.length).trim() };
          else atual = { _pag: n, tipo: "paragrafo", texto: t };
        }
        ultimaLinha = { ...l, col: c };
      }
      soltarEventos(Infinity);
      if (ultimaLinha && ultimaLinha.pag === n) ultimaLinha = { ...ultimaLinha, col: c };
    }
    textoDasPaginas.set(n, linhasTexto);
  }
  fechar();

  // liga cada legenda à figura logo acima dela: imagem embutida, ou (desenho) a área vazia de texto acima da legenda
  const usadas = new Map();
  for (const b of blocos) {
    const c = b._cap; if (b.tipo !== "legenda" || !c) continue;
    const pag = b._pag;
    const vp = (await pdf.getPage(pag)).getViewport({ scale: 1 });
    const cx0 = (c.x0 / vp.width) * 1000, cx1 = (c.x1 / vp.width) * 1000, cy = ((c.y0 - 8) / vp.height) * 1000;
    const sobrepoe = (g) => g[1] < cx1 + 20 && g[3] > cx0 - 20;
    const gs = (await imagensDaPagina(pag)).filter((g) => !(usadas.get(pag) || []).includes(g) && sobrepoe(g));
    const acima = gs.filter((g) => g[2] <= cy + 25).sort((a, z) => z[2] - a[2]);
    let caixa = acima[0];
    if (!caixa) { // figura desenhada (vetorial): do fim do texto acima até a legenda
      const tops = (textoDasPaginas.get(pag) || []).filter((r) => r[2] < cy && r[1] < cx1 && r[3] > cx0).map((r) => r[2]);
      const topo = Math.max(55, ...tops) + 4;
      if (cy - topo > 60) caixa = [topo, Math.max(40, cx0 - 4), cy - 2, Math.min(960, cx1 + 4)];
    }
    if (caixa) { b.figura = { pagina: pag, caixa: caixa.map(Math.round), exata: true, abs: true }; usadas.set(pag, [...(usadas.get(pag) || []), caixa]); }
  }
  for (const b of blocos) {
    delete b._cap; delete b._ja; delete b._depois; delete b._xTexto;
    // "C5- C6", "Dejerine- Klumpke": o PDF põe um espaço depois do hífen da quebra de linha
    const semEspacoNoHifen = (x) => x.replaceAll(HIFEN_DURO, "-").replace(/([A-Za-zÀ-ÿ0-9])- (?=[A-Za-zÀ-ÿ0-9])(?!and\b|or\b|to\b|e\b|ou\b)/g, "$1-");
    for (const k of ["texto", "destaque", "titulo"]) if (b[k]) b[k] = semEspacoNoHifen(b[k]);
    for (const l of b.linhas || []) l.celulas = l.celulas.map(semEspacoNoHifen);
  }
  return blocos;
}

const HIFEN_DURO = String.fromCharCode(0x2011);
const TEXTUAIS = ["paragrafo", "item_lista", "quadro_item", "caixa_item", "legenda"];
function juntar(b, t) {
  const a = b.texto.trimEnd();
  // palavra quebrada no fim da linha ("epi-" + "dermal") — junta sem hífen
  if (/[a-z]-$/.test(a) && /^[a-z]/.test(t)) b.texto = a.slice(0, -1) + t;
  else if (a.endsWith(HIFEN_DURO)) b.texto = a + t; // palavra composta quebrada no hífen ("37-" + "year-old")
  else b.texto = a + " " + t;
}
