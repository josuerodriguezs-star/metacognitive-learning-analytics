// Utilidades de seguridad del Worker: tokens firmados, códigos, correo y
// validación estricta de enlaces. Solo usa WebCrypto, disponible en Workers
// y en Node 20+.

const enc = new TextEncoder();

// ------------------------------------------------------------------
// Base64 URL
// ------------------------------------------------------------------

export function aBase64Url(bytes) {
  let binario = "";
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function deBase64Url(texto) {
  const normal = texto.replace(/-/g, "+").replace(/_/g, "/");
  const relleno = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const binario = atob(relleno);
  return Uint8Array.from(binario, (c) => c.charCodeAt(0));
}

// ------------------------------------------------------------------
// HMAC
// ------------------------------------------------------------------

async function clave(secreto) {
  return crypto.subtle.importKey("raw", enc.encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function hmac(secreto, datos) {
  const firma = await crypto.subtle.sign("HMAC", await clave(secreto), datos);
  return new Uint8Array(firma);
}

function aHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(texto) {
  return aHex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(texto))));
}

/** Comparación en tiempo constante entre dos cadenas. */
export function iguales(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diferencia = x.length ^ y.length;
  const largo = Math.max(x.length, y.length);
  for (let i = 0; i < largo; i++) diferencia |= (x[i] || 0) ^ (y[i] || 0);
  return diferencia === 0;
}

// ------------------------------------------------------------------
// Correo y códigos
// ------------------------------------------------------------------

const RE_CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

export function normalizarEmail(email) {
  const limpio = String(email || "").trim().toLowerCase();
  if (limpio.length > 254 || !RE_CORREO.test(limpio)) return null;
  return limpio;
}

/** Hash con HMAC (no un SHA simple: los correos son fáciles de adivinar). */
export async function hashEmail(secreto, email) {
  return aHex(await hmac(secreto, enc.encode("email:" + email)));
}

/** Código de 6 dígitos sin sesgo de módulo. */
export function generarCodigo() {
  const n = new Uint32Array(1);
  do {
    crypto.getRandomValues(n);
  } while (n[0] >= 4294000000); // múltiplo de 1,000,000
  return String(n[0] % 1000000).padStart(6, "0");
}

export async function hashCodigo(secreto, emailHash, codigo) {
  return aHex(await hmac(secreto, enc.encode(`codigo:${emailHash}:${codigo}`)));
}

// ------------------------------------------------------------------
// Tokens de sesión
// ------------------------------------------------------------------

export const TOKEN_VIGENCIA_SEG = 2 * 60 * 60;

export async function emitirToken(secreto, participanteId, ahora = Date.now() / 1000) {
  const carga = enc.encode(JSON.stringify({ pid: participanteId, exp: Math.floor(ahora + TOKEN_VIGENCIA_SEG) }));
  const firma = await hmac(secreto, carga);
  return `${aBase64Url(carga)}.${aBase64Url(firma)}`;
}

/** Devuelve el participante_id si el token es válido y vigente; si no, null. */
export async function leerToken(secreto, token, ahora = Date.now() / 1000) {
  try {
    const [parteCarga, parteFirma, sobrante] = String(token || "").split(".");
    if (!parteCarga || !parteFirma || sobrante !== undefined) return null;
    const carga = deBase64Url(parteCarga);
    const esperada = await hmac(secreto, carga);
    if (!iguales(aBase64Url(esperada), parteFirma)) return null;
    const datos = JSON.parse(new TextDecoder().decode(carga));
    if (typeof datos.pid !== "string" || !(Number(datos.exp) >= ahora)) return null;
    return datos.pid;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Enlaces de "compartir" (la misma lógica y los mismos casos que seguridad.py)
// ------------------------------------------------------------------

const PLATAFORMAS_CONOCIDAS = {
  "chatgpt.com": "ChatGPT",
  "chat.openai.com": "ChatGPT",
  "claude.ai": "Claude",
  "gemini.google.com": "Gemini",
  "g.co": "Gemini",
};

const INVISIBLES = /[​‌‍﻿]/g;
const RUTA_COMPARTIR = /^\/share\/([A-Za-z0-9_-]{3,100})\/?$/;

export function hostsPermitidos(env) {
  const lista = (env && env.ENLACES_PERMITIDOS) || "chatgpt.com,chat.openai.com";
  return new Set(lista.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
}

/**
 * Devuelve { enlace, plataforma, error }.
 * Solo acepta https://<host permitido>/share/<id>, sin credenciales, sin
 * puerto y sin parámetros: el resto se descarta.
 */
export function validarEnlace(entrada, hosts) {
  const texto = String(entrada || "").replace(INVISIBLES, "").trim();
  if (!texto) return { enlace: null, plataforma: null, error: "Pega el enlace de tu conversación compartida." };

  let url;
  try {
    url = new URL(texto);
  } catch {
    return { enlace: null, plataforma: null, error: "Ese enlace no parece válido. Cópialo de nuevo desde el botón Compartir." };
  }

  const host = url.hostname.toLowerCase();
  const plataforma = PLATAFORMAS_CONOCIDAS[host] || null;

  if (url.protocol !== "https:" || !host) {
    return { enlace: null, plataforma, error: "El enlace debe empezar con https://" };
  }

  if (!hosts.has(host)) {
    if (plataforma) {
      return { enlace: null, plataforma, error: `Por ahora solo recibimos enlaces de ChatGPT. Los de ${plataforma} llegarán pronto.` };
    }
    return { enlace: null, plataforma: null, error: "Por ahora solo recibimos enlaces de ChatGPT, como https://chatgpt.com/share/…" };
  }

  if (url.username || url.password || url.port) {
    return { enlace: null, plataforma, error: "Ese enlace no parece válido. Cópialo de nuevo desde el botón Compartir." };
  }

  const coincide = RUTA_COMPARTIR.exec(url.pathname);
  if (!coincide) {
    return {
      enlace: null,
      plataforma,
      error: "Falta el identificador de la conversación. Usa el enlace que aparece al pulsar Compartir → Copiar enlace.",
    };
  }

  return { enlace: `https://${host}/share/${coincide[1]}`, plataforma, error: null };
}
