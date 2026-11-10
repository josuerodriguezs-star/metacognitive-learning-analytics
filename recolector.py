"""
Recolector de endurance.

Jala desde Cloudflare los enlaces de conversaciones que esperan en la fila,
los lee con el extractor (Playwright), quita correos y teléfonos y guarda el
resultado en la MongoDB local. Solo hace conexiones DE SALIDA (hacia el Worker
y hacia chatgpt.com): endurance no necesita ningún puerto abierto.

Uso:
    python recolector.py             # sigue jalando hasta que lo detengas
    python recolector.py --una-vez   # vacía la fila y termina

Variables de entorno:
    WORKER_URL     https://conversaciones.yohual.com
    PULLER_TOKEN   el mismo valor que el secreto PULLER_TOKEN del Worker
    MONGODB_URI    mongodb://usuario:clave@mongo:27017/transcripts
    INTERVALO_SEG  cada cuánto preguntar por trabajos nuevos (15)
    TIEMPO_MAX_EXTRACCION_SEG  límite por conversación (150)

Nunca se escribe en el log el enlace ni el texto de una conversación.
"""

import argparse
import asyncio
import logging
import os
import signal
import sys
from datetime import datetime, timezone
from typing import Awaitable, Callable, List, Optional
from urllib.parse import urlsplit

import httpx

import extractor
import seguridad

log = logging.getLogger("recolector")

MSG_TIEMPO = "La conversación tardó demasiado en cargarse. Inténtalo de nuevo en unos minutos."
MSG_INTERNO = "Algo salió mal de nuestro lado. Inténtalo de nuevo en unos minutos."


# ============================================================
# Cliente del Worker
# ============================================================

class ClienteWorker:
    def __init__(self, base_url: str, token: str, http: Optional[httpx.AsyncClient] = None):
        partes = urlsplit(base_url)
        es_local = partes.hostname in ("localhost", "127.0.0.1")
        if partes.scheme != "https" and not es_local:
            raise ValueError("WORKER_URL debe empezar con https://")
        self.base = base_url.rstrip("/")
        self.http = http or httpx.AsyncClient(
            timeout=20,
            headers={"Authorization": f"Bearer {token}", "User-Agent": "yohual-recolector/1.0"},
        )

    async def _post(self, ruta: str, cuerpo: dict) -> dict:
        r = await self.http.post(self.base + ruta, json=cuerpo)
        r.raise_for_status()
        return r.json()

    async def pendientes(self, maximo: int = 1) -> List[dict]:
        return (await self._post("/interno/pendientes", {"max": maximo}))["trabajos"]

    async def latido(self) -> None:
        await self._post("/interno/latido", {})

    async def fase(self, job_id: str, fase: str, turnos: Optional[List[str]] = None) -> None:
        cuerpo = {"id": job_id, "fase": fase}
        if turnos is not None:
            cuerpo["turnos"] = turnos
        await self._post("/interno/fase", cuerpo)

    async def resultado(self, job_id: str, ok: bool, turnos: Optional[List[str]] = None,
                        error: Optional[str] = None) -> None:
        await self._post("/interno/resultado", {"id": job_id, "ok": ok, "turnos": turnos or [], "error": error})

    async def apagado(self) -> None:
        await self._post("/interno/apagado", {})

    async def cerrar(self) -> None:
        await self.http.aclose()


# ============================================================
# Almacenamiento local (MongoDB en un contenedor aislado)
# ============================================================

class BodegaMongo:
    def __init__(self, uri: str, base: str = "transcripts", coleccion: str = "conversaciones_participantes"):
        from pymongo import MongoClient

        self._col = MongoClient(uri, serverSelectionTimeoutMS=10000)[base][coleccion]
        self._col.create_index("job_id", unique=True)

    def guardar(self, documento: dict) -> None:
        # Se reemplaza por job_id: si un resultado no llegó al Worker y el
        # trabajo se repite, no queda duplicado.
        self._col.replace_one({"job_id": documento["job_id"]}, documento, upsert=True)


# ============================================================
# Procesamiento
# ============================================================

Extraer = Callable[[str, Optional[Callable[[str], Awaitable[None]]]], Awaitable[dict]]


def _iso(ts) -> str:
    try:
        return datetime.fromtimestamp(float(ts), timezone.utc).isoformat()
    except (TypeError, ValueError):
        return ""


class Recolector:
    def __init__(self, api: ClienteWorker, bodega, extraer: Extraer = extractor.extraer_enlace,
                 tiempo_max: float = 150):
        self.api = api
        self.bodega = bodega
        self.extraer = extraer
        self.tiempo_max = tiempo_max

    async def _avisar_fase(self, job_id: str, fase: str, turnos: Optional[List[str]] = None) -> None:
        """El avance es solo informativo: si falla, no se detiene la lectura."""
        try:
            await self.api.fase(job_id, fase, turnos)
        except Exception as e:
            log.warning("No se pudo avisar la fase %s del trabajo %s: %s", fase, job_id, type(e).__name__)

    async def procesar(self, trabajo: dict) -> None:
        job_id = trabajo["id"]

        # Segunda validación: el navegador solo visita enlaces que este código acepta,
        # aunque la fila en la nube llegara a contener algo distinto.
        enlace, plataforma, error = seguridad.validar_enlace(trabajo.get("enlace"))
        if error:
            await self.api.resultado(job_id, False, error=error)
            return

        try:
            async def al_cambiar_fase(fase: str) -> None:
                await self._avisar_fase(job_id, fase)

            resultado = await asyncio.wait_for(self.extraer(enlace, al_cambiar_fase), timeout=self.tiempo_max)
            anonimo = seguridad.anonimizar_resultado(resultado)
            roles = [t.get("role") for t in anonimo.get("turns", []) if t.get("role") in ("user", "assistant")]
            await self._avisar_fase(job_id, "procesando", roles)
        except extractor.ErrorDeExtraccion as e:
            await self.api.resultado(job_id, False, error=str(e))
            return
        except asyncio.TimeoutError:
            await self.api.resultado(job_id, False, error=MSG_TIEMPO)
            return
        except Exception as e:
            log.error("Fallo inesperado al leer el trabajo %s: %s", job_id, type(e).__name__)
            await self.api.resultado(job_id, False, error=MSG_INTERNO)
            return

        await self._avisar_fase(job_id, "guardando")
        documento = {
            "job_id": job_id,
            "participante_id": trabajo["participante_id"],
            "plataforma": plataforma or trabajo.get("plataforma") or "ChatGPT",
            "enlace_hash": seguridad.hash_enlace(enlace),
            "version_consentimiento": trabajo.get("version_consentimiento", ""),
            "recibido_en": _iso(trabajo.get("creado_ts")),
            "procesado_en": datetime.now(timezone.utc).isoformat(),
            "total_turnos": len(roles),
            "resultado_completo": anonimo,
        }
        try:
            await asyncio.to_thread(self.bodega.guardar, documento)
        except Exception as e:
            # Falla de almacenamiento: no es culpa de la persona. No se reporta;
            # el trabajo vuelve solo a la fila cuando vence su reserva.
            log.error("No se pudo guardar el trabajo %s en MongoDB: %s", job_id, type(e).__name__)
            raise ErrorDeAlmacenamiento() from e

        await self.api.resultado(job_id, True, turnos=roles)
        log.info("Trabajo %s listo (%d turnos).", job_id, len(roles))


class ErrorDeAlmacenamiento(Exception):
    pass


# ============================================================
# Bucle principal
# ============================================================

async def _esperar(detener: asyncio.Event, segundos: float) -> None:
    try:
        await asyncio.wait_for(detener.wait(), timeout=segundos)
    except asyncio.TimeoutError:
        pass


async def _latidos(api: ClienteWorker, detener: asyncio.Event, cada: float = 30) -> None:
    while not detener.is_set():
        await _esperar(detener, cada)
        if detener.is_set():
            return
        try:
            await api.latido()
        except Exception:
            pass


async def ejecutar(recolector: Recolector, una_vez: bool, intervalo: float, detener: asyncio.Event) -> int:
    espera_error = 5.0
    codigo = 0
    latidos = asyncio.create_task(_latidos(recolector.api, detener))
    try:
        while not detener.is_set():
            try:
                trabajos = await recolector.api.pendientes(1)
                espera_error = 5.0
            except Exception as e:
                log.warning("No se pudo consultar la fila (%s).", type(e).__name__)
                if una_vez:
                    codigo = 1
                    break
                await _esperar(detener, espera_error)
                espera_error = min(espera_error * 2, 300)
                continue

            if not trabajos:
                if una_vez:
                    break
                await _esperar(detener, intervalo)
                continue

            for trabajo in trabajos:
                try:
                    await recolector.procesar(trabajo)
                except ErrorDeAlmacenamiento:
                    if una_vez:
                        return 1
                    await _esperar(detener, 60)
                except Exception as e:
                    log.error("Fallo al procesar el trabajo %s: %s", trabajo.get("id"), type(e).__name__)
                    if una_vez:
                        codigo = 1
    finally:
        detener.set()
        latidos.cancel()
        try:
            await asyncio.wait_for(recolector.api.apagado(), timeout=5)
        except Exception:
            pass
    return codigo


def _requerida(nombre: str) -> str:
    valor = os.environ.get(nombre)
    if not valor:
        sys.exit(f"Falta la variable de entorno {nombre}.")
    return valor


async def principal(argumentos: argparse.Namespace) -> int:
    token = _requerida("PULLER_TOKEN")
    if len(token) < 32:
        sys.exit("PULLER_TOKEN es demasiado corto (mínimo 32 caracteres).")

    api = ClienteWorker(_requerida("WORKER_URL"), token)
    bodega = BodegaMongo(_requerida("MONGODB_URI"))
    recolector = Recolector(api, bodega, tiempo_max=float(os.environ.get("TIEMPO_MAX_EXTRACCION_SEG", "150")))

    detener = asyncio.Event()
    bucle = asyncio.get_running_loop()
    for senal in (signal.SIGTERM, signal.SIGINT):
        bucle.add_signal_handler(senal, detener.set)

    log.info("Recolector en marcha (%s).", "una vez" if argumentos.una_vez else "continuo")
    try:
        return await ejecutar(recolector, argumentos.una_vez, float(os.environ.get("INTERVALO_SEG", "15")), detener)
    finally:
        await api.cerrar()


def main() -> None:
    parser = argparse.ArgumentParser(description="Recolector de conversaciones de yohual")
    parser.add_argument("--una-vez", action="store_true", help="vacía la fila y termina")
    argumentos = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sys.exit(asyncio.run(principal(argumentos)))


if __name__ == "__main__":
    main()
