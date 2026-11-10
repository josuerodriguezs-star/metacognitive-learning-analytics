# Imagen del recolector. Se construye con el repositorio como contexto:
#   docker compose build   (desde la carpeta endurance/)
FROM mcr.microsoft.com/playwright/python:v1.47.0-jammy

WORKDIR /app

COPY endurance/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY extractor.py seguridad.py recolector.py extractor_v4_playwright.js ./

# Sin privilegios: el navegador que abre páginas de internet no corre como root.
USER pwuser
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "recolector.py"]
