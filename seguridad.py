"""
Utilidades de seguridad compartidas por el recolector de endurance y por
/generate (formulario de profesores).

- Validación estricta de los enlaces de "compartir" que se visitan con el
  navegador del servidor. La misma lógica vive en worker/src/seguridad.js y
  ambas se prueban con compartido/casos_enlaces.json.
- Limpieza básica de datos personales antes de guardar una conversación.
"""

import copy
import hashlib
import os
import re
from typing import Optional, Tuple
from urllib.parse import urlsplit

HOSTS_PERMITIDOS = {
    h.strip().lower()
    for h in os.environ.get("ENLACES_PERMITIDOS", "chatgpt.com,chat.openai.com").split(",")
    if h.strip()
}

_PLATAFORMAS_CONOCIDAS = {
    "chatgpt.com": "ChatGPT",
    "chat.openai.com": "ChatGPT",
    "claude.ai": "Claude",
    "gemini.google.com": "Gemini",
    "g.co": "Gemini",
}

_INVISIBLES = re.compile(r"[​‌‍﻿]")
_RUTA_COMPARTIR = re.compile(r"^/share/([A-Za-z0-9_-]{3,100})/?$")


def host_permitido(url: str) -> bool:
    try:
        partes = urlsplit(url)
        return partes.scheme == "https" and (partes.hostname or "").lower() in HOSTS_PERMITIDOS
    except Exception:
        return False


def validar_enlace(enlace: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """Devuelve (enlace_limpio, plataforma, mensaje_de_error).

    Solo acepta https://<host permitido>/share/<id>, sin credenciales, sin
    puerto y sin parámetros: lo demás se descarta."""
    enlace = _INVISIBLES.sub("", enlace or "").strip()
    if not enlace:
        return None, None, "Pega el enlace de tu conversación compartida."

    try:
        partes = urlsplit(enlace)
        host = (partes.hostname or "").lower()
        puerto = partes.port
    except ValueError:
        return None, None, "Ese enlace no parece válido. Cópialo de nuevo desde el botón Compartir."

    plataforma = _PLATAFORMAS_CONOCIDAS.get(host)

    if partes.scheme != "https" or not host:
        return None, plataforma, "El enlace debe empezar con https://"

    if host not in HOSTS_PERMITIDOS:
        if plataforma:
            return None, plataforma, (
                f"Por ahora solo recibimos enlaces de ChatGPT. Los de {plataforma} llegarán pronto."
            )
        return None, None, "Por ahora solo recibimos enlaces de ChatGPT, como https://chatgpt.com/share/…"

    if partes.username or partes.password or puerto is not None:
        return None, plataforma, "Ese enlace no parece válido. Cópialo de nuevo desde el botón Compartir."

    coincide = _RUTA_COMPARTIR.match(partes.path)
    if not coincide:
        return None, plataforma, (
            "Falta el identificador de la conversación. Usa el enlace que aparece "
            "al pulsar Compartir → Copiar enlace."
        )

    return f"https://{host}/share/{coincide.group(1)}", plataforma, None


# ============================================================
# Limpieza de datos personales (básica y declarada como tal)
# ============================================================

_RE_CORREO = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_RE_TELEFONO = re.compile(r"\+?\d[\d\s().-]{8,}\d")


def _reemplazar_telefono(m: "re.Match") -> str:
    digitos = sum(c.isdigit() for c in m.group(0))
    return "[teléfono]" if 10 <= digitos <= 15 else m.group(0)


def limpiar_texto(texto: str) -> str:
    texto = _RE_CORREO.sub("[correo]", texto)
    return _RE_TELEFONO.sub(_reemplazar_telefono, texto)


def _limpiar_recursivo(valor):
    if isinstance(valor, str):
        return limpiar_texto(valor)
    if isinstance(valor, list):
        return [_limpiar_recursivo(v) for v in valor]
    if isinstance(valor, dict):
        return {k: _limpiar_recursivo(v) for k, v in valor.items()}
    return valor


def anonimizar_resultado(resultado: dict) -> dict:
    """Copia del resultado del extractor sin correos ni teléfonos en el
    texto y sin la URL original ni el identificador de la conversación.
    No detecta nombres propios ni otros datos personales."""
    limpio = _limpiar_recursivo(copy.deepcopy(resultado))
    meta = limpio.get("export_metadata")
    if isinstance(meta, dict):
        meta["source_url"] = ""
    conv = limpio.get("conversation_metadata")
    if isinstance(conv, dict):
        conv["conversation_id"] = ""
    return limpio


def hash_enlace(enlace: str) -> str:
    return hashlib.sha256(enlace.encode()).hexdigest()
