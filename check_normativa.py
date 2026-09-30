#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Vigilancia normativa gratuita para el proyecto de oposición a bombero/a (Levante/Poniente Almería).

Qué hace:
  1. Descarga un puñado de páginas oficiales de los dos Consorcios (las que NO tienen
     servicio de alertas propio, a diferencia de BOE/BOJA/Plataforma de Contratación,
     que sí lo tienen y para las que se recomienda usar sus alertas oficiales en vez de
     este script — ver LEEME.md).
  2. Compara el texto de cada página con la última copia guardada (vigilancia/snapshots/).
  3. Si hay cambios, usa la API gratuita de Gemini (Google AI Studio) para resumir en
     español, de forma concisa y sin inventar nada, qué ha cambiado y si parece relevante
     para el temario de oposición.
  4. Envía un correo con el resumen usando una cuenta de Gmail (SMTP + contraseña de
     aplicación, gratis).
  5. Guarda la nueva copia de cada página para la próxima comparación.

Todo esto corre gratis en GitHub Actions (repos públicos = minutos ilimitados).
No inventa nada: si no hay cambios, no envía nada. Si Gemini no está configurado,
el script sigue funcionando y avisa igualmente, solo que sin resumen generado por IA
(manda el diff en crudo).
"""
import os
import sys
import smtplib
import difflib
import hashlib
import re
from email.mime.text import MIMEText
from pathlib import Path
from urllib.request import Request, urlopen

SNAPSHOT_DIR = Path(__file__).parent / "snapshots"
SNAPSHOT_DIR.mkdir(exist_ok=True)

# Páginas a vigilar: (nombre_corto, url). Añade o quita líneas aquí si quieres ampliar
# o reducir lo que se vigila. Deliberadamente NO incluye BOE/BOJA/Plataforma de
# Contratación: para esas, usa sus propias alertas oficiales gratuitas (ver LEEME.md).
FUENTES = [
    ("poniente_organizacion", "https://www.bomberosdelponiente.es/organizacion/"),
    ("poniente_estatutos", "https://www.bomberosdelponiente.es/conocenos/estatutos/"),
    ("poniente_noticias", "https://www.bomberosdelponiente.es/actualidad/"),
    ("levante_sede", "https://ceislevantealmeriense.sedelectronica.es/info.4"),
]

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GMAIL_USER = os.environ.get("GMAIL_USER", "").strip()
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "").strip()
ALERT_EMAIL_TO = os.environ.get("ALERT_EMAIL_TO", GMAIL_USER).strip()


def fetch(url: str) -> str:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (vigilancia-normativa-bomberos/1.0)"})
    with urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="ignore")
    # Quita etiquetas HTML de forma simple para comparar solo texto (evita falsos
    # positivos por cambios de maquetación, fechas de "última actualización" del footer, etc.)
    text = re.sub(r"<script.*?</script>", " ", raw, flags=re.S | re.I)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def diff_text(old: str, new: str) -> str:
    old_lines = re.split(r"(?<=[.;:])\s+", old)
    new_lines = re.split(r"(?<=[.;:])\s+", new)
    d = difflib.unified_diff(old_lines, new_lines, lineterm="", n=0)
    return "\n".join(d)


def summarize_with_gemini(nombre: str, url: str, diff: str) -> str:
    if not GEMINI_API_KEY:
        return f"(Sin GEMINI_API_KEY configurada — diff en crudo)\n{diff[:3000]}"
    import json
    from urllib.request import Request, urlopen

    prompt = (
        "Eres un asistente que vigila cambios en páginas web oficiales de dos consorcios de "
        "bomberos de Almería (España) para un opositor a bombero/a. Te doy un diff de texto "
        "entre la versión anterior y la nueva de una página. Responde en español, muy conciso "
        "(máximo 120 palabras), diciendo: (1) si el cambio parece relevante para un temario de "
        "oposición (normativa, vehículos, parques, plantilla, convocatorias) o si es ruido "
        "irrelevante (typos, fechas de footer, maquetación); (2) si es relevante, qué ha cambiado "
        "en una frase clara. No inventes nada que no esté en el diff. Si el diff es ruido, dilo "
        "explícitamente y no alarmes.\n\n"
        f"Página: {nombre} ({url})\n\nDiff:\n{diff[:6000]}"
    )
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode("utf-8")
    req = Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_API_KEY}",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["candidates"][0]["content"]["parts"][0]["text"].strip()
    except Exception as e:  # pragma: no cover - resiliencia ante fallos de red/API
        return f"(Fallo al resumir con Gemini: {e} — diff en crudo)\n{diff[:3000]}"


def send_email(subject: str, body: str) -> None:
    if not (GMAIL_USER and GMAIL_APP_PASSWORD and ALERT_EMAIL_TO):
        print("Faltan credenciales de Gmail (GMAIL_USER/GMAIL_APP_PASSWORD) — no se envía correo.")
        print("--- Contenido que se habría enviado ---")
        print(subject)
        print(body)
        return
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = GMAIL_USER
    msg["To"] = ALERT_EMAIL_TO
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        server.send_message(msg)
    print(f"Correo enviado a {ALERT_EMAIL_TO}.")


def main() -> int:
    hallazgos = []
    for nombre, url in FUENTES:
        snap_path = SNAPSHOT_DIR / f"{nombre}.txt"
        try:
            nuevo_texto = fetch(url)
        except Exception as e:
            print(f"[{nombre}] No se pudo descargar {url}: {e}")
            continue

        if not snap_path.exists():
            snap_path.write_text(nuevo_texto, encoding="utf-8")
            print(f"[{nombre}] Primera vez que se vigila esta página — guardada copia inicial, sin aviso.")
            continue

        viejo_texto = snap_path.read_text(encoding="utf-8")
        if viejo_texto == nuevo_texto:
            print(f"[{nombre}] Sin cambios.")
            continue

        diff = diff_text(viejo_texto, nuevo_texto)
        if not diff.strip():
            # Cambió el hash pero no hay diferencias de línea detectables (raro) — igualmente actualiza snapshot.
            snap_path.write_text(nuevo_texto, encoding="utf-8")
            continue

        resumen = summarize_with_gemini(nombre, url, diff)
        hallazgos.append((nombre, url, resumen))
        snap_path.write_text(nuevo_texto, encoding="utf-8")

    if hallazgos:
        cuerpo = "Vigilancia normativa — cambios detectados en las webs de los Consorcios:\n\n"
        for nombre, url, resumen in hallazgos:
            cuerpo += f"### {nombre} ({url})\n{resumen}\n\n"
        cuerpo += (
            "\nRecuerda: esto es una detección automática sin supervisión humana. Revisa la fuente "
            "original antes de dar cualquier dato por bueno o de actualizar el temario.\n"
            "\nEsto NO cubre BOE, BOJA ni la Plataforma de Contratación del Sector Público — para "
            "esas, usa las alertas oficiales gratuitas (ver LEEME.md)."
        )
        send_email("Vigilancia normativa bomberos — cambio detectado", cuerpo)
    else:
        print("Sin hallazgos que reportar en esta ejecución.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
