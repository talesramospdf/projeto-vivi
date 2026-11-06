# Tradutor do Green (8ª ed.)

Site que traduz os capítulos do *Green's Operative Hand Surgery* para o português com o Gemini e gera o Word no padrão da tradução (A4, duas colunas, Arial 12, legendas, quadros "Pontos Críticos" e tabelas).

## Como funciona

1. Os PDFs dos capítulos ficam no **Cloudflare R2** (bucket `livro-vivi`), gerados pelo `preparar_pdf.py`.
2. O site (Cloudflare Worker) baixa o capítulo, transforma as páginas em imagens e envia de 2 em 2 ao Gemini.
3. O Gemini devolve o texto traduzido já estruturado (títulos, parágrafos, legendas com a posição das figuras, tabelas, quadros).
4. O navegador recorta as figuras do PDF e monta o `.docx`.

**Tradução em segundo plano:** ao clicar em "Colocar na fila", o site prepara as páginas de cada trecho e guarda no R2 (é a única parte que precisa do site aberto). Um Cron do Cloudflare roda a cada minuto (`[triggers]` no `wrangler.toml`, grátis), manda os trechos ao Gemini e guarda os resultados em `fila/<capítulo>/res/` — funciona com o site fechado e troca de modelo sozinho quando o Gemini está lotado. Capítulos podem ser marcados como "feito à mão" (`estado/capitulos.json`).

O editor (revisão antes do Word) guarda as edições no navegador (IndexedDB).

## Estrutura

```
public/          site (index.html, app.js, word.js, estilo.css, vendor/)
public/prompt.js instruções enviadas ao Gemini
src/             Worker: senha + rotas /api (capitulos, pdf, traduzir, modelos, glossario, fila, estado)
src/fila.js      fila em segundo plano + processamento pelo Cron
wrangler.toml    Worker, arquivos do site e bucket R2 "livro-vivi" (binding LIVRO)
```

## Configuração no Cloudflare

- **Workers & Pages → Worker conectado a este repositório**: build command vazio, deploy command `npx wrangler deploy`.
- **Settings → Variables and Secrets** (tipo *Secret*):
  - `GEMINI_API_KEY`: chave do Google AI Studio
  - `SENHA`: senha para entrar no site
  - `GEMINI_MODEL` (opcional): modelo padrão; sem ele, o site escolhe o "flash" mais novo
- **R2 → bucket `livro-vivi`**: os 60 PDFs + `capitulos.json` (na raiz ou numa pasta `capitulos/`).
