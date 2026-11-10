#!/bin/sh
# Se ejecuta una sola vez, al crear la base de datos vacía. Crea un usuario con
# permisos solo sobre la base "transcripts": el recolector nunca usa el administrador.
set -e
mongosh --quiet "$MONGO_INITDB_DATABASE" --eval "
  db.createUser({
    user: '$MONGO_APP_USER',
    pwd: '$MONGO_APP_PASSWORD',
    roles: [{ role: 'readWrite', db: '$MONGO_INITDB_DATABASE' }]
  })
"
