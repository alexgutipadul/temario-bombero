#!/usr/bin/env node
/*
 * Revisa las páginas listadas en fuentes-oposiciones.json en busca de
 * convocatorias nuevas de oposiciones de Bombero en Almería y Granada.
 * Si encuentra alguna nueva: la añade como "aviso" en Firestore (misma
 * colección que usa el panel de admin de la plataforma, así aparece con
 * la campanita dentro de la app) y envía un correo.
 *
 * Variables de entorno requeridas (configúralas como Secrets del repo
 * en GitHub: Settings → Secrets and variables → Actions):
 *   ANTHROPIC_API_KEY         - para extraer las convocatorias de cada página
 *   FIREBASE_SERVICE_ACCOUNT  - JSON completo de una cuenta de servicio de Firebase
 *   GMAIL_USER                - cuenta de Gmail que envía el correo
 *   GMAIL_APP_PASSWORD        - contraseña de aplicación de esa cuenta de Gmail
 *   AVISO_EMAIL_DESTINO       - (opcional) a quién avisar; por defecto GMAIL_USER
 *
 * Si falta algún secret, el script no falla: simplemente se salta esa
 * parte (lo avisa por log) para que puedas activar las piezas poco a poco.
 */

const fs = require("fs");
const path = require("path");

const FUENTES_PATH = path.join(__dirname, "fuentes-oposiciones.json");
const SEEN_PATH = path.join(__dirname, "..", "data", "avisos-oposiciones-seen.json");

function cargarJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function limpiarHTML(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function pedirConvocatoriasAClaude(fuente, textoPagina) {
  const prompt = `Esta es una copia de texto (sin HTML) de la página "${fuente.nombre}" (${fuente.url}), que lista oposiciones de Bombero en la provincia de ${fuente.provincia}.

Extrae SOLO las convocatorias que parecen activas o recientes (plazo abierto, recién publicadas, o en proceso). Para cada una, da un título corto que incluya el organismo convocante (ayuntamiento, consorcio, diputación...) y el número de plazas si se menciona.

Responde ÚNICAMENTE con un JSON válido, sin texto adicional, con esta forma exacta:
{"convocatorias": [{"titulo": "...", "clave": "..."}]}

"clave" es un identificador corto y estable para esa convocatoria (minúsculas, sin acentos, guiones en vez de espacios) que no cambie aunque cambie el redactado de la página, para poder detectar si ya la vimos antes. Si no hay ninguna convocatoria clara, responde {"convocatorias": []}.

Texto de la página:
"""
${textoPagina.slice(0, 12000)}
"""`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  const texto = (data.content || []).map((b) => b.text || "").join("");
  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed.convocatorias) ? parsed.convocatorias : [];
  } catch {
    return [];
  }
}

async function main() {
  const { fuentes } = cargarJSON(FUENTES_PATH, { fuentes: [] });
  const vistos = cargarJSON(SEEN_PATH, {});
  const nuevas = [];

  for (const fuente of fuentes) {
    let html;
    try {
      const resp = await fetch(fuente.url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; TemarioBomberoBot/1.0)" },
      });
      html = await resp.text();
    } catch (e) {
      console.error(`No se pudo descargar ${fuente.url}:`, e.message);
      continue;
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn("ANTHROPIC_API_KEY no está configurado: no se puede analizar ninguna fuente.");
      break;
    }

    const texto = limpiarHTML(html);
    let convocatorias = [];
    try {
      convocatorias = await pedirConvocatoriasAClaude(fuente, texto);
    } catch (e) {
      console.error(`Fallo al analizar ${fuente.id} con IA:`, e.message);
      continue;
    }

    vistos[fuente.id] = vistos[fuente.id] || [];
    for (const c of convocatorias) {
      if (!c || !c.clave) continue;
      if (!vistos[fuente.id].includes(c.clave)) {
        vistos[fuente.id].push(c.clave);
        nuevas.push({ ...c, fuente });
      }
    }
  }

  if (nuevas.length === 0) {
    console.log("Sin novedades.");
    fs.writeFileSync(SEEN_PATH, JSON.stringify(vistos, null, 2) + "\n");
    return;
  }

  console.log(`Encontradas ${nuevas.length} convocatoria(s) nueva(s).`);

  // --- Firestore: crear un aviso dentro de la app (misma colección "avisos" que usa el panel de admin) ---
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const admin = require("firebase-admin");
    const credenciales = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(credenciales) });
    const db = admin.firestore();
    for (const n of nuevas) {
      await db.collection("avisos").add({
        titulo: `Nueva oposición de Bombero (${n.fuente.provincia}): ${n.titulo}`,
        cuerpo: `Detectada automáticamente en ${n.fuente.nombre}. Consulta la convocatoria oficial: ${n.fuente.url}`,
        fecha: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } else {
    console.warn("FIREBASE_SERVICE_ACCOUNT no está configurado: no se ha publicado el aviso dentro de la app.");
  }

  // --- Email ---
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    const nodemailer = require("nodemailer");
    const transporte = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    const destino = process.env.AVISO_EMAIL_DESTINO || process.env.GMAIL_USER;
    const listaHtml = nuevas
      .map((n) => `<li><b>${n.titulo}</b> — ${n.fuente.provincia} (<a href="${n.fuente.url}">${n.fuente.nombre}</a>)</li>`)
      .join("");
    await transporte.sendMail({
      from: process.env.GMAIL_USER,
      to: destino,
      subject: `${nuevas.length} nueva(s) oposición(es) de Bombero detectada(s)`,
      html: `<p>Se han detectado las siguientes convocatorias nuevas:</p><ul>${listaHtml}</ul><p>Revísalas en la página oficial antes de confiar en este resumen automático.</p>`,
    });
  } else {
    console.warn("GMAIL_USER / GMAIL_APP_PASSWORD no están configurados: no se ha enviado email.");
  }

  fs.writeFileSync(SEEN_PATH, JSON.stringify(vistos, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
