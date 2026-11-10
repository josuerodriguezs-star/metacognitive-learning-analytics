import json
import pathlib

import pytest

import seguridad

CASOS = json.loads(
    (pathlib.Path(__file__).resolve().parent.parent / "compartido" / "casos_enlaces.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("caso", CASOS, ids=[repr(c["entrada"])[:50] for c in CASOS])
def test_enlaces_siguen_los_casos_compartidos_con_el_worker(caso):
    enlace, plataforma, error = seguridad.validar_enlace(caso["entrada"])
    assert enlace == caso["enlace"]
    assert plataforma == caso["plataforma"]
    assert bool(error) == caso["error"]


def test_claude_y_gemini_avisan_que_llegan_pronto():
    for url, nombre in [("https://claude.ai/share/abc-123", "Claude"), ("https://gemini.google.com/share/abc-123", "Gemini")]:
        _, plataforma, error = seguridad.validar_enlace(url)
        assert plataforma == nombre and "pronto" in error


def test_host_permitido():
    assert seguridad.host_permitido("https://chatgpt.com/share/x")
    assert not seguridad.host_permitido("http://chatgpt.com/share/x")
    assert not seguridad.host_permitido("https://evil.com/share/x")


def test_limpieza_de_datos_personales():
    assert seguridad.limpiar_texto("escribe a ana.lopez@uni.edu.mx ya") == "escribe a [correo] ya"
    assert "[teléfono]" in seguridad.limpiar_texto("llámame al +52 55 1234 5678")
    assert "[teléfono]" in seguridad.limpiar_texto("(55) 1234-5678")
    assert seguridad.limpiar_texto("Costó 1,234,567 y el año 2026") == "Costó 1,234,567 y el año 2026"


def test_anonimizar_quita_url_e_id_y_no_modifica_el_original():
    original = {
        "export_metadata": {"source_url": "https://chatgpt.com/share/abc-123"},
        "conversation_metadata": {"conversation_id": "abc-123", "total_turns": 1},
        "turns": [{"role": "user", "text_clean": "mi correo es ana@correo.com"}],
    }
    limpio = seguridad.anonimizar_resultado(original)
    assert limpio["export_metadata"]["source_url"] == ""
    assert limpio["conversation_metadata"]["conversation_id"] == ""
    assert "ana@correo.com" not in json.dumps(limpio)
    assert "ana@correo.com" in json.dumps(original)
