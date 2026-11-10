// Envío de correos con Resend.
//
// Variables: RESEND_API_KEY (secreto) y MAIL_FROM, por ejemplo
// "yohual <acceso@yohual.com>". El dominio debe estar verificado en Resend
// para poder escribir a cualquier destinatario.
//
// MODO_CORREO=consola imprime el mensaje en la terminal; solo para desarrollo.

const RESEND_URL = "https://api.resend.com/emails";

export class ErrorDeCorreo extends Error {}

function escapar(texto) {
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function envolver(parrafos) {
  const cuerpo = parrafos
    .map((p) => `<p style="font-size:16px;line-height:1.5;margin:0 0 16px">${p}</p>`)
    .join("");
  return `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px;color:#1b2140">${cuerpo}</div>`;
}

export async function enviarCorreo(env, { para, asunto, texto, html }) {
  if (env.MODO_CORREO === "consola") {
    console.log(`[MODO_CORREO=consola] a ${para} | ${asunto}\n${texto}`);
    return;
  }

  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    throw new ErrorDeCorreo("Falta RESEND_API_KEY o MAIL_FROM.");
  }

  let respuesta;
  try {
    respuesta = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [para], subject: asunto, text: texto, html }),
    });
  } catch (e) {
    throw new ErrorDeCorreo(`No se pudo contactar a Resend: ${e.message}`);
  }

  if (!respuesta.ok) {
    // No se registra el cuerpo para no filtrar datos del destinatario.
    throw new ErrorDeCorreo(`Resend respondió ${respuesta.status}.`);
  }
}

export function mensajeCodigo(codigo) {
  const c = escapar(codigo);
  return {
    asunto: `Tu código de acceso: ${codigo}`,
    texto: `Tu código de acceso es ${codigo}. Vence en 10 minutos. Si no lo pediste, puedes ignorar este mensaje.`,
    html: envolver([
      "Tu código para entrar al recolector de conversaciones:",
      `<span style="font-size:34px;letter-spacing:8px"><strong>${c}</strong></span>`,
      '<span style="font-size:14px;color:#555">Vence en 10 minutos. Si no lo pediste, puedes ignorar este mensaje.</span>',
    ]),
  };
}

export function mensajeListo(urlPublica) {
  const u = escapar(urlPublica);
  return {
    asunto: "Ya leímos tu conversación",
    texto: `Gracias por compartirla. Ya leímos tu conversación y quedó guardada. Si quieres compartir otra, entra a ${urlPublica}. Ya puedes borrar el enlace compartido si lo deseas.`,
    html: envolver([
      "Gracias por compartirla. Ya leímos tu conversación y quedó guardada.",
      `Si quieres compartir otra, entra a <a href="${u}">${u}</a>.`,
      "Ya puedes borrar el enlace compartido si lo deseas.",
    ]),
  };
}

export function mensajeError(urlPublica, motivo) {
  const u = escapar(urlPublica);
  const m = escapar(motivo);
  return {
    asunto: "No pudimos leer tu enlace",
    texto: `${motivo} Puedes volver a intentarlo en ${urlPublica}.`,
    html: envolver([m, `Puedes volver a intentarlo en <a href="${u}">${u}</a>.`]),
  };
}
