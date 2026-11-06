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

// envia um lote de textos (separados por linha) ao Google, pelo Worker; se falhar, tenta direto
async function lote(textos, api) {
  const corpo = new URLSearchParams({ q: textos.join("\n") }).toString();
  const ler = (d) => (d?.[0] || []).map((s) => s?.[0] || "").join("");
  for (let tent = 1; tent <= 5; tent++) {
    try {
      const r = await api("/api/google", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: corpo });
      if (r.ok) return ler(await r.json()).split("\n");
      if (r.status !== 429 && r.status < 500) throw new Error("HTTP " + r.status);
    } catch (e) {
      try { // plano B: direto do navegador
        const r2 = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: corpo });
        if (r2.ok) return ler(await r2.json()).split("\n");
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 1500 * tent));
  }
  throw new Error("O Google Tradutor não respondeu. Tente de novo daqui a pouco.");
}

// traduz uma lista de textos mantendo a ordem (lotes de até ~4500 caracteres)
async function traduzirTextos(textos, api, progresso) {
  const saida = new Array(textos.length).fill("");
  const idx = textos.map((t, i) => [t, i]).filter(([t]) => t && t.trim());
  let i = 0, feitos = 0;
  while (i < idx.length) {
    const grupo = []; let tam = 0;
    while (i < idx.length && (grupo.length === 0 || tam + idx[i][0].length < 4500)) { grupo.push(idx[i]); tam += idx[i][0].length + 1; i++; }
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
