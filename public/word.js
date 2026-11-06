// Monta o .docx no padrão EXATO dos capítulos traduzidos (Cap 34 e Cap 58 de referência):
// - A4, margens 0,5 / 0,75 / 0 / 0,5 cm, 2 colunas (espaço 730), tudo justificado
// - estilo base do Word: Calibri 11, espaçamento 8 pt depois, entrelinha 1,08
// - texto Arial 12 cor 1A1A1A; título Calibri 20; autores Arial 13,5
// - seção: Arial 12 negrito azul 4472C4 com linha azul embaixo
// - subseção verde 538135 negrito; sub-subseção roxo 7030A0 negrito; título embutido laranja ED7D31
// - legenda: estilo "Legenda" (itálico), Arial 10, "Fig. N.N" azul 4472C4 e resto 1A1A1A
// - PONTOS CRÍTICOS: faixa 2E74B5 branca + itens fundo BDD6EE (títulos azuis 2F5496, marcadores)
// - tabelas: título roxo 7030A0 (Calibri 14 branco) + células lilás D7AFFF sem bordas
// - método preferido: faixa laranja ED7D31 (Arial 14 branco, centralizado)
// - box cinza: título A6A6A6 + linhas D9D9D9
const D = window.docx;

const COR = {
  texto: "1A1A1A", secao: "4472C4", subsecao: "538135", subsub: "7030A0", destaque: "ED7D31",
  fig: "4472C4", titulos: "2F5496", quadro: "2E74B5", quadroClaro: "BDD6EE",
  tabTitulo: "7030A0", tabCelula: "D7AFFF", laranja: "ED7D31", cinzaTitulo: "A6A6A6", cinza: "D9D9D9",
};
const LARG_COLUNA_PX = 348; // largura útil de uma coluna (~9,2 cm)
const J = D.AlignmentType.JUSTIFIED;

const sombra = (fill) => ({ type: D.ShadingType.CLEAR, color: "auto", fill });
const arial = (text, o = {}) => new D.TextRun({ text, font: "Arial", size: 24, color: COR.texto, ...o });
const par = (children, o = {}) => new D.Paragraph({ children, alignment: J, ...o });

function legenda(texto) {
  const m = texto.match(/^(Fig\.?\s*[\d.]+[A-Za-z]?\s*)(.*)$/s);
  const kids = m
    ? [arial(m[1], { size: 20, color: COR.fig }), arial(m[2], { size: 20 })]
    : [arial(texto, { size: 20 })];
  return par(kids, { style: "Legenda" });
}

function tabela(b) {
  const out = [];
  if (b.titulo) out.push(par([new D.TextRun({ text: b.titulo, bold: true, color: "FFFFFF" })], { heading: D.HeadingLevel.HEADING_3, alignment: D.AlignmentType.LEFT, shading: sombra(COR.tabTitulo) }));
  const linhas = (b.linhas || []).filter((l) => l?.celulas?.length);
  if (!linhas.length) return out;
  const ncol = Math.max(...linhas.map((l) => l.celulas.length));
  out.push(new D.Table({
    layout: D.TableLayoutType.AUTOFIT,
    borders: D.TableBorders.NONE,
    cellSpacing: { value: 15, type: D.WidthType.DXA },
    margins: { top: 15, bottom: 15, left: 15, right: 15, marginUnitType: D.WidthType.DXA },
    rows: linhas.map((l, i) => new D.TableRow({
      tableHeader: i === 0,
      children: Array.from({ length: ncol }, (_, k) => new D.TableCell({
        verticalAlign: D.VerticalAlign.CENTER,
        borders: { top: { style: D.BorderStyle.NONE, size: 0, color: "auto" }, bottom: { style: D.BorderStyle.NONE, size: 0, color: "auto" }, left: { style: D.BorderStyle.NONE, size: 0, color: "auto" }, right: { style: D.BorderStyle.NONE, size: 0, color: "auto" } },
        children: [new D.Paragraph({
          shading: sombra(COR.tabCelula),
          alignment: i === 0 ? D.AlignmentType.CENTER : D.AlignmentType.LEFT,
          children: [new D.TextRun({ text: l.celulas[k] || "", bold: i === 0 || k === 0 })],
        })],
      })),
    })),
  }));
  out.push(par([]));
  return out;
}

function imagem(fig) {
  const escala = fig.escala || 1;
  let w = Math.min(Math.round(LARG_COLUNA_PX * escala), fig.largura);
  let h = Math.round((fig.altura * w) / fig.largura);
  const maxH = 620;
  if (h > maxH) { w = Math.round((w * maxH) / h); h = maxH; }
  return new D.Paragraph({
    alignment: escala < 1 || w < LARG_COLUNA_PX * 0.9 ? D.AlignmentType.CENTER : J,
    keepNext: true,
    children: [new D.ImageRun({ type: fig.tipo || "jpg", data: fig.dados, transformation: { width: w, height: h } })],
  });
}

const marcador = { numbering: { reference: "marcador", level: 0 } };

// blocos: lista já unida; figuras: Map(indiceBloco -> {dados, largura, altura, tipo, escala})
export async function gerarDocx(blocos, figuras) {
  const filhos = [];
  blocos.forEach((b, i) => {
    const t = (b.texto || "").trim();
    switch (b.tipo) {
      case "titulo_capitulo": filhos.push(par([new D.TextRun({ text: t, size: 40, color: COR.texto })])); break;
      case "autores": filhos.push(par([arial(t, { size: 27 })])); break;
      case "agradecimentos": filhos.push(par([new D.TextRun({ text: t, font: "Segoe UI", size: 27, italics: true, color: COR.texto })])); break;
      case "secao":
        filhos.push(par([arial(t.toUpperCase(), { bold: true, color: COR.secao })], {
          keepNext: true,
          border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: COR.secao, space: 4 } },
        }));
        break;
      case "subsecao": filhos.push(par([arial(t, { bold: true, color: COR.subsecao })], { keepNext: true })); break;
      case "subsubsecao": filhos.push(par([arial(t, { bold: true, color: COR.subsub })], { keepNext: true })); break;
      case "legenda":
        if (figuras.has(i)) filhos.push(imagem(figuras.get(i)));
        if (t) filhos.push(legenda(t));
        break;
      case "tabela": filhos.push(...tabela(b)); break;
      case "metodo_preferido":
        filhos.push(par([arial(t.toUpperCase(), { size: 28, color: "FFFFFF" })], {
          alignment: D.AlignmentType.CENTER, keepNext: true, shading: sombra(COR.laranja),
          spacing: { before: 160, after: 160 },
          border: {
            top: { style: D.BorderStyle.SINGLE, size: 8, color: "AE5A21", space: 4 }, bottom: { style: D.BorderStyle.SINGLE, size: 8, color: "AE5A21", space: 4 },
            left: { style: D.BorderStyle.SINGLE, size: 8, color: "AE5A21", space: 0 }, right: { style: D.BorderStyle.SINGLE, size: 8, color: "AE5A21", space: 0 },
          },
        }));
        break;
      case "caixa_titulo": filhos.push(par([new D.TextRun({ text: t, bold: true, color: "FFFFFF" })], { heading: D.HeadingLevel.HEADING_3, alignment: D.AlignmentType.LEFT, shading: sombra(COR.cinzaTitulo) })); break;
      case "caixa_item": filhos.push(par([arial(t)], { style: "NormalWeb", shading: sombra(COR.cinza), ...(b.marcador ? marcador : {}) })); break;
      case "quadro_titulo": filhos.push(par([arial(t || "PONTOS CRÍTICOS", { bold: true, color: "FFFFFF" })], { heading: D.HeadingLevel.HEADING_1, shading: sombra(COR.quadro) })); break;
      case "quadro_subtitulo": filhos.push(par([arial(t, { color: COR.titulos })], { heading: D.HeadingLevel.HEADING_2, shading: sombra(COR.quadroClaro) })); break;
      case "quadro_secao": filhos.push(par([arial(t, { color: COR.titulos })], { heading: D.HeadingLevel.HEADING_3, shading: sombra(COR.quadroClaro) })); break;
      case "quadro_item": filhos.push(par([arial(t, { color: "000000" })], { style: "NormalWeb", shading: sombra(COR.quadroClaro), ...marcador })); break;
      case "item_lista":
        filhos.push(b.marcador || /^[•·▪◦-]\s/.test(t)
          ? par([arial(t.replace(/^[•·▪◦-]\s*/, ""))], marcador)
          : par([arial(t)]));
        break;
      default: {
        if (!t && !b.destaque) break;
        const kids = [];
        if (b.destaque) kids.push(arial(b.destaque.trim() + " ", { color: b.destaqueCor || COR.destaque }));
        kids.push(arial(t));
        filhos.push(par(kids));
      }
    }
  });

  const doc = new D.Document({
    creator: "Tradutor da Vivi",
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 },
          paragraph: { spacing: { after: 160, line: 259, lineRule: D.LineRuleType.AUTO } },
        },
        heading1: { run: { font: "Calibri Light", size: 40, color: COR.titulos }, paragraph: { keepNext: true, keepLines: true, spacing: { before: 360, after: 80 } } },
        heading2: { run: { font: "Calibri Light", size: 32, color: COR.titulos }, paragraph: { keepNext: true, keepLines: true, spacing: { before: 160, after: 80 } } },
        heading3: { run: { font: "Calibri", size: 28, color: COR.titulos }, paragraph: { keepNext: true, keepLines: true, spacing: { before: 160, after: 80 } } },
      },
      paragraphStyles: [
        { id: "Legenda", name: "caption", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { italics: true, color: "44546A", size: 18 }, paragraph: { spacing: { after: 200, line: 240, lineRule: D.LineRuleType.AUTO } } },
        { id: "NormalWeb", name: "Normal (Web)", basedOn: "Normal",
          run: { font: "Times New Roman", size: 24 }, paragraph: { spacing: { before: 100, after: 100, line: 240, lineRule: D.LineRuleType.AUTO, beforeAutoSpacing: true, afterAutoSpacing: true } } },
      ],
    },
    numbering: {
      config: [{
        reference: "marcador",
        levels: [{ level: 0, format: D.LevelFormat.BULLET, text: "", alignment: D.AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } }, run: { font: "Symbol" } } }],
      }],
    },
    sections: [{
      properties: {
        type: D.SectionType.CONTINUOUS,
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 284, right: 424, bottom: 0, left: 284, header: 708, footer: 708, gutter: 0 },
        },
        column: { count: 2, space: 730 },
      },
      children: filhos,
    }],
  });
  return D.Packer.toBlob(doc);
}
