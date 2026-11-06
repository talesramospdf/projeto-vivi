// Monta o .docx no padrão dos capítulos já traduzidos:
// A4, 2 colunas, Arial 12 justificado, seções azuis, subseções verdes/roxas,
// legendas "Fig." em azul (Arial 10), quadros "PONTOS CRÍTICOS" e tabelas roxas.
const D = window.docx;

const COR = {
  texto: "1A1A1A", secao: "4472C4", subsecao: "538135", subsub: "7030A0",
  fig: "4472C4", quadro: "2E74B5", quadroClaro: "BDD6EE", tabTitulo: "7030A0", tabCelula: "D7AFFF",
};
const LARG_COLUNA_PX = 345; // largura útil de uma coluna (~9,2 cm)

const sombra = (fill) => ({ type: D.ShadingType.CLEAR, color: "auto", fill });
const run = (text, o = {}) => new D.TextRun({ text, font: "Arial", size: 24, color: COR.texto, ...o });
const ESQ = { alignment: D.AlignmentType.LEFT };
const par = (children, o = {}) => new D.Paragraph({ children, alignment: D.AlignmentType.JUSTIFIED, spacing: { after: 120 }, ...o });

function legenda(texto) {
  const m = texto.match(/^(Fig\.?\s*[\d.]+[A-Za-z]?)(.*)$/s);
  const kids = m
    ? [run(m[1], { size: 20, color: COR.fig }), run(m[2], { size: 20 })]
    : [run(texto, { size: 20 })];
  return par(kids, { spacing: { after: 160 } });
}

function tabela(b) {
  const out = [];
  if (b.titulo) out.push(par([run(b.titulo, { bold: true, color: "FFFFFF" })], { ...ESQ, shading: sombra(COR.tabTitulo), spacing: { after: 0 } }));
  const linhas = (b.linhas || []).filter((l) => l?.celulas?.length);
  if (linhas.length) {
    const ncol = Math.max(...linhas.map((l) => l.celulas.length));
    out.push(new D.Table({
      width: { size: 100, type: D.WidthType.PERCENTAGE },
      rows: linhas.map((l, i) => new D.TableRow({
        tableHeader: i === 0,
        children: Array.from({ length: ncol }, (_, k) => new D.TableCell({
          shading: sombra(COR.tabCelula),
          children: [new D.Paragraph({ children: [run(l.celulas[k] || "", { size: 20, bold: i === 0 })] })],
        })),
      })),
    }));
    out.push(par([run("")], { spacing: { after: 60 } }));
  }
  return out;
}

function imagem(fig) {
  let w = Math.min(LARG_COLUNA_PX, fig.largura);
  let h = Math.round((fig.altura * w) / fig.largura);
  if (h > 520) { w = Math.round((w * 520) / h); h = 520; }
  return new D.Paragraph({
    alignment: D.AlignmentType.CENTER,
    spacing: { before: 80, after: 60 },
    children: [new D.ImageRun({ type: "jpg", data: fig.dados, transformation: { width: w, height: h } })],
  });
}

// blocos: lista já unida; figuras: Map(indiceBloco -> {dados, largura, altura})
export async function gerarDocx(blocos, figuras) {
  const filhos = [];
  blocos.forEach((b, i) => {
    const t = (b.texto || "").trim();
    switch (b.tipo) {
      case "titulo_capitulo": filhos.push(par([run(t, { size: 40 })], { alignment: D.AlignmentType.LEFT })); break;
      case "autores": filhos.push(par([run(t, { size: 27 })], { spacing: { after: 240 } })); break;
      case "secao": filhos.push(par([run(t.toUpperCase(), { bold: true, color: COR.secao })], { ...ESQ, spacing: { before: 200, after: 100 }, keepNext: true })); break;
      case "subsecao": filhos.push(par([run(t, { bold: true, color: COR.subsecao })], { ...ESQ, spacing: { before: 140, after: 80 }, keepNext: true })); break;
      case "subsubsecao": filhos.push(par([run(t, { bold: true, color: COR.subsub })], { ...ESQ, spacing: { before: 100, after: 60 }, keepNext: true })); break;
      case "legenda":
        if (figuras.has(i)) filhos.push(imagem(figuras.get(i)));
        if (t) filhos.push(legenda(t));
        break;
      case "tabela": filhos.push(...tabela(b)); break;
      case "quadro_titulo": filhos.push(par([run(t || "PONTOS CRÍTICOS", { bold: true, color: "FFFFFF" })], { ...ESQ, shading: sombra(COR.quadro), spacing: { before: 200, after: 0 }, keepNext: true })); break;
      case "quadro_subtitulo": filhos.push(par([run(t, { bold: true })], { ...ESQ, shading: sombra(COR.quadroClaro), spacing: { after: 0 }, keepNext: true })); break;
      case "quadro_secao": filhos.push(par([run(t, { bold: true, italics: true })], { ...ESQ, shading: sombra(COR.quadroClaro), spacing: { after: 0 }, keepNext: true })); break;
      case "quadro_item": filhos.push(par([run(t)], { shading: sombra(COR.quadroClaro), bullet: { level: 0 }, spacing: { after: 0 } })); break;
      case "item_lista": filhos.push(par([run(t)], { spacing: { after: 60 } })); break;
      default: if (t) filhos.push(par([run(t)]));
    }
  });

  const doc = new D.Document({
    creator: "Tradutor Green",
    styles: { default: { document: { run: { font: "Arial", size: 24, color: COR.texto } } } },
    sections: [{
      properties: {
        type: D.SectionType.CONTINUOUS,
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 284, right: 424, bottom: 0, left: 284, header: 708, footer: 708 },
        },
        column: { count: 2, space: 730 },
      },
      children: filhos,
    }],
  });
  return D.Packer.toBlob(doc);
}
