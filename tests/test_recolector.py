import asyncio
import json

import pytest

import extractor
import recolector
from recolector import ErrorDeAlmacenamiento, Recolector

ENLACE = "https://chatgpt.com/share/abc-123"

RESULTADO = {
    "export_metadata": {"source_url": ENLACE, "conversation_title": "Tarea"},
    "conversation_metadata": {"conversation_id": "abc-123", "total_turns": 4},
    "turns": [
        {"role": "user", "text_clean": "Mi correo es alumna@correo.com y mi cel 55 1234 5678"},
        {"role": "assistant", "text_clean": "Claro. Son 1,234,567 pesos."},
        {"role": "user", "text_clean": "Gracias"},
        {"role": "unknown", "text_clean": "menú"},
    ],
}


class ApiFalsa:
    """Registra lo que el recolector le dice al Worker."""

    def __init__(self, cola=None):
        self.cola = list(cola or [])
        self.fases = []
        self.resultados = []
        self.latidos = 0
        self.apagados = 0
        self.falla_pendientes = False

    async def pendientes(self, maximo=1):
        if self.falla_pendientes:
            raise RuntimeError("sin red")
        lote, self.cola = self.cola[:maximo], self.cola[maximo:]
        return lote

    async def latido(self):
        self.latidos += 1

    async def fase(self, job_id, fase, turnos=None):
        self.fases.append((job_id, fase, turnos))

    async def resultado(self, job_id, ok, turnos=None, error=None):
        self.resultados.append({"id": job_id, "ok": ok, "turnos": turnos, "error": error})

    async def apagado(self):
        self.apagados += 1


class BodegaFalsa:
    def __init__(self, falla=False):
        self.docs = {}
        self.falla = falla

    def guardar(self, doc):
        if self.falla:
            raise RuntimeError("mongo caído")
        self.docs[doc["job_id"]] = doc


def trabajo(job_id="j1", enlace=ENLACE):
    return {"id": job_id, "participante_id": "p1", "enlace": enlace, "plataforma": "ChatGPT",
            "version_consentimiento": "2026-11-v2", "creado_ts": 1790000000}


async def extractor_bueno(enlace, al_cambiar_fase=None):
    assert enlace == ENLACE
    for f in ("abriendo", "leyendo"):
        await al_cambiar_fase(f)
    return RESULTADO


def armar(extraer=extractor_bueno, bodega=None, cola=None, tiempo_max=5):
    api = ApiFalsa(cola)
    bodega = bodega or BodegaFalsa()
    return Recolector(api, bodega, extraer=extraer, tiempo_max=tiempo_max), api, bodega


@pytest.mark.asyncio
async def test_procesa_guarda_anonimizado_y_reporta_solo_roles():
    r, api, bodega = armar()
    await r.procesar(trabajo())

    assert api.resultados == [{"id": "j1", "ok": True, "turnos": ["user", "assistant", "user"], "error": None}]
    assert [f[1] for f in api.fases] == ["abriendo", "leyendo", "procesando", "guardando"]

    doc = bodega.docs["j1"]
    texto = json.dumps(doc, ensure_ascii=False)
    assert "alumna@correo.com" not in texto
    assert "55 1234 5678" not in texto
    assert "1,234,567" in texto
    assert ENLACE not in texto and "abc-123" not in texto
    assert doc["participante_id"] == "p1"
    assert doc["total_turnos"] == 3

    # Lo que sube a la nube no contiene ningún texto de la conversación
    assert "Gracias" not in json.dumps(api.fases) + json.dumps(api.resultados)


@pytest.mark.asyncio
async def test_no_visita_un_enlace_no_permitido_aunque_venga_de_la_fila():
    async def no_debe_llamarse(*a, **k):
        raise AssertionError("se intentó visitar un enlace no permitido")

    r, api, bodega = armar(extraer=no_debe_llamarse)
    for malo in ["https://evil.com/share/abc-123", "http://169.254.169.254/", "https://chatgpt.com@evil.com/share/x", ""]:
        await r.procesar(trabajo(enlace=malo))
    assert len(api.resultados) == 4 and not any(x["ok"] for x in api.resultados)
    assert bodega.docs == {}


@pytest.mark.asyncio
async def test_error_de_extraccion_se_reporta_con_su_mensaje():
    async def falla(enlace, cb=None):
        raise extractor.ErrorDeExtraccion("No encontramos mensajes en ese enlace.")

    r, api, bodega = armar(extraer=falla)
    await r.procesar(trabajo())
    assert api.resultados[0]["ok"] is False
    assert "No encontramos mensajes" in api.resultados[0]["error"]
    assert bodega.docs == {}


@pytest.mark.asyncio
async def test_tiempo_agotado():
    async def lento(enlace, cb=None):
        await asyncio.sleep(5)

    r, api, _ = armar(extraer=lento, tiempo_max=0.05)
    await r.procesar(trabajo())
    assert "tardó demasiado" in api.resultados[0]["error"]


@pytest.mark.asyncio
async def test_fallo_inesperado_no_filtra_detalles():
    async def revienta(enlace, cb=None):
        raise RuntimeError("detalle interno con /ruta/secreta")

    r, api, _ = armar(extraer=revienta)
    await r.procesar(trabajo())
    assert api.resultados[0]["error"] == recolector.MSG_INTERNO
    assert "secreta" not in json.dumps(api.resultados)


@pytest.mark.asyncio
async def test_si_mongo_falla_no_se_reporta_error_a_la_persona():
    r, api, _ = armar(bodega=BodegaFalsa(falla=True))
    with pytest.raises(ErrorDeAlmacenamiento):
        await r.procesar(trabajo())
    assert api.resultados == [], "el trabajo debe volver solo a la fila"


@pytest.mark.asyncio
async def test_si_el_aviso_de_fase_falla_la_lectura_sigue():
    r, api, bodega = armar()

    async def fase_rota(*a, **k):
        raise RuntimeError("red")

    api.fase = fase_rota
    await r.procesar(trabajo())
    assert api.resultados[0]["ok"] is True and "j1" in bodega.docs


@pytest.mark.asyncio
async def test_una_vez_vacia_la_fila_y_avisa_que_se_apaga():
    r, api, bodega = armar(cola=[trabajo("a"), trabajo("b", ENLACE)])
    codigo = await recolector.ejecutar(r, una_vez=True, intervalo=0.01, detener=asyncio.Event())
    assert codigo == 0
    assert set(bodega.docs) == {"a", "b"}
    assert [x["id"] for x in api.resultados] == ["a", "b"]
    assert api.apagados == 1


@pytest.mark.asyncio
async def test_una_vez_sin_red_termina_con_error():
    r, api, _ = armar()
    api.falla_pendientes = True
    assert await recolector.ejecutar(r, una_vez=True, intervalo=0.01, detener=asyncio.Event()) == 1


@pytest.mark.asyncio
async def test_modo_continuo_se_detiene_con_la_senal():
    r, api, bodega = armar(cola=[trabajo("a")])
    detener = asyncio.Event()
    tarea = asyncio.create_task(recolector.ejecutar(r, una_vez=False, intervalo=0.01, detener=detener))
    for _ in range(100):
        if "a" in bodega.docs:
            break
        await asyncio.sleep(0.01)
    detener.set()
    assert await asyncio.wait_for(tarea, 2) == 0
    assert "a" in bodega.docs and api.apagados == 1


def test_el_cliente_exige_https_salvo_en_local():
    with pytest.raises(ValueError):
        recolector.ClienteWorker("http://conversaciones.yohual.com", "t" * 40)
    recolector.ClienteWorker("https://conversaciones.yohual.com", "t" * 40)
    recolector.ClienteWorker("http://127.0.0.1:8787", "t" * 40)
