// Simula la API de D1 sobre node:sqlite para probar el Worker sin Cloudflare.
// Cubre lo que usa el Worker: prepare().bind().first()/all()/run() y errores
// de restricción únicos con el mismo texto que D1.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const ESQUEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

export function crearD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(ESQUEMA);

  return {
    _db: db,
    prepare(sql) {
      let parametros = [];
      const sentencia = {
        bind(...valores) {
          parametros = valores;
          return sentencia;
        },
        async first() {
          return db.prepare(sql).get(...parametros) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...parametros), meta: {} };
        },
        async run() {
          const r = db.prepare(sql).run(...parametros);
          return { meta: { changes: Number(r.changes) } };
        },
      };
      return sentencia;
    },
  };
}
