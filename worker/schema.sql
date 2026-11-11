-- Esquema de D1. Es idempotente: se puede volver a ejecutar sin romper nada.
--   npx wrangler d1 execute yohual-conversaciones --remote --file=schema.sql
--
-- Aquí NUNCA se guarda el texto de las conversaciones. Solo correo,
-- consentimiento y la fila de enlaces pendientes (el enlace se borra en
-- cuanto endurance termina de leerlo).

CREATE TABLE IF NOT EXISTS codigos (
  email_hash  TEXT PRIMARY KEY,
  codigo_hash TEXT NOT NULL,
  expira_ts   INTEGER NOT NULL,
  intentos    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS participantes (
  id                     TEXT PRIMARY KEY,
  email                  TEXT NOT NULL,
  email_hash             TEXT NOT NULL UNIQUE,
  creado_ts              INTEGER NOT NULL,
  consentimiento_version TEXT,
  consentimiento_ts      INTEGER
);

CREATE TABLE IF NOT EXISTS trabajos (
  id                     TEXT PRIMARY KEY,
  participante_id        TEXT NOT NULL,
  enlace                 TEXT,                       -- se pone en NULL al terminar
  enlace_hash            TEXT NOT NULL,
  plataforma             TEXT NOT NULL,
  version_consentimiento TEXT NOT NULL,
  estado                 TEXT NOT NULL DEFAULT 'en_cola',  -- en_cola | tomado | listo | error
  fase                   TEXT NOT NULL DEFAULT 'en_cola',
  turnos                 TEXT,                       -- JSON con los roles, p. ej. ["user","assistant"]
  error                  TEXT,
  creado_ts              INTEGER NOT NULL,
  tomado_ts              INTEGER,
  terminado_ts           INTEGER,
  ultima_consulta_ts     INTEGER,
  avisado                INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_trabajos_estado ON trabajos (estado, creado_ts);
CREATE INDEX IF NOT EXISTS ix_trabajos_persona ON trabajos (participante_id, creado_ts);
-- Una misma persona no puede mandar dos veces el mismo enlace, salvo que el primero haya fallado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trabajo_enlace
  ON trabajos (participante_id, enlace_hash) WHERE estado <> 'error';

CREATE TABLE IF NOT EXISTS limites (
  clave     TEXT NOT NULL,
  ventana   INTEGER NOT NULL,
  n         INTEGER NOT NULL,
  expira_ts INTEGER NOT NULL,
  PRIMARY KEY (clave, ventana)
);

CREATE TABLE IF NOT EXISTS meta (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Acceso compartido (conversaciones, calendario y simulador)
-- ---------------------------------------------------------------------------

-- Consentimiento por servicio y versión.
CREATE TABLE IF NOT EXISTS consentimientos (
  participante_id TEXT NOT NULL,
  servicio        TEXT NOT NULL,
  version         TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  PRIMARY KEY (participante_id, servicio)
);
-- Quien ya había aceptado el de conversaciones antes de esta tabla conserva su aceptación.
INSERT OR IGNORE INTO consentimientos (participante_id, servicio, version, ts)
  SELECT id, 'conversaciones', consentimiento_version, COALESCE(consentimiento_ts, creado_ts)
  FROM participantes WHERE consentimiento_version IS NOT NULL;

-- Envíos (p. ej. la encuesta del simulador): esperan aquí solo hasta que endurance los recoge;
-- entonces la carga se borra.
CREATE TABLE IF NOT EXISTS envios (
  id                     TEXT PRIMARY KEY,
  participante_id        TEXT NOT NULL,
  servicio               TEXT NOT NULL,
  tipo                   TEXT NOT NULL,
  carga                  TEXT,                        -- JSON; se pone en NULL al terminar
  id_cliente             TEXT,                        -- para que un reintento no duplique el envío
  version_consentimiento TEXT NOT NULL,
  estado                 TEXT NOT NULL DEFAULT 'en_cola',  -- en_cola | tomado | listo | error
  error                  TEXT,
  creado_ts              INTEGER NOT NULL,
  tomado_ts              INTEGER,
  terminado_ts           INTEGER
);
CREATE INDEX IF NOT EXISTS ix_envios_estado ON envios (estado, creado_ts);
CREATE INDEX IF NOT EXISTS ix_envios_persona ON envios (participante_id, servicio, creado_ts);
CREATE UNIQUE INDEX IF NOT EXISTS uq_envio_cliente
  ON envios (participante_id, servicio, id_cliente) WHERE id_cliente IS NOT NULL;

-- Lo que cada persona quiere seguir (p. ej. premios del calendario). Vive aquí, y no en
-- endurance, porque las alertas deben poder salir aunque endurance esté apagada.
CREATE TABLE IF NOT EXISTS suscripciones (
  participante_id TEXT NOT NULL,
  servicio        TEXT NOT NULL,
  clave           TEXT NOT NULL,
  creado_ts       INTEGER NOT NULL,
  PRIMARY KEY (participante_id, servicio, clave)
);

-- Recordatorios ya enviados (para no repetir el mismo aviso si el cron corre dos veces).
CREATE TABLE IF NOT EXISTS alertas_enviadas (
  participante_id TEXT NOT NULL,
  servicio        TEXT NOT NULL,
  clave           TEXT NOT NULL,
  fecha_evento    TEXT NOT NULL,
  dias            INTEGER NOT NULL,
  ts              INTEGER NOT NULL,
  PRIMARY KEY (participante_id, servicio, clave, fecha_evento, dias)
);
