// Instruções e formato de resposta enviados ao Gemini (montados no navegador).

export const TIPOS = [
  "titulo_capitulo",  // título do capítulo (sem o número)
  "autores",
  "agradecimentos",   // nota de agradecimento no início do capítulo
  "secao",            // título de seção principal (MAIÚSCULAS)
  "subsecao",
  "subsubsecao",
  "paragrafo",        // pode ter "destaque" = título embutido no início ("Contraindicações.")
  "item_lista",       // item de lista numerada ("1. ...") ou com marcador ("• ...")
  "legenda",          // legenda de figura ("Fig. 34.3 ...") + caixa da figura
  "tabela",
  "metodo_preferido", // faixa "AUTHORS' PREFERRED METHOD OF TREATMENT: ..."
  "caixa_titulo",     // título de quadro/box de texto (que não é tabela nem Pontos Críticos)
  "caixa_item",       // linhas dentro desse quadro
  "quadro_titulo",    // "PONTOS CRÍTICOS"
  "quadro_subtitulo", // nome do procedimento dentro do quadro
  "quadro_secao",     // Indicações, Dicas, Pontos Técnicos, Armadilhas, Cuidados Pós-operatórios
  "quadro_item",      // marcadores dentro do quadro
];

export const SCHEMA = {
  type: "OBJECT",
  properties: {
    blocos: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          tipo: { type: "STRING", enum: TIPOS },
          destaque: { type: "STRING" },
          texto: { type: "STRING" },
          continua: { type: "BOOLEAN" },
          marcador: { type: "BOOLEAN" },
          figura: {
            type: "OBJECT",
            properties: {
              pagina: { type: "INTEGER" },
              caixa: { type: "ARRAY", items: { type: "INTEGER" } },
            },
          },
          titulo: { type: "STRING" },
          linhas: {
            type: "ARRAY",
            items: { type: "OBJECT", properties: { celulas: { type: "ARRAY", items: { type: "STRING" } } } },
          },
        },
        required: ["tipo"],
      },
    },
  },
  required: ["blocos"],
};

export function montarPrompt({ capitulo, numero, paginas, glossario, anterior, inicio, primeiraPagina }) {
  return `Você é tradutor médico profissional (inglês → português do Brasil) do livro "Green's Operative Hand Surgery", 8ª edição.
Você recebeu ${paginas} imagem(ns) de páginas CONSECUTIVAS do capítulo ${numero} ("${capitulo}"). Extraia TODO o conteúdo na ordem de leitura e traduza para o português do Brasil.

ORDEM DE LEITURA: o livro tem duas colunas. Leia a coluna da esquerda de cima a baixo, depois a da direita. Quadros e tabelas entram no ponto em que aparecem. NUNCA corte um parágrafo por causa de uma figura: se uma figura aparece no meio de um parágrafo, termine o parágrafo inteiro e coloque a figura (legenda) logo depois dele.

TRADUÇÃO:
- Terminologia médica e anatômica oficial usada no Brasil; texto fluente, natural e fiel. Não resuma nem omita frases.
- Mantenha nomes próprios, epônimos, siglas consagradas, doses e unidades. Use aspas curvas “assim”.
- "Figure" → "Fig."; "Table" → "TABELA"; "Pearls" → "Dicas"; "Pitfalls" → "Armadilhas"; "Technical Points" → "Pontos Técnicos"; "Indications" → "Indicações"; "Postoperative Care" → "Cuidados Pós-operatórios"; "CRITICAL POINTS" → "PONTOS CRÍTICOS"; "AUTHORS' PREFERRED METHOD OF TREATMENT" → "MÉTODO DE TRATAMENTO PREFERIDO PELOS AUTORES".
- A frase final "For Case Studies, Videos, and more, please visit eBooks for Practicing Clinicians at ExpertConsult.com." vira exatamente: "Para Estudos de Caso, Vídeos e mais, por favor visite eBooks for Practicing Clinicians em ExpertConsult.com." (tipo paragrafo; NÃO ignore essa frase).
${glossario ? `- GLOSSÁRIO OBRIGATÓRIO (use exatamente estas traduções):\n${glossario}\n` : ""}
IGNORE COMPLETAMENTE: cabeçalhos e rodapés de página, números de página, linhas "CHAPTER X ..." e "PART ..." do topo da página, notas de rodapé de autores (ex.: "†Deceased"), a lista de referências bibliográficas (REFERENCES) e os números de citação no meio do texto (ex.: "patients16" vira "pacientes"). Junte palavras hifenizadas na quebra de linha.

ESTRUTURA (campo "tipo"):
- titulo_capitulo: título do capítulo, sem o número. autores: nomes dos autores, sem traduzir e sem símbolos (†, *).
- agradecimentos: nota de agradecimento ("Acknowledgments: ...") do início do capítulo, começando com "Agradecimentos:".
- secao: títulos principais, em MAIÚSCULAS. subsecao: subtítulos. subsubsecao: subtítulos de terceiro nível.
- paragrafo: um bloco por parágrafo completo. Quando o parágrafo começa com um título embutido em negrito/itálico (ex.: "Contraindications. The ..."), coloque o título traduzido COM o ponto final em "destaque" ("Contraindicações.") e o resto em "texto".
- item_lista: cada item de lista. Lista numerada: número no início do texto ("1. ..."). Lista com marcador (•): "marcador": true e o texto SEM o "•".
- legenda: cada figura, UMA VEZ só (se a mesma legenda aparecer de novo, não repita). "texto" = legenda traduzida começando com "Fig. ${numero}.N". "figura.pagina" = qual das imagens recebidas (1 = primeira) contém a figura; "figura.caixa" = [ymin, xmin, ymax, xmax] de 0 a 1000 envolvendo SÓ a figura (todas as fotos/desenhos dela, com as letras dos painéis), SEM a legenda e sem texto ao redor.
- tabela: "titulo" = "TABELA ${numero}.N — título traduzido"; "linhas" = linhas da tabela (a primeira é o cabeçalho), cada uma com "celulas".
- metodo_preferido: a faixa colorida "AUTHORS' PREFERRED METHOD OF TREATMENT: ...", em MAIÚSCULAS.
- quadros/boxes de texto que não são tabela nem "CRITICAL POINTS": caixa_titulo (título do box) e caixa_item (cada linha; use "marcador": true se a linha tem marcador).
- quadros "CRITICAL POINTS": quadro_titulo ("PONTOS CRÍTICOS"), quadro_subtitulo (nome do procedimento), quadro_secao (Indicações, Dicas...), quadro_item (cada marcador).

CONTINUIDADE: ${anterior ? `o trecho anterior terminou com: "…${anterior}". Se o primeiro texto destas páginas continua essa frase/parágrafo, marque esse primeiro bloco com "continua": true.` : inicio ? `este é o início do capítulo.` : `estas páginas (a partir da página ${primeiraPagina || "?"} do capítulo) são a continuação do capítulo. Se o primeiro texto da primeira página começa no meio de uma frase ou parágrafo (ex.: começa com letra minúscula ou sem início de frase), marque esse primeiro bloco com "continua": true. Se a página começa no meio de uma lista, continue a lista.`}
Se a última página termina no meio de uma frase, traduza só o que aparece (o próximo trecho continua).`;
}
