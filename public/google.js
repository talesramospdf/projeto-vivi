// Tradução com o Google Tradutor (o mesmo serviço gratuito que os plugins de navegador usam).
// Recebe os blocos extraídos do PDF (em inglês) e devolve os blocos em português.

const FIXOS = {
  quadro_titulo: () => "PONTOS CRÍTICOS",
  quadro_secao: (t) => ({
    indications: "Indicações", contraindications: "Contraindicações", pearls: "Dicas", pearl: "Dica",
    "technical points": "Pontos Técnicos", pitfalls: "Armadilhas", pitfall: "Armadilhas",
    "postoperative care": "Cuidados Pós-operatórios",
  }[t.trim().toLowerCase().replace(/[.:]$/, "")]),
};
const FRASE_FINAL = /^For Case Studies, Videos,? and more/i;
const FRASE_FINAL_PT = "Para Estudos de Caso, Vídeos e mais, por favor visite eBooks for Practicing Clinicians em ExpertConsult.com.";

function lerGlossario(texto) {
  return (texto || "").split("\n").map((l) => l.split("=")).filter((p) => p.length >= 2 && p[0].trim() && p[1].trim())
    .map(([en, ...pt]) => [new RegExp(`\\b${en.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), pt.join("=").trim()]);
}
const aplicarGlossario = (t, g) => g.reduce((s, [re, pt]) => s.replace(re, pt), t);

// envia um lote de textos (separados por linha) ao Google. Tenta vários caminhos e lembra o que funcionou:
//  1) direto do navegador (GET)   2) direto do navegador (POST)   3) pelo Worker   4) endpoint do Chrome
const GT = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t";
const lerGtx = (d) => (d?.[0] || []).map((s) => s?.[0] || "").join("");
const lerChrome = (d) => (Array.isArray(d) ? d.map((x) => (Array.isArray(x) ? x[0] : x)).join("") : String(d || ""));
const CAMINHOS = {
  get: async (q) => { const u = `${GT}&q=${encodeURIComponent(q)}`; if (u.length > 7500) throw new Error("longo"); const r = await fetch(u); if (!r.ok) throw new Error("HTTP " + r.status); return lerGtx(await r.json()); },
  post: async (q) => { const r = await fetch(GT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ q }).toString() }); if (!r.ok) throw new Error("HTTP " + r.status); return lerGtx(await r.json()); },
  worker: async (q, api) => { const r = await api("/api/google", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ q }).toString() }); if (!r.ok) throw new Error("HTTP " + r.status); return lerGtx(await r.json()); },
  chrome: async (q) => { const u = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=pt&q=${encodeURIComponent(q)}`; if (u.length > 7500) throw new Error("longo"); const r = await fetch(u); if (!r.ok) throw new Error("HTTP " + r.status); return lerChrome(await r.json()); },
};
let caminhoBom = null;
try { caminhoBom = localStorage.getItem("googleCaminho"); } catch {}

async function lote(textos, api) {
  const q = textos.join("\n");
  const ordem = [...new Set([caminhoBom, "get", "post", "worker", "chrome"].filter(Boolean))];
  const erros = [];
  for (let rodada = 1; rodada <= 3; rodada++) {
    for (const nome of ordem) {
      try {
        const t = await CAMINHOS[nome](q, api);
        if (!t) throw new Error("resposta vazia");
        if (caminhoBom !== nome) { caminhoBom = nome; try { localStorage.setItem("googleCaminho", nome); } catch {} }
        return t.split("\n");
      } catch (e) { erros.push(`${nome}: ${e.message === "Failed to fetch" ? "bloqueado pelo navegador" : e.message}`); }
    }
    await new Promise((r) => setTimeout(r, 2000 * rodada));
  }
  throw new Error("O Google Tradutor não respondeu (" + [...new Set(erros)].slice(-4).join("; ") + ").");
}

// traduz uma lista de textos mantendo a ordem (lotes de até ~4500 caracteres)
async function traduzirTextos(textos, api, progresso) {
  const saida = new Array(textos.length).fill("");
  const idx = textos.map((t, i) => [t, i]).filter(([t]) => t && t.trim());
  let i = 0, feitos = 0;
  while (i < idx.length) {
    const grupo = []; let tam = 0;
    while (i < idx.length && (grupo.length === 0 || tam + idx[i][0].length < 1800)) { grupo.push(idx[i]); tam += idx[i][0].length + 1; i++; }
    const textosGrupo = grupo.map(([t]) => t.replace(/\n/g, " "));
    let res = await lote(textosGrupo, api);
    if (res.length !== grupo.length) { // o Google juntou/partiu linhas: traduz um por um
      res = [];
      for (const t of textosGrupo) res.push((await lote([t], api)).join(" "));
    }
    grupo.forEach(([, k], j) => { saida[k] = (res[j] || "").trim(); });
    feitos += grupo.length; progresso?.(feitos, idx.length);
  }
  return saida;
}

export async function traduzirBlocosGoogle(blocos, { api, glossario, progresso }) {
  const g = lerGlossario(glossario);
  const textos = []; const destinos = [];
  const pedir = (texto, aplicar) => { textos.push(aplicarGlossario(texto, g)); destinos.push(aplicar); };
  const saida = blocos.map((b) => ({ ...b }));

  saida.forEach((b) => {
    const t = (b.texto || "").trim();
    if (b.tipo === "autores") return;
    if (FRASE_FINAL.test(t)) { b.texto = FRASE_FINAL_PT; return; }
    if (FIXOS[b.tipo] && FIXOS[b.tipo](t)) { b.texto = FIXOS[b.tipo](t); return; }
    if (b.tipo === "legenda") {
      const m = t.match(/^(Fig\.?\s*\d+\.\d+)\s*(.*)$/s);
      if (m) { pedir(m[2], (pt) => { b.texto = `${m[1]} ${pt}`; }); return; }
    }
    if (b.tipo === "metodo_preferido") {
      const resto = t.replace(/^AUTHORS[’']?\s+PREFERRED\s+METHOD\s+OF\s+TREATMENT:?\s*/i, "");
      b.texto = "MÉTODO DE TRATAMENTO PREFERIDO PELOS AUTORES" + (resto ? ": " : "");
      if (resto) pedir(resto, (pt) => { b.texto += pt.toUpperCase(); });
      return;
    }
    if (b.tipo === "tabela") {
      const m = (b.titulo || "").match(/^TABLE\s*(\d+\.\d+)\s*(.*)$/i);
      if (m) pedir(m[2], (pt) => { b.titulo = `TABELA ${m[1]} — ${pt}`; });
      (b.linhas || []).forEach((l) => l.celulas.forEach((c, k) => { if (c) pedir(c, (pt) => { l.celulas[k] = pt; }); }));
      return;
    }
    if (b.destaque) pedir(b.destaque, (pt) => { b.destaque = pt; });
    if (t) {
      const caixaAlta = ["secao", "caixa_titulo"].includes(b.tipo) || (t.length > 3 && t === t.toUpperCase());
      pedir(caixaAlta ? t.toLowerCase().replace(/(^|\.\s+)\w/g, (x) => x.toUpperCase()) : t,
        (pt) => { b.texto = caixaAlta ? pt.toUpperCase() : pt; });
    }
  });

  const pt = await traduzirTextos(textos, api, progresso);
  pt.forEach((t, i) => destinos[i](t));
  return saida;
}
