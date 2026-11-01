import streamlit as st
import google.generativeai as genai
import fitz
from docx import Document
from docx.shared import Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
import io
from PIL import Image

st.set_page_config(page_title="Tradutor Médico", layout="centered")
st.title("🩺 Tradutor e Formatador Automático")

api_key = st.text_input("Cole sua API Key do Google aqui:", type="password")
arquivo_pdf = st.file_uploader("Faça o upload do Livro Completo em PDF", type=["pdf"])

col1, col2 = st.columns(2)
with col1:
    pag_inicio = st.number_input("Página inicial do capítulo", min_value=1, value=1)
with col2:
    pag_fim = st.number_input("Página final do capítulo", min_value=1, value=1)

def configurar_colunas(doc):
    section = doc.sections[0]
    sectPr = section._sectPr
    cols = sectPr.xpath('./w:cols')[0]
    cols.set(qn('w:num'), '2')

def processar_pagina(imagem, api_key):
    genai.configure(api_key=api_key)
    model = genai.GenerativeModel('gemini-1.5-pro')
    prompt = """
    Traduza este texto médico para pt-BR. Mantenha o rigor técnico. 
    Devolva APENAS o texto traduzido formatado com as seguintes tags no início de cada linha/bloco:
    [TITULO_LARANJA] para títulos principais.
    [LEGENDA_AZUL] para legendas de imagens.
    [CAIXA_AZUL] para blocos de destaque.
    [NORMAL] para o restante do texto.
    Não adicione explicações.
    """
    response = model.generate_content([prompt, imagem])
    return response.text

def criar_docx(texto_processado):
    doc = Document()
    configurar_colunas(doc)
    
    linhas = texto_processado.split('\n')
    for linha in linhas:
        if not linha.strip():
            continue
            
        p = doc.add_paragraph()
        run = p.add_run()
        
        if linha.startswith('[TITULO_LARANJA]'):
            run.text = linha.replace('[TITULO_LARANJA]', '').strip()
            run.font.color.rgb = RGBColor(255, 255, 255)
            run.font.bold = True
            p.paragraph_format.shading = OxmlElement('w:shd')
            p.paragraph_format.shading.set(qn('w:fill'), 'ED7D31')
        elif linha.startswith('[LEGENDA_AZUL]'):
            run.text = linha.replace('[LEGENDA_AZUL]', '').strip()
            run.font.color.rgb = RGBColor(0, 112, 192)
            run.font.italic = True
            run.font.size = Pt(9)
        elif linha.startswith('[CAIXA_AZUL]'):
            run.text = linha.replace('[CAIXA_AZUL]', '').strip()
            run.font.color.rgb = RGBColor(255, 255, 255)
            run.font.bold = True
            p.paragraph_format.shading = OxmlElement('w:shd')
            p.paragraph_format.shading.set(qn('w:fill'), '4472C4')
        else:
            run.text = linha.replace('[NORMAL]', '').strip()