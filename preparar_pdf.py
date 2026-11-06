"""
Passo 1 do Tradutor: diagnosticar e dividir o PDF original por capítulo.

Uso:
  1) Diagnóstico (rápido, não altera nada):
       python preparar_pdf.py "Livro.pdf"

  2) Dividir pelos marcadores (sumário) do PDF:
       python preparar_pdf.py "Livro.pdf" --dividir --nivel 1
     Use --filtro para ficar só com entradas que parecem capítulos, ex.:
       python preparar_pdf.py "Livro.pdf" --dividir --nivel 2 --filtro "^(Chapter|CHAPTER|\\d+)"

  3) Se o PDF NÃO tiver marcadores, dividir procurando um texto no topo da página:
       python preparar_pdf.py "Livro.pdf" --dividir --regex-pagina "^CHAPTER\\s+\\d+"

Saída: pasta "capitulos/" com um PDF por capítulo + capitulos.json (índice usado pelo site).

Requer: pip install pymupdf
"""
import argparse
import json
import re
import sys
from pathlib import Path

try:
    import pymupdf as fitz  # PyMuPDF
except ImportError:
    sys.exit("Falta a biblioteca PyMuPDF. Instale com:  pip install pymupdf")


def diagnostico(doc, caminho):
    n = doc.page_count
    tam_mb = Path(caminho).stat().st_size / 1e6
    print(f"Arquivo: {caminho}  ({tam_mb:,.0f} MB, {n} páginas)\n")

    # Camada de texto: amostra de 20 páginas espalhadas
    amostra = sorted({int(i * (n - 1) / 19) for i in range(20)}) if n > 1 else [0]
    com_texto = 0
    for i in amostra:
        txt = doc[i].get_text().strip()
        if len(txt) > 200:
            com_texto += 1
    print(f"Texto selecionável: {com_texto}/{len(amostra)} páginas da amostra têm texto.")
    if com_texto < len(amostra) * 0.5:
        print("  -> Parece ESCANEADO (imagem). Sem problema: o Gemini lê a imagem da página.")
    else:
        print("  -> Tem texto. Ótimo.")

    # Imagens
    imgs = sum(len(doc[i].get_images()) for i in amostra)
    print(f"Imagens na amostra: {imgs} (média {imgs / len(amostra):.1f}/página)\n")

    # Marcadores
    toc = doc.get_toc(simple=True)
    if not toc:
        print("Marcadores (sumário): NENHUM. Vamos dividir com --regex-pagina.")
    else:
        niveis = {}
        for nivel, _, _ in toc:
            niveis[nivel] = niveis.get(nivel, 0) + 1
        print(f"Marcadores: {len(toc)} no total. Por nível: {niveis}")
        for nivel in sorted(niveis)[:3]:
            print(f"\n  Primeiros do nível {nivel}:")
            for lv, titulo, pag in [t for t in toc if t[0] == nivel][:12]:
                print(f"    p.{pag:>5}  {titulo[:90]}")
    print("\nCole essa saída para o Claude para escolher o jeito certo de dividir.")


def limpar_texto(s):
    """Remove caracteres de controle invisíveis (ex.: \\x00) vindos do sumário do PDF."""
    s = re.sub(r"[\x00﻿­]+", "", s)  # some sem deixar espaço ("Toe-\x00to" -> "Toe-to")
    return re.sub(r"[\x01-\x1f\x7f]+", " ", s).strip()


def limpar_nome(s, maxlen=70):
    s = re.sub(r'[\\/:*?"<>|]+', " ", limpar_texto(s)).strip()
    s = re.sub(r"\s+", " ", s)
    return s[:maxlen].rstrip(" .")


def inicios_por_toc(doc, nivel, filtro):
    toc = doc.get_toc(simple=True)
    rx = re.compile(filtro) if filtro else None
    itens = []
    vistos = set()
    for lv, titulo, pag in toc:
        if (nivel and lv != nivel) or pag < 1:
            continue
        if rx and not rx.search(titulo.strip()):
            continue
        if pag in vistos:
            continue
        vistos.add(pag)
        itens.append((titulo.strip(), pag - 1))
    return itens


def inicios_por_regex(doc, padrao):
    rx = re.compile(padrao, re.MULTILINE)
    itens = []
    for i in range(doc.page_count):
        # só o terço superior da página
        r = doc[i].rect
        topo = fitz.Rect(r.x0, r.y0, r.x1, r.y0 + r.height / 3)
        txt = doc[i].get_text(clip=topo)
        m = rx.search(txt)
        if m:
            linhas = [l.strip() for l in txt[m.start():].splitlines() if l.strip()]
            titulo = " ".join(linhas[:2]) if linhas else f"Capítulo p{i + 1}"
            itens.append((titulo, i))
    return itens


def dividir(doc, itens, saida: Path):
    if not itens:
        sys.exit("Nenhum capítulo encontrado com esses critérios. Rode o diagnóstico e ajuste.")
    itens = sorted(itens, key=lambda t: t[1])
    saida.mkdir(parents=True, exist_ok=True)
    indice = []
    for k, (titulo, ini) in enumerate(itens):
        titulo = limpar_texto(titulo)
        fim = (itens[k + 1][1] - 1) if k + 1 < len(itens) else doc.page_count - 1
        fim = max(fim, ini)
        m = re.match(r"\s*(\d+)\s*[-–—.]?\s*(.*)", titulo)
        if m:  # usa o número real do capítulo ("12 - Wrist..." -> 012)
            num, titulo = int(m.group(1)), (m.group(2).strip() or titulo)
        else:
            num = k + 1
        nome = f"{num:03d} - {limpar_nome(titulo)}.pdf"
        if not (saida / nome).exists():  # pula capítulos já gerados
            novo = fitz.open()
            novo.insert_pdf(doc, from_page=ini, to_page=fim)
            novo.save(saida / nome, garbage=4, deflate=True)
            novo.close()
        tam = (saida / nome).stat().st_size
        indice.append({
            "id": f"{num:03d}",
            "titulo": titulo,
            "pagina_inicio": ini + 1,
            "pagina_fim": fim + 1,
            "paginas": fim - ini + 1,
            "arquivo": nome,
            "tamanho_mb": round(tam / 1e6, 1),
        })
        print(f"  {nome}  (p.{ini + 1}-{fim + 1}, {tam / 1e6:.1f} MB)")
    (saida / "capitulos.json").write_text(
        json.dumps(indice, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{len(indice)} capítulos salvos em: {saida.resolve()}")
    grandes = [c for c in indice if c["tamanho_mb"] > 95]
    if grandes:
        print(f"Atenção: {len(grandes)} arquivo(s) acima de 95 MB; vamos tratar no upload.")


def main():
    ap = argparse.ArgumentParser(description="Diagnostica e divide o PDF por capítulo.")
    ap.add_argument("pdf")
    ap.add_argument("--dividir", action="store_true")
    ap.add_argument("--nivel", type=int, default=0,
                    help="nível do marcador que é o capítulo (0 = todos os níveis)")
    ap.add_argument("--listar", action="store_true",
                    help="só lista os capítulos que seriam criados, sem gerar arquivos")
    ap.add_argument("--filtro", help="regex: só entradas do sumário que casam (ex.: ^Chapter)")
    ap.add_argument("--incluir", action="append",
                    help='capítulo manual "NUM:PAGINA_DO_PDF:Título" (pode repetir)')
    ap.add_argument("--regex-pagina", help="regex no topo da página que marca início de capítulo")
    ap.add_argument("--saida", default="capitulos")
    a = ap.parse_args()

    doc = fitz.open(a.pdf)
    if not (a.dividir or a.listar):
        diagnostico(doc, a.pdf)
        return
    if a.regex_pagina:
        itens = inicios_por_regex(doc, a.regex_pagina)
    else:
        itens = inicios_por_toc(doc, a.nivel, a.filtro)
    for extra in a.incluir or []:  # ex.: "42:1892:Replantation and Transplantation"
        partes = extra.split(":", 2)
        num, pag = int(partes[0]), int(partes[1])
        titulo = partes[2] if len(partes) > 2 else f"Capítulo {num}"
        itens = [it for it in itens if it[1] != pag - 1]
        itens.append((f"{num} - {titulo}", pag - 1))
    if a.listar:
        itens = sorted(itens, key=lambda t: t[1])
        for k, (t, ini) in enumerate(itens):
            fim = itens[k + 1][1] if k + 1 < len(itens) else doc.page_count
            print(f"  p.{ini + 1:>5}-{fim:<5} ({fim - ini:>3} pág.)  {t[:80]}")
        print(f"\n{len(itens)} capítulos encontrados.")
        return
    dividir(doc, itens, Path(a.saida))


if __name__ == "__main__":
    main()
