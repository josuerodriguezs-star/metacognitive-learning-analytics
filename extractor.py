"""
Extracción de una conversación compartida con Playwright.

Reutiliza extractor_v4_playwright.js sin cambios (scroll cuidadoso,
orden real por conversation-turn-N, content_blocks, quality_report).
"""

import os
import re
from typing import Awaitable, Callable, Optional

from playwright.async_api import async_playwright

from seguridad import host_permitido

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(_THIS_DIR, "extractor_v4_playwright.js"), "r", encoding="utf-8") as f:
    EXTRACTOR_JS = f.read()

COMBINED_SCRIPT = EXTRACTOR_JS + "\nreturn await window.__extractConversation();"


class ErrorDeExtraccion(Exception):
    """Error con mensaje apto para mostrarse a la persona."""


def limpiar_link(link: str) -> str:
    link = re.sub(r"[​‌‍﻿]", "", link or "")
    return link.strip()


async def extraer_una_conversacion(page, link: str) -> dict:
    await page.goto(link, wait_until="networkidle", timeout=45000)
    await page.wait_for_timeout(1500)
    return await page.evaluate("async () => {\n" + COMBINED_SCRIPT + "\n}")


FaseCallback = Callable[[str], Awaitable[None]]


async def extraer_enlace(enlace: str, al_cambiar_fase: Optional[FaseCallback] = None) -> dict:
    """Abre UN enlace de compartir ya validado y devuelve el resultado
    del extractor. Avisa las fases reales ("abriendo", "leyendo") para
    que la interfaz muestre progreso verdadero."""

    async def avisar(fase: str):
        if al_cambiar_fase:
            await al_cambiar_fase(fase)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            context = await browser.new_context(user_agent=USER_AGENT)
            page = await context.new_page()

            await avisar("abriendo")
            try:
                await page.goto(enlace, wait_until="networkidle", timeout=45000)
            except Exception:
                raise ErrorDeExtraccion(
                    "No pudimos abrir el enlace. Revisa que siga activo y vuelve a intentarlo."
                )

            # Una redirección no debe llevar a un sitio que no esté permitido.
            if not host_permitido(page.url):
                raise ErrorDeExtraccion("El enlace redirige a un sitio que no podemos leer.")

            await page.wait_for_timeout(1500)

            await avisar("leyendo")
            resultado = await page.evaluate("async () => {\n" + COMBINED_SCRIPT + "\n}")
        finally:
            await browser.close()

    if not isinstance(resultado, dict) or resultado.get("error"):
        raise ErrorDeExtraccion(
            "No pudimos leer la conversación. Comprueba que el enlace sea de una conversación compartida."
        )

    total = resultado.get("conversation_metadata", {}).get("total_turns", 0)
    if not total:
        raise ErrorDeExtraccion(
            "No encontramos mensajes en ese enlace. Revisa que la conversación esté compartida y que el enlace siga activo."
        )

    return resultado
