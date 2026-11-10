import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  emitirToken, leerToken, normalizarEmail, hashEmail, generarCodigo, hashCodigo,
  iguales, hostsPermitidos, validarEnlace, TOKEN_VIGENCIA_SEG,
} from "../src/seguridad.js";

const SECRETO = "s".repeat(48);
const HOSTS = hostsPermitidos({});
const CASOS = JSON.parse(readFileSync(new URL("../../compartido/casos_enlaces.json", import.meta.url), "utf8"));

test("los enlaces siguen los casos compartidos con Python", () => {
  for (const caso of CASOS) {
    const r = validarEnlace(caso.entrada, HOSTS);
    assert.equal(r.enlace, caso.enlace, `enlace de ${JSON.stringify(caso.entrada)}`);
    assert.equal(r.plataforma, caso.plataforma, `plataforma de ${JSON.stringify(caso.entrada)}`);
    assert.equal(Boolean(r.error), caso.error, `error de ${JSON.stringify(caso.entrada)}`);
  }
});

test("Claude y Gemini avisan que llegarán pronto", () => {
  for (const url of ["https://claude.ai/share/abc-123", "https://gemini.google.com/share/abc-123"]) {
    assert.match(validarEnlace(url, HOSTS).error, /pronto/);
  }
});

test("token válido, manipulado y vencido", async () => {
  const token = await emitirToken(SECRETO, "abc");
  assert.equal(await leerToken(SECRETO, token), "abc");
  assert.equal(await leerToken(SECRETO, token.slice(0, -2) + "xx"), null);
  assert.equal(await leerToken("otro-secreto".repeat(5), token), null);
  assert.equal(await leerToken(SECRETO, "basura"), null);
  assert.equal(await leerToken(SECRETO, ""), null);
  assert.equal(await leerToken(SECRETO, token + ".extra"), null);
  assert.equal(await leerToken(SECRETO, token, Date.now() / 1000 + TOKEN_VIGENCIA_SEG + 5), null);
});

test("un token con el cuerpo cambiado no sirve", async () => {
  const token = await emitirToken(SECRETO, "persona-1");
  const [, firma] = token.split(".");
  const falso = btoa(JSON.stringify({ pid: "persona-2", exp: 9999999999 })).replace(/=+$/, "");
  assert.equal(await leerToken(SECRETO, `${falso}.${firma}`), null);
});

test("correos", async () => {
  assert.equal(normalizarEmail("  Ana@Correo.COM "), "ana@correo.com");
  assert.equal(normalizarEmail("no-es-correo"), null);
  assert.equal(normalizarEmail("a@b"), null);
  assert.equal(normalizarEmail("a@b.c"), null);
  assert.equal(normalizarEmail("x".repeat(250) + "@a.com"), null);
  assert.notEqual(await hashEmail(SECRETO, "a@a.com"), await hashEmail(SECRETO, "b@a.com"));
  assert.notEqual(await hashEmail(SECRETO, "a@a.com"), await hashEmail("otro".repeat(12), "a@a.com"));
});

test("códigos de 6 dígitos, distintos y ligados al correo", async () => {
  const vistos = new Set();
  for (let i = 0; i < 200; i++) {
    const c = generarCodigo();
    assert.match(c, /^\d{6}$/);
    vistos.add(c);
  }
  assert.ok(vistos.size > 150);
  assert.notEqual(await hashCodigo(SECRETO, "h1", "123456"), await hashCodigo(SECRETO, "h2", "123456"));
});

test("comparación en tiempo constante", () => {
  assert.equal(iguales("abc", "abc"), true);
  assert.equal(iguales("abc", "abd"), false);
  assert.equal(iguales("abc", "abcd"), false);
  assert.equal(iguales("", ""), true);
});
