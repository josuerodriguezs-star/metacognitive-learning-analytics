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

export async function enviarCorreo(env, { para, asunto, texto, html, cabeceras }) {
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
      body: JSON.stringify({ from: env.MAIL_FROM, to: [para], subject: asunto, text: texto, html, ...(cabeceras ? { headers: cabeceras } : {}) }),
    });
  } catch (e) {
    throw new ErrorDeCorreo(`No se pudo contactar a Resend: ${e.message}`);
  }

  if (!respuesta.ok) {
    // No se registra el cuerpo para no filtrar datos del destinatario.
    throw new ErrorDeCorreo(`Resend respondió ${respuesta.status}.`);
  }
}

const NOMBRES_SERVICIO = {
  conversaciones: "el recolector de conversaciones",
  calendario: "el calendario de premios EdTech",
  simulador: "el simulador QS",
};

export function mensajeCodigo(codigo, servicio = "conversaciones") {
  const c = escapar(codigo);
  const nombre = NOMBRES_SERVICIO[servicio] || NOMBRES_SERVICIO.conversaciones;
  return {
    asunto: `Tu código de acceso: ${codigo}`,
    texto: `Tu código de acceso a ${nombre} es ${codigo}. Vence en 10 minutos. Si no lo pediste, puedes ignorar este mensaje.`,
    html: envolver([
      `Tu código para entrar a ${nombre}:`,
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

/** Un solo correo con todos los recordatorios del día de una persona. */
export function mensajeAlertas(alertas, urlBaja) {
  const lineas = alertas.map((a) => `• ${a.titulo}\n  ${a.detalle}${a.url ? `\n  ${a.url}` : ""}`);
  const baja = escapar(urlBaja);
  return {
    asunto: alertas.length === 1 ? alertas[0].titulo : `${alertas.length} avisos de premios EdTech`,
    texto: `Recordatorios de los premios que sigues:\n\n${lineas.join("\n\n")}\n\nConfirma siempre las bases oficiales. Para dejar de recibir estos avisos: ${urlBaja}`,
    html: envolver([
      "Recordatorios de los premios que sigues:",
      ...alertas.map((a) =>
        `<strong>${escapar(a.titulo)}</strong><br>${escapar(a.detalle)}` +
        (a.url ? `<br><a href="${escapar(a.url)}">Convocatoria oficial</a>` : "")),
      '<span style="font-size:13px;color:#555">Confirma siempre las bases oficiales antes de postular.</span>',
      `<span style="font-size:13px;color:#555"><a href="${baja}">Dejar de recibir estos avisos</a></span>`,
    ]),
  };
}
