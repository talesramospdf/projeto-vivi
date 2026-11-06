// Instruções e formato de resposta enviados ao Gemini.

export const TIPOS = [
  "titulo_capitulo", // título do capítulo (sem o número)
  "autores",
  "secao",           // título de seção principal (MAIÚSCULAS)
  "subsecao",
  "subsubsecao",
  "paragrafo",
  "item_lista",      // item de lista numerada ou com marcador (inclui "1." no texto)
  "legenda",         // legenda de figura ("Fig. 34.3 ...") + caixa da figura
  "tabela",
  "quadro_titulo",   // "PONTOS CRÍTICOS"
  "quadro_subtitulo",// nome do procedimento dentro do quadro
  "quadro_secao",    // Indicações, Dicas, Pontos Técnicos, Armadilhas, Cuidados Pós-operatórios
  "quadro_item",     // marcadores dentro do quadro
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
          texto: { type: "STRING" },
          continua: { type: "BOOLEAN" },
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

export function montarPrompt({ capitulo, numero, paginas, glossario, anterior }) {
  return `Você é tradutor médico profissional (inglês → português do Brasil) do livro "Green's Operative Hand Surgery", 8ª edição.
Você recebeu ${paginas} imagem(ns) de páginas CONSECUTIVAS do capítulo ${numero} ("${capitulo}"). Extraia TODO o conteúdo na ordem de leitura e traduza para o português do Brasil.

ORDEM DE LEITURA: o livro tem duas colunas. Leia a coluna da esquerda de cima a baixo, depois a da direita. Quadros, tabelas e figuras entram no ponto em que aparecem.

TRADUÇÃO:
- Terminologia médica e anatômica oficial usada no Brasil; texto fluente, natural e fiel. Não resuma nem omita frases.
- Mantenha nomes próprios, epônimos, siglas consagradas, doses e unidades.
- "Figure" → "Fig."; "Table" → "TABELA"; "Pearls" → "Dicas"; "Pitfalls" → "Armadilhas"; "Technical Points" → "Pontos Técnicos"; "Indications" → "Indicações"; "Postoperative Care" → "Cuidados Pós-operatórios"; "CRITICAL POINTS" → "PONTOS CRÍTICOS".
${glossario ? `- GLOSSÁRIO OBRIGATÓRIO (use exatamente estas traduções):\n${glossario}\n` : ""}
IGNORE COMPLETAMENTE: cabeçalhos e rodapés de página, números de página, linhas "CHAPTER X ..." e "PART ..." do topo da página, a lista de referências bibliográficas (REFERENCES) e os números de citação no meio do texto (ex.: "patients16" vira "pacientes"). Junte palavras hifenizadas na quebra de linha.

ESTRUTURA (campo "tipo"):
- titulo_capitulo: título do capítulo, sem o número. autores: nomes dos autores, sem traduzir.
- secao: títulos principais, em MAIÚSCULAS. subsecao: subtítulos. subsubsecao: subtítulos de terceiro nível.
- paragrafo: um bloco por parágrafo completo. item_lista: cada item de lista, com o número/letra no início do texto quando houver.
- legenda: cada figura. "texto" = legenda traduzida começando com "Fig. ${numero}.N". "figura.pagina" = qual das imagens recebidas (1 = primeira) contém a figura; "figura.caixa" = [ymin, xmin, ymax, xmax] de 0 a 1000 envolvendo SÓ a figura (fotos/desenhos com as letras dos painéis), sem a legenda.
- tabela: "titulo" = "TABELA ${numero}.N — título traduzido"; "linhas" = linhas da tabela (a primeira é o cabeçalho), cada uma com "celulas".
- quadros "CRITICAL POINTS": quadro_titulo ("PONTOS CRÍTICOS"), quadro_subtitulo (nome do procedimento), quadro_secao (Indicações, Dicas...), quadro_item (cada marcador).

CONTINUIDADE: ${anterior ? `o trecho anterior terminou com: "…${anterior}". Se o primeiro texto destas páginas continua essa frase/parágrafo, marque esse primeiro bloco com "continua": true.` : `este é o início do capítulo.`}
Se a última página termina no meio de uma frase, traduza só o que aparece (o próximo trecho continua).`;
}
