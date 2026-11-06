// Busca um arquivo no bucket R2 (binding LIVRO). Aceita os arquivos na raiz
// do bucket ou dentro de uma pasta "capitulos/" (caso o upload tenha criado a pasta),
// com o nome normal ou codificado (%20), conforme a ferramenta de upload usada.
export async function pegarObjeto(env, nome) {
  if (!env.LIVRO) throw new Error("Bucket R2 não ligado ao site (binding LIVRO).");
  const variantes = [nome, encodeURIComponent(nome)];
  for (const pasta of ["", "capitulos/"]) {
    for (const v of variantes) {
      const obj = await env.LIVRO.get(pasta + v);
      if (obj) return obj;
    }
  }
  return null;
}
