#!/usr/bin/env bash
# Prepara endurance: carpeta de datos para Mongo y archivo .env con contraseñas
# aleatorias. Se puede volver a ejecutar sin perder nada.
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || { echo "Instala Docker primero."; exit 1; }
DATOS="${DATOS_DIR:-/srv/yohual}"

sudo mkdir -p "$DATOS/mongo"
sudo chown 999:999 "$DATOS/mongo"     # 999 es el usuario "mongodb" dentro del contenedor
sudo chmod 700 "$DATOS/mongo"
echo "Carpeta de datos lista: $DATOS/mongo"

if [ -f .env ]; then
  echo ".env ya existe; no se toca."
else
  umask 077
  generar() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  cat > .env <<ENV
WORKER_URL=https://conversaciones.yohual.com
PULLER_TOKEN=$(generar)
MONGO_INITDB_ROOT_USERNAME=admin
MONGO_INITDB_ROOT_PASSWORD=$(generar)
MONGO_APP_USER=recolector
MONGO_APP_PASSWORD=$(generar)
ENV
  echo ".env creado con contraseñas nuevas."
fi
chmod 600 .env

echo
echo "Siguiente: pasa el PULLER_TOKEN al Worker sin mostrarlo en pantalla:"
echo "  grep '^PULLER_TOKEN=' .env | cut -d= -f2 | (cd ../worker && npx wrangler secret put PULLER_TOKEN)"
