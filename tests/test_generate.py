"""/generate (formulario de profesores) solo debe visitar enlaces de compartir permitidos."""

from fastapi.testclient import TestClient

import app as modulo_app


class ColeccionFalsa:
    def __init__(self):
        self.docs = []

    def insert_one(self, d):
        self.docs.append(d)


class _Chromium:
    @staticmethod
    async def launch(headless=True):
        class Navegador:
            async def new_context(self, user_agent=None):
                class Contexto:
                    async def new_page(self):
                        return object()

                return Contexto()

            async def close(self):
                pass

        return Navegador()


class _PlaywrightFalso:
    chromium = _Chromium

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def test_generate_no_visita_enlaces_no_permitidos(monkeypatch):
    coleccion = ColeccionFalsa()
    monkeypatch.setattr(modulo_app, "get_mongo_collection", lambda: coleccion)
    monkeypatch.setattr(modulo_app, "async_playwright", lambda: _PlaywrightFalso())
    monkeypatch.setattr(modulo_app.time, "sleep", lambda s: None)

    async def no_debe_llamarse(*a, **k):
        raise AssertionError("se intentó visitar un enlace no permitido")

    monkeypatch.setattr(modulo_app, "extraer_una_conversacion", no_debe_llamarse)

    malos = [
        "http://169.254.169.254/latest/meta-data/",
        "https://evil.com/share/abc-123",
        "https://chatgpt.com@evil.com/share/abc-123",
        "file:///etc/passwd",
    ]
    respuesta = TestClient(modulo_app.app).post("/generate", json={
        "curso": "c", "clave_materia": "k", "programa": "p", "arranque": "a",
        "actividad_nombre": "n", "actividad_numero": "1", "fecha_limite": "f",
        "alumnos": [{"nombre": f"Alumno {i}", "link": enlace} for i, enlace in enumerate(malos)],
    })

    assert respuesta.status_code == 200
    assert len(coleccion.docs) == len(malos)
    assert all(d["estado"] == "error" for d in coleccion.docs)
