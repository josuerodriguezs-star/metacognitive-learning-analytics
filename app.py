"""
Backend de extracción de transcripts — versión web (Render + MongoDB).

Reutiliza exactamente la misma lógica de extracción que ya validamos
en Colab (extractor_v4_playwright.js: scroll cuidadoso, orden real por
conversation-turn-N, texto estable, content_blocks para listas/tablas).

Diferencia respecto a la versión anterior: el registro estructurado de
cada conversación (metadatos + turnos completos) se guarda en MongoDB
en vez de Google Sheets/Drive -- evita por completo la fricción de
cuentas de servicio, cuotas de almacenamiento y permisos de Unidades
compartidas. El .docx para el profesor se sigue generando al vuelo y
entregando en un .zip, sin persistirse en ningún lado.
"""

import io
import logging
import os
import re
import time
import zipfile
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from pymongo import MongoClient
import certifi

from docx import Document
from docx.shared import Pt, RGBColor

from playwright.async_api import async_playwright

# La lógica del navegador vive en extractor.py y se comparte con el
# recolector de endurance (recolector.py).
from extractor import USER_AGENT, limpiar_link, extraer_una_conversacion
from seguridad import validar_enlace


# ============================================================
# Configuración / conexión a MongoDB
# ============================================================

_mongo_client = None


def get_mongo_collection():
    """Conecta (una sola vez, reutilizando la conexión) a la colección
    donde se guarda un documento por conversación. La cadena de
    conexión completa (con usuario/contraseña) vive en la variable de
    entorno MONGODB_URI -- nunca en el código."""
    global _mongo_client
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        raise RuntimeError(
            "Falta la variable de entorno MONGODB_URI "
            "(cadena de conexión completa de tu clúster de MongoDB Atlas)."
        )
    if _mongo_client is None:
        _mongo_client = MongoClient(uri, tlsCAFile=certifi.where())
    db_name = os.environ.get("MONGODB_DB_NAME", "transcripts")
    coleccion_name = os.environ.get("MONGODB_COLLECTION_NAME", "conversaciones")
    return _mongo_client[db_name][coleccion_name]


# ============================================================
# Modelos de la petición
# ============================================================

class Alumno(BaseModel):
    nombre: str
    link: str
    fecha_envio: Optional[str] = ""


class ActividadRequest(BaseModel):
    curso: str
    clave_materia: str
    programa: str
    arranque: str
    actividad_nombre: str
    actividad_numero: str
    fecha_limite: str
    alumnos: List[Alumno]


# ============================================================
# Utilidades
# ============================================================

def extraer_resumen_adjuntos(resultado: dict) -> list:
    turns = resultado.get("turns", [])
    nombres_vistos = []
    for t in turns:
        for a in t.get("attachments", []):
            nombre = (a.get("name") or "").strip()
            if nombre and nombre not in nombres_vistos:
                nombres_vistos.append(nombre)
        for f in t.get("files_mentioned", []):
            nombre = (f.get("name") or "").strip()
            if nombre and nombre not in nombres_vistos:
                nombres_vistos.append(nombre)
    return nombres_vistos


def guardar_registro(coleccion, alumno: Alumno, req: ActividadRequest, resultado: dict = None, error: str = None):
    """Un documento por conversación (o por intento fallido), con los
    metadatos de la actividad + el resultado completo del extractor
    (todos los turnos, adjuntos, quality_report) tal cual -- sin
    aplanar nada, MongoDB guarda el JSON anidado directamente."""
    documento = {
        "nombre_alumno": alumno.nombre,
        "link": alumno.link,
        "fecha_envio": alumno.fecha_envio or "",
        "curso": req.curso,
        "clave_materia": req.clave_materia,
        "programa": req.programa,
        "arranque": req.arranque,
        "actividad_nombre": req.actividad_nombre,
        "actividad_numero": req.actividad_numero,
        "fecha_limite": req.fecha_limite,
        "procesado_en": datetime.now(timezone.utc).isoformat(),
    }

    if resultado is not None:
        conv_meta = resultado.get("conversation_metadata", {})
        documento.update({
            "estado": "ok",
            "conversation_id": conv_meta.get("conversation_id", ""),
            "total_turnos": conv_meta.get("total_turns", 0),
            "adjuntos": extraer_resumen_adjuntos(resultado),
            "resultado_completo": resultado,  # export_metadata, turns, analysis_units, quality_report
        })
    else:
        documento.update({
            "estado": "error",
            "error": error or "Error desconocido",
        })

    coleccion.insert_one(documento)


# ============================================================
# .docx: mismo contenido/estructura que ya validamos (listas,
# numeradas, tablas), sin cambios respecto a la versión anterior.
# ============================================================

def fusionar_fragmentos_cortos(bloques: list) -> list:
    """Ciertos elementos de la p\u00e1gina (tarjetas de producto, precios,
    vi\u00f1etas sueltas) se capturan como muchos parrafos de una sola l\u00ednea
    seguidos. Los juntamos en un solo p\u00e1rrafo cuando son fragmentos
    cortos consecutivos, para que no se vean como l\u00edneas sueltas sin
    sentido en el documento final."""
    UMBRAL = 40
    resultado = []
    buffer = []

    def flush():
        if buffer:
            resultado.append({"type": "paragraph", "text": " ".join(buffer)})
            buffer.clear()

    for cb in bloques:
        if cb.get("type") == "paragraph":
            texto = (cb.get("text") or "").strip()
            if not texto:
                continue
            es_fragmento_corto = (
                len(texto) < UMBRAL
                and not texto.endswith((":", ".", "!", "?"))
                and not re.match(r"^\d+[\.\)]", texto)
            )
            if es_fragmento_corto:
                buffer.append(texto)
                continue
            flush()
            resultado.append({"type": "paragraph", "text": texto})
        else:
            flush()
            resultado.append(cb)

    flush()
    return resultado


def construir_docx(resultado: dict, alumno: Alumno, req: ActividadRequest) -> bytes:
    meta = resultado.get("export_metadata", {})
    conv_meta = resultado.get("conversation_metadata", {})
    turns = resultado.get("turns", [])

    doc = Document()

    doc.add_heading(meta.get("conversation_title") or "Transcript de conversación", level=0)

    info = doc.add_paragraph()
    info.add_run(
        f"URL: {meta.get('source_url', '')}\n"
        f"Extraído: {meta.get('exported_at', '')}\n"
        f"Turnos totales: {conv_meta.get('total_turns', 0)} "
        f"(usuario: {conv_meta.get('total_user_turns', 0)}, "
        f"asistente: {conv_meta.get('total_assistant_turns', 0)})"
    )

    procedencia = doc.add_paragraph()
    procedencia.add_run(
        f"Curso: {req.curso} ({req.clave_materia})\n"
        f"Programa: {req.programa}\n"
        f"Arranque: {req.arranque}\n"
        f"Actividad: {req.actividad_numero} - {req.actividad_nombre}\n"
        f"Fecha de envío del alumno: {alumno.fecha_envio or 'N/D'}\n"
        f"Fecha límite de la actividad: {req.fecha_limite}"
    )

    doc.add_paragraph()  # separador antes de que arranque el diálogo

    for t in turns:
        # Los turnos con rol "unknown" son ruido del extractor (menú de
        # navegación, o una captura completa de la página antes de que
        # se identifiquen los turnos reales) -- se quedan en MongoDB
        # para análisis de calidad, pero no deben aparecer en el .docx
        # del profesor.
        if t.get("role") == "unknown":
            continue

        content_blocks = t.get("content_blocks")
        texto_plano = (t.get("text_clean") or "").strip()

        if not content_blocks and not texto_plano:
            continue

        # Etiqueta tipo "burbuja de chat" en vez de un encabezado grande
        # que corta el flujo -- una línea corta en negritas, con color
        # distinto seg\u00fan qui\u00e9n habla, como en la interfaz de ChatGPT.
        es_alumno = t.get("role") == "user"
        hablante = doc.add_paragraph()
        hablante.paragraph_format.space_before = Pt(14)
        hablante.paragraph_format.space_after = Pt(2)
        run = hablante.add_run("Alumno" if es_alumno else "Asistente (IA)")
        run.bold = True
        run.font.size = Pt(10)
        run.font.color.rgb = RGBColor(0x2E, 0x5C, 0x8A) if es_alumno else RGBColor(0x5A, 0x5A, 0x5A)

        bloques = content_blocks if content_blocks else [{"type": "paragraph", "text": texto_plano}]
        bloques = fusionar_fragmentos_cortos(bloques)

        for cb in bloques:
            tipo = cb.get("type")
            if tipo == "paragraph":
                texto = (cb.get("text") or "").strip()
                if texto:
                    doc.add_paragraph(texto)
            elif tipo == "bulleted_list":
                for item in cb.get("items", []):
                    item = item.strip()
                    if item:
                        doc.add_paragraph(item, style="List Bullet")
            elif tipo == "ordered_list":
                for item in cb.get("items", []):
                    item = item.strip()
                    if item:
                        doc.add_paragraph(item, style="List Number")
            elif tipo == "table":
                filas = [r for r in cb.get("rows", []) if r]
                if not filas:
                    continue
                celdas_por_fila = [f.split(" | ") for f in filas]
                num_cols = max(len(f) for f in celdas_por_fila)
                tabla = doc.add_table(rows=len(celdas_por_fila), cols=num_cols)
                tabla.style = "Light Grid Accent 1"
                for i, fila in enumerate(celdas_por_fila):
                    for j in range(num_cols):
                        tabla.cell(i, j).text = fila[j] if j < len(fila) else ""

    buffer = io.BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


# ============================================================
# App FastAPI
# ============================================================

app = FastAPI(title="Transcript Extractor Backend")

# El frontend vive en otro dominio (Vercel, subdominio de yohual.com),
# así que hay que permitirlo explícitamente. ALLOWED_ORIGINS acepta
# varios orígenes separados por coma, por ejemplo:
#   https://recolector.yohual.com,https://yohual.com
# (ALLOWED_ORIGIN, en singular, se sigue aceptando por compatibilidad.)
# Mientras no esté configurada se permite cualquier origen, para no
# bloquear las pruebas -- ajústalo antes de usarlo con datos reales.
_origenes_env = os.environ.get("ALLOWED_ORIGINS") or os.environ.get("ALLOWED_ORIGIN", "*")
_origenes = [o.strip() for o in _origenes_env.split(",") if o.strip()] or ["*"]
if "*" in _origenes:
    logging.getLogger("app").warning("CORS abierto a cualquier origen: define ALLOWED_ORIGINS.")
    _origenes = ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origenes,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)



@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/generate")
async def generate(req: ActividadRequest):
    if not req.alumnos:
        raise HTTPException(status_code=400, detail="La lista de alumnos está vacía.")

    try:
        coleccion = get_mongo_collection()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"No se pudo conectar a la base de datos: {e}")

    zip_buffer = io.BytesIO()

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(user_agent=USER_AGENT)
        page = await context.new_page()

        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for idx, alumno in enumerate(req.alumnos, start=1):
                link = limpiar_link(alumno.link)

                if not link:
                    guardar_registro(coleccion, alumno, req, error="Sin link")
                    continue

                # Solo se visitan enlaces de compartir permitidos: este
                # endpoint es público y no debe abrir cualquier sitio.
                link, _plataforma, error_enlace = validar_enlace(link)
                if error_enlace:
                    guardar_registro(coleccion, alumno, req, error=error_enlace)
                    continue

                try:
                    resultado = await extraer_una_conversacion(page, link)

                    if resultado.get("error"):
                        raise RuntimeError(resultado["error"])

                    total_turnos = resultado.get("conversation_metadata", {}).get("total_turns", 0)
                    if total_turnos == 0:
                        raise RuntimeError("El extractor no encontró turnos (0 mensajes detectados).")

                    docx_bytes = construir_docx(resultado, alumno, req)
                    nombre_archivo = f"Transcript - {alumno.nombre or f'alumno_{idx}'}.docx"
                    zf.writestr(nombre_archivo, docx_bytes)

                    guardar_registro(coleccion, alumno, req, resultado=resultado)

                except Exception as e:
                    guardar_registro(coleccion, alumno, req, error=str(e))

                time.sleep(1)  # cortesía hacia chatgpt.com/share

        await browser.close()

    zip_buffer.seek(0)
    nombre_zip = f"{req.actividad_numero} - {req.actividad_nombre} ({req.arranque})"
    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{nombre_zip}.zip"'},
    )
