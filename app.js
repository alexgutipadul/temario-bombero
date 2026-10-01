/* Temario Bombero Almería — plataforma privada, independiente (hosting propio).

   Dos modos de funcionamiento, según si FIREBASE_CONFIG (más abajo) está relleno:

   - SIN Firebase configurado (como hasta ahora): acceso cerrado por nombre+PIN contra
     ALLOWED_USERS, o por Google contra ALLOWED_GOOGLE_EMAILS. Todo el progreso se guarda
     solo en localStorage de cada navegador; para pasarlo de un dispositivo a otro hay que
     usar los botones «Exportar»/«Importar» de la barra superior.

   - CON Firebase + Firestore configurado: cualquiera puede darse de alta con su cuenta de
     Google, pero queda pendiente de aprobación hasta que el administrador (ADMIN_EMAIL) lo
     apruebe desde la pestaña "Admin" de la propia web. El progreso se sincroniza en la nube
     (Firestore) y se ve igual en cualquier dispositivo donde inicies sesión. Ver
     FIRESTORE_SETUP.md para los pasos de configuración.

   ALLOWED_USERS/ALLOWED_GOOGLE_EMAILS de abajo solo se usan mientras Firebase no esté
   configurado; sirven de red de respaldo y no hace falta tocarlas si activas Firestore. */

/* ---------- Lista cerrada de usuarios autorizados (solo sin Firestore) ----------
   SOLO estas personas pueden entrar (nombre + PIN exactos). NADIE puede
   crearse una cuenta nueva por su cuenta: si el nombre+PIN no está aquí,
   la app rechaza el acceso. Para añadir o quitar a alguien, edita esta
   lista y vuelve a subir este fichero (pídemelo si quieres que lo haga yo).
   El nombre no distingue mayúsculas/acentos; el PIN sí debe coincidir exacto. */
const ALLOWED_USERS = [
  { name: "alex.gutipadul@gmail.com", pin: "6807" },
  { name: "Juanma Martinez Membrives", pin: "6531" },
  // { name: "NombreDeTuAmigo", pin: "1234" },  // descomenta y edita para añadir a alguien
];

function findAllowedUser(nombre, pin) {
  const n = slug(nombre || "");
  return ALLOWED_USERS.find(u => slug(u.name) === n && u.pin === (pin || "").trim());
}

/* ---------- Inicio de sesión con Google (opcional, vía Firebase Authentication) ----------
   SOLO estos correos de Google pueden entrar con el botón "Iniciar sesión con Google" —
   igual de cerrado que la lista ALLOWED_USERS de arriba, pero por email en vez de PIN.
   Para añadir o quitar a alguien, edita esta lista y vuelve a subir este fichero. */
const ALLOWED_GOOGLE_EMAILS = [
  "alex.gutipadul@gmail.com",
  // "amigo@gmail.com",  // descomenta y edita para autorizar a alguien más con Google
];

/* Rellena esto con el "firebaseConfig" que te da la consola de Firebase al registrar
   la app web (Configuración del proyecto → Tus apps → </> Web). Mientras estos valores
   sigan siendo los de ejemplo ("TU_..."), el botón de Google se oculta automáticamente
   y la app funciona igual que siempre con nombre+PIN — no hace falta tocar nada más. */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBOCcs0kwjLjy3LJeYheNl-vjO7xruKagQ",
  authDomain: "plataforma-bombero.firebaseapp.com",
  projectId: "plataforma-bombero",
  appId: "1:461767203715:web:b91ac1a53a5c37df1b74b6",
};

const FIREBASE_ENABLED = !Object.values(FIREBASE_CONFIG).some(v => String(v).startsWith("TU_"));
if (FIREBASE_ENABLED && window.firebase) {
  firebase.initializeApp(FIREBASE_CONFIG);
}

/* ---------- Firestore: registro con alta pendiente + sincronización de progreso + avisos ----------
   Si Firestore está disponible (FIREBASE_CONFIG relleno y firebase-firestore-compat.js cargado),
   CUALQUIERA puede darse de alta con su cuenta de Google, pero queda en estado "pendiente"
   hasta que el administrador (ADMIN_EMAIL) la apruebe desde la pestaña "Admin" de la propia
   plataforma. Si Firestore no está disponible, la app sigue funcionando exactamente igual que
   antes: nombre+PIN o Google contra la lista cerrada ALLOWED_GOOGLE_EMAILS, todo solo local. */
const ADMIN_EMAIL = "alex.gutipadul@gmail.com";
let firestoreDb = null;
if (FIREBASE_ENABLED && window.firebase && firebase.firestore) {
  try { firestoreDb = firebase.firestore(); } catch (e) { firestoreDb = null; }
}
const CLOUD_ENABLED = !!firestoreDb;

function findAllowedGoogleUser(email) {
  const e = (email || "").trim().toLowerCase();
  return ALLOWED_GOOGLE_EMAILS.map(x => x.toLowerCase()).includes(e) ? e : null;
}

/* Crea (si no existe) el documento usuarios/{uid} en Firestore. La primera vez que entra el
   ADMIN_EMAIL queda aprobado y marcado como admin automáticamente; cualquier otro correo nuevo
   entra como "pendiente" y no puede usar la app hasta que el admin lo apruebe. */
async function ensureUserDoc(user) {
  const ref = firestoreDb.collection("usuarios").doc(user.uid);
  const snap = await ref.get();
  if (snap.exists) return snap.data();
  const email = (user.email || "").trim().toLowerCase();
  const isAdmin = email === ADMIN_EMAIL.toLowerCase();
  const data = {
    email,
    nombre: user.displayName || email,
    photoURL: user.photoURL || null,
    estado: isAdmin ? "aprobado" : "pendiente",
    admin: isAdmin,
    creadoEn: firebase.firestore.FieldValue.serverTimestamp(),
  };
  await ref.set(data);
  return data;
}

async function fetchUserDoc(uid) {
  const snap = await firestoreDb.collection("usuarios").doc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  const result = await firebase.auth().signInWithPopup(provider);
  const user = result.user;
  const email = (user.email || "").trim().toLowerCase();

  if (!CLOUD_ENABLED) {
    // Sin Firestore: comportamiento antiguo, lista cerrada fija en el código.
    const allowed = findAllowedGoogleUser(email);
    if (!allowed) {
      await firebase.auth().signOut();
      throw new Error(`La cuenta de Google ${email || ""} no está autorizada. Habla con el administrador de la plataforma.`);
    }
    return { email: allowed, nombre: user.displayName || allowed, google: true };
  }

  // Con Firestore: registro con alta pendiente de aprobación.
  const datos = await ensureUserDoc(user);
  if (datos.estado === "rechazado" || datos.estado === "baja") {
    await firebase.auth().signOut();
    throw new Error("Tu acceso a esta plataforma no está autorizado. Habla con el administrador.");
  }
  return {
    email,
    nombre: user.displayName || datos.nombre || email,
    google: true,
    uid: user.uid,
    estado: datos.estado,
    admin: !!datos.admin,
  };
}

/* ---------- Registro de accesos (para que el administrador vea quién entra) ----------
   Cada inicio de sesión válido se registra en un Google Form propio (gratis,
   fuera de Claude) cuyas respuestas caen en una Hoja de cálculo de Google que
   solo tú puedes ver. No bloquea el acceso si falla (sin conexión, etc.). */
const ACCESS_LOG_FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLScu2D6qNiDRSJ9aDCfuFCeUJfwd86Jm2OhQ5KYjozMxQXEJ4Q/formResponse";
const ACCESS_LOG_ENTRY_NAME = "entry.931499226";
function logAccess(nombre) {
  try {
    const fd = new FormData();
    fd.append(ACCESS_LOG_ENTRY_NAME, nombre + " — " + new Date().toLocaleString("es-ES"));
    fetch(ACCESS_LOG_FORM_URL, { method: "POST", mode: "no-cors", body: fd }).catch(() => {});
  } catch (e) {}
}

/* ---------- Almacenamiento local a prueba de fallos ----------
   localStorage puede no estar disponible o lanzar error (modo privado,
   navegador que bloquea almacenamiento de terceros, vista previa, etc.).
   Estas funciones nunca deben romper el arranque de la app. */
const memStore = {};
function lsGet(key) {
  try { const v = localStorage.getItem(key); return v === null ? (key in memStore ? memStore[key] : null) : v; }
  catch (e) { return key in memStore ? memStore[key] : null; }
}
function lsSet(key, val) {
  memStore[key] = val;
  try { localStorage.setItem(key, val); } catch (e) {}
}
function lsRemove(key) {
  delete memStore[key];
  try { localStorage.removeItem(key); } catch (e) {}
}

function defaultState() {
  return {
    temaStatus: {},
    examDate: null,
    preguntas: {},
    activityDates: [],
    testHistory: [],
  };
}

let STATE = defaultState();
let TEMARIO = null;
let PREGUNTAS = null;
let personaLocalKey = null; // clave de localStorage para el progreso de esta persona
let saveTimer = null;
let currentUid = null;       // uid de Firebase Auth cuando hay sesión con Google + Firestore
let cloudSyncEnabled = false; // true cuando este usuario concreto está aprobado y puede sincronizar

/* ============================= Persistencia ============================= */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}

async function flushSave() {
  const badge = document.getElementById("sync-badge");
  try {
    if (personaLocalKey) lsSet(personaLocalKey, JSON.stringify(STATE));
  } catch (e) {
    console.error("Error guardando progreso localmente:", e);
    if (badge) { badge.textContent = "⚠ No se pudo guardar"; badge.className = "sync-badge err"; }
    return;
  }
  if (!cloudSyncEnabled || !currentUid) {
    if (badge) { badge.textContent = "💾 Guardado en este dispositivo"; badge.className = "sync-badge local"; }
    return;
  }
  try {
    if (badge) { badge.textContent = "☁ Sincronizando…"; badge.className = "sync-badge"; }
    await firestoreDb.collection("progreso").doc(currentUid).set({
      ...STATE,
      actualizadoEn: firebase.firestore.FieldValue.serverTimestamp(),
    });
    if (badge) { badge.textContent = "☁ Sincronizado"; badge.className = "sync-badge cloud"; }
  } catch (e) {
    console.error("Error sincronizando progreso:", e);
    if (badge) { badge.textContent = "💾 Guardado solo en este dispositivo"; badge.className = "sync-badge local"; }
  }
}

function markActivity() {
  const t = todayStr();
  if (!STATE.activityDates.includes(t)) {
    STATE.activityDates.push(t);
    scheduleSave();
  }
}

function personaLabel() {
  try { return JSON.parse(lsGet("tb_persona") || "{}").nombre || ""; } catch (e) { return ""; }
}

/* ============================= Markdown -> HTML ============================= */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inlineMd(s) {
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
function renderMarkdown(md) {
  const lines = md.split("\n");
  let html = "";
  let i = 0;
  let inList = null;
  let inTable = false;
  let tableRows = [];

  function closeList() {
    if (inList) { html += `</${inList}>`; inList = null; }
  }
  function flushTable() {
    if (!tableRows.length) return;
    const header = tableRows[0];
    const body = tableRows.slice(2);
    html += "<table><thead><tr>" + header.map(c => `<th>${inlineMd(c.trim())}</th>`).join("") + "</tr></thead><tbody>";
    for (const row of body) {
      html += "<tr>" + row.map(c => `<td>${inlineMd(c.trim())}</td>`).join("") + "</tr>";
    }
    html += "</tbody></table>";
    tableRows = [];
    inTable = false;
  }

  while (i < lines.length) {
    let line = lines[i];

    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeList();
      inTable = true;
      const cells = line.trim().slice(1, -1).split("|");
      tableRows.push(cells);
      i++;
      continue;
    } else if (inTable) {
      flushTable();
    }

    if (/^\s*$/.test(line)) { closeList(); i++; continue; }

    let m;
    if ((m = line.match(/^###\s+(.*)$/))) {
      closeList();
      html += `<h3>${inlineMd(m[1])}</h3>`;
      i++; continue;
    }
    if ((m = line.match(/^##\s+(.*)$/))) {
      closeList();
      html += `<h2>${inlineMd(m[1])}</h2>`;
      i++; continue;
    }
    if ((m = line.match(/^#\s+(.*)$/))) {
      i++; continue;
    }
    if (/^---+\s*$/.test(line)) {
      closeList();
      html += "<hr>";
      i++; continue;
    }
    if ((m = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/))) {
      closeList();
      html += `<img src="${m[2]}" alt="${escapeHtml(m[1])}" loading="lazy">`;
      i++; continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      closeList();
      let buf = [m[1]];
      let j = i + 1;
      while (j < lines.length && /^>/.test(lines[j])) {
        buf.push(lines[j].replace(/^>\s?/, ""));
        j++;
      }
      const text = buf.join("\n");
      const isWarn = /⚠️/.test(text);
      const paras = text.split(/\n\s*\n/).filter(p => p.trim());
      html += `<blockquote class="${isWarn ? "warn" : ""}">` +
        paras.map(p => `<p>${inlineMd(p.trim()).replace(/\n/g, "<br>")}</p>`).join("") +
        `</blockquote>`;
      i = j; continue;
    }
    if ((m = line.match(/^(\s*)[-*]\s+(.*)$/))) {
      if (inList !== "ul") { closeList(); html += "<ul>"; inList = "ul"; }
      html += `<li>${inlineMd(m[2])}</li>`;
      i++; continue;
    }
    if ((m = line.match(/^(\s*)\d+\.\s+(.*)$/))) {
      if (inList !== "ol") { closeList(); html += "<ol>"; inList = "ol"; }
      html += `<li>${inlineMd(m[2])}</li>`;
      i++; continue;
    }
    closeList();
    let buf = [line];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "" && !/^(#{1,3}\s|>|\s*[-*]\s|\s*\d+\.\s|\|.*\||---+\s*$|!\[)/.test(lines[j])) {
      buf.push(lines[j]);
      j++;
    }
    html += `<p>${inlineMd(buf.join(" "))}</p>`;
    i = j;
  }
  closeList();
  flushTable();
  return html;
}

/* ============================= Sidebar / navegación ============================= */
function temaById(id) {
  for (const b of TEMARIO.bloques) {
    for (const t of b.temas) if (t.id === id) return { tema: t, bloque: b };
  }
  return null;
}
function allTemas() {
  const out = [];
  for (const b of TEMARIO.bloques) for (const t of b.temas) out.push({ ...t, bloqueId: b.id, bloqueNombre: b.nombre });
  return out;
}

let currentTemaId = null;

function statusOf(temaId) {
  return STATE.temaStatus[temaId] || "pendiente";
}

function renderSidebarList(filterText) {
  const container = document.getElementById("tema-list");
  container.innerHTML = "";
  const term = (filterText || "").trim().toLowerCase();

  if (term.length >= 2) {
    renderSearchResults(term);
    return;
  }

  for (const b of TEMARIO.bloques) {
    const group = document.createElement("div");
    group.className = "bloque-group";
    const title = document.createElement("div");
    title.className = "bloque-title";
    title.textContent = b.nombre;
    group.appendChild(title);
    for (const t of b.temas) {
      const item = document.createElement("div");
      item.className = "tema-item" + (t.id === currentTemaId ? " active" : "");
      item.innerHTML = `<span class="tema-num">${t.numero ?? "Z"}</span><span>${t.titulo.replace(/^BLOQUE ESPECÍFICO — TEMA \d+\.\s*/i, "").replace(/^Tema \d+\.\s*/i, "")}</span><span class="status-dot status-${statusOf(t.id)}"></span>`;
      item.onclick = () => { showView("temario"); openTema(t.id); };
      group.appendChild(item);
    }
    container.appendChild(group);
  }
}

function renderSearchResults(term) {
  const container = document.getElementById("tema-list");
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "search-results";
  const hits = [];
  for (const b of TEMARIO.bloques) {
    for (const t of b.temas) {
      const idx = t.contenido_md.toLowerCase().indexOf(term);
      if (t.titulo.toLowerCase().includes(term) || idx !== -1) {
        let snippet = "";
        if (idx !== -1) {
          const start = Math.max(0, idx - 40);
          snippet = (start > 0 ? "…" : "") + t.contenido_md.slice(start, idx + term.length + 60).replace(/\n/g, " ") + "…";
        }
        hits.push({ bloque: b.nombre, tema: t, snippet });
      }
    }
  }
  if (!hits.length) {
    wrap.innerHTML = `<div style="padding:14px 10px;color:var(--text-muted);font-size:13px;">Sin resultados para «${escapeHtml(term)}».</div>`;
  }
  for (const h of hits.slice(0, 80)) {
    const el = document.createElement("div");
    el.className = "search-hit";
    el.innerHTML = `<div class="hit-tema">${h.tema.titulo.replace(/^BLOQUE ESPECÍFICO — TEMA \d+\.\s*/i, "").replace(/^Tema \d+\.\s*/i, "")}</div>
      <div class="hit-bloque">${h.bloque}</div>
      ${h.snippet ? `<div class="hit-snippet">${escapeHtml(h.snippet)}</div>` : ""}`;
    el.onclick = () => {
      document.getElementById("search-box").value = "";
      showView("temario");
      renderSidebarList("");
      openTema(h.tema.id);
    };
    wrap.appendChild(el);
  }
  container.appendChild(wrap);
}

/* ============================= Vista Temario ============================= */
// Vídeos-resumen y presentaciones de NotebookLM disponibles por tema (se van añadiendo según se generan).
// Para añadir uno nuevo: mete el id del tema en el Set correspondiente y coloca el fichero
// en videos/<id>.mp4 o presentaciones/<id>.pdf junto al resto de la plataforma.
const VIDEOS_DISPONIBLES = new Set(["tema01_constitucion", "b17_incendios_tuneles"]);
const PRESENTACIONES_DISPONIBLES = new Set([]);

function openTema(id) {
  currentTemaId = id;
  const found = temaById(id);
  if (!found) return;
  const { tema, bloque } = found;
  const wrap = document.getElementById("content-wrap");
  const bodyHtml = renderMarkdown(tema.contenido_md);
  const cleanTitle = tema.titulo.replace(/^BLOQUE ESPECÍFICO — TEMA \d+\.\s*/i, "").replace(/^Tema \d+\.\s*/i, "");
  const tieneVideo = VIDEOS_DISPONIBLES.has(id);
  const tienePresentacion = PRESENTACIONES_DISPONIBLES.has(id);
  wrap.innerHTML = `
    <div class="tema-header">
      <div class="eyebrow">${bloque.nombre}${tema.numero ? " · Tema " + tema.numero : ""}</div>
      <h1>${escapeHtml(cleanTitle)}</h1>
      <div class="tema-status-row">
        ${["pendiente", "en_estudio", "dominado"].map(s => `<button class="status-btn ${statusOf(id) === s ? "active-" + s : ""}" data-status="${s}">${s === "pendiente" ? "Pendiente" : s === "en_estudio" ? "En estudio" : "Dominado"}</button>`).join("")}
        <button type="button" class="status-btn pdf-link" id="btn-download-pdf">⬇ Descargar PDF del tema</button>
        ${tienePresentacion ? `<a class="status-btn pdf-link" href="presentaciones/${encodeURIComponent(id)}.pdf" download target="_blank" rel="noopener">📊 Descargar presentación</a>` : ""}
      </div>
    </div>
    ${tieneVideo ? `
      <div class="tema-video-wrap" id="tema-video-wrap">
        <video controls preload="metadata" src="videos/${encodeURIComponent(id)}.mp4"></video>
        <div class="tema-video-error-msg">⚠️ No se ha podido cargar el vídeo. Comprueba que el fichero <code>videos/${escapeHtml(id)}.mp4</code> existe en la carpeta de la plataforma.</div>
        <div class="tema-video-caption">Vídeo-resumen generado con NotebookLM</div>
      </div>
    ` : ""}
    ${tienePresentacion ? `
      <div class="tema-video-wrap">
        <embed src="presentaciones/${encodeURIComponent(id)}.pdf" type="application/pdf" class="tema-presentacion-embed" />
        <div class="tema-video-caption">Presentación generada con NotebookLM (también descargable arriba)</div>
      </div>
    ` : ""}
    <div class="md-body">${bodyHtml}</div>
  `;
  wrap.querySelectorAll(".status-btn[data-status]").forEach(btn => {
    btn.onclick = () => {
      STATE.temaStatus[id] = btn.dataset.status;
      scheduleSave();
      markActivity();
      openTema(id);
      renderSidebarList(document.getElementById("search-box").value);
    };
  });
  const pdfBtn = document.getElementById("btn-download-pdf");
  if (pdfBtn) pdfBtn.onclick = () => window.print();
  if (tieneVideo) {
    const videoEl = wrap.querySelector(".tema-video-wrap video");
    const videoWrap = document.getElementById("tema-video-wrap");
    if (videoEl && videoWrap) {
      videoEl.addEventListener("error", () => videoWrap.classList.add("video-error"));
    }
  }
  window.scrollTo(0, 0);
  document.getElementById("main").scrollTop = 0;
  renderSidebarList(document.getElementById("search-box").value);
}

/* ============================= Vista Test ============================= */
let quizState = null;

function bloqueOptions() {
  return TEMARIO.bloques.map(b => ({ id: b.id, nombre: b.nombre }));
}

// Devuelve los temas (con su bloqueId) de los bloques indicados, en orden.
function temasDeBloques(bloqueIds) {
  const out = [];
  for (const b of TEMARIO.bloques) {
    if (!bloqueIds.has(b.id)) continue;
    for (const t of b.temas) out.push({ ...t, bloqueId: b.id, bloqueNombre: b.nombre });
  }
  return out;
}

function countByTema() {
  const counts = {};
  for (const p of PREGUNTAS) counts[p.temaId] = (counts[p.temaId] || 0) + 1;
  return counts;
}

function renderTestSetup() {
  const el = document.getElementById("view-test");
  const bloques = bloqueOptions();
  const counts = countByTema();
  el.innerHTML = `
    <div class="panel">
      <h1>Modo test</h1>
      <div class="sub">${PREGUNTAS.length} preguntas disponibles del banco de exámenes reales.</div>
      <div class="card">
        <h3>Ámbito — bloques</h3>
        <div class="chip-group" id="chip-bloques">
          <div class="chip selected" data-id="todos">Todos los bloques</div>
          ${bloques.map(b => `<div class="chip" data-id="${b.id}">${b.nombre}</div>`).join("")}
        </div>
      </div>
      <div class="card">
        <h3>Ámbito — temas concretos</h3>
        <div class="sub">Opcional: elige temas concretos dentro de los bloques seleccionados. Si no marcas ninguno, se usan todos los temas de esos bloques.</div>
        <div class="field-row">
          <button type="button" class="link-btn" id="btn-temas-todos">Marcar todos</button>
          <button type="button" class="link-btn" id="btn-temas-ninguno">Desmarcar todos</button>
        </div>
        <div class="chip-group" id="chip-temas"></div>
      </div>
      <div class="card">
        <h3>Modo</h3>
        <div class="field-row">
          <label>Nº de preguntas</label>
          <input type="number" id="num-preguntas" min="5" max="200" value="30">
        </div>
        <div class="field-row">
          <label>Tiempo límite (min, 0 = sin límite)</label>
          <input type="number" id="tiempo-limite" min="0" max="240" value="0">
        </div>
        <div class="field-row">
          <label>Solo preguntas falladas</label>
          <input type="checkbox" id="solo-falladas">
        </div>
      </div>
      <button class="btn" id="btn-start-quiz">Empezar</button>
    </div>
  `;
  let selectedBloques = new Set(["todos"]);
  let selectedTemas = new Set(); // vacío = sin filtro por tema (usa todos los temas de los bloques elegidos)

  function currentBloqueIdSet() {
    if (selectedBloques.has("todos")) return new Set(TEMARIO.bloques.map(b => b.id));
    return selectedBloques;
  }

  function renderTemaChips() {
    const temasChipEl = document.getElementById("chip-temas");
    const temas = temasDeBloques(currentBloqueIdSet());
    // Al cambiar de bloques, descarta selecciones de temas que ya no aplican.
    const idsVisibles = new Set(temas.map(t => t.id));
    for (const id of Array.from(selectedTemas)) if (!idsVisibles.has(id)) selectedTemas.delete(id);
    temasChipEl.innerHTML = temas.map(t => {
      const label = t.titulo.replace(/^BLOQUE ESPECÍFICO — TEMA \d+\.\s*/i, "").replace(/^Tema \d+\.\s*/i, "");
      const n = counts[t.id] || 0;
      return `<div class="chip${selectedTemas.has(t.id) ? " selected" : ""}" data-tema-id="${t.id}">${t.numero ? t.numero + ". " : ""}${escapeHtml(label)} <span class="chip-count">(${n})</span></div>`;
    }).join("") || `<div class="sub">Elige al menos un bloque.</div>`;
    temasChipEl.querySelectorAll(".chip").forEach(chip => {
      chip.onclick = () => {
        const id = chip.dataset.temaId;
        if (selectedTemas.has(id)) selectedTemas.delete(id); else selectedTemas.add(id);
        chip.classList.toggle("selected", selectedTemas.has(id));
      };
    });
  }

  el.querySelectorAll("#chip-bloques .chip").forEach(chip => {
    chip.onclick = () => {
      const id = chip.dataset.id;
      if (id === "todos") {
        selectedBloques = new Set(["todos"]);
      } else {
        selectedBloques.delete("todos");
        if (selectedBloques.has(id)) selectedBloques.delete(id); else selectedBloques.add(id);
        if (selectedBloques.size === 0) selectedBloques.add("todos");
      }
      el.querySelectorAll("#chip-bloques .chip").forEach(c => c.classList.toggle("selected", selectedBloques.has(c.dataset.id)));
      renderTemaChips();
    };
  });
  document.getElementById("btn-temas-todos").onclick = () => {
    for (const t of temasDeBloques(currentBloqueIdSet())) selectedTemas.add(t.id);
    renderTemaChips();
  };
  document.getElementById("btn-temas-ninguno").onclick = () => {
    selectedTemas.clear();
    renderTemaChips();
  };
  renderTemaChips();

  document.getElementById("btn-start-quiz").onclick = () => {
    const n = parseInt(document.getElementById("num-preguntas").value, 10) || 30;
    const limitMin = parseInt(document.getElementById("tiempo-limite").value, 10) || 0;
    const soloFalladas = document.getElementById("solo-falladas").checked;
    let pool = PREGUNTAS.filter(p => selectedBloques.has("todos") || selectedBloques.has(p.bloqueId));
    if (selectedTemas.size > 0) pool = pool.filter(p => selectedTemas.has(p.temaId));
    if (soloFalladas) {
      pool = pool.filter(p => {
        const rec = STATE.preguntas[p.id];
        return rec && rec.lastResult === false;
      });
    }
    if (!pool.length) { alert("No hay preguntas para ese filtro."); return; }
    pool = shuffle(pool.slice()).slice(0, n);
    startQuiz(pool, limitMin * 60);
  };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function startQuiz(questions, timeLimitSec) {
  quizState = { questions, index: 0, answers: new Array(questions.length).fill(null), timeLimitSec, secondsLeft: timeLimitSec, timerHandle: null };
  if (timeLimitSec > 0) {
    quizState.timerHandle = setInterval(() => {
      quizState.secondsLeft--;
      updateTimerDisplay();
      if (quizState.secondsLeft <= 0) { clearInterval(quizState.timerHandle); finishQuiz(); }
    }, 1000);
  }
  renderQuizQuestion();
}

function updateTimerDisplay() {
  const t = document.getElementById("quiz-timer");
  if (!t) return;
  const m = Math.floor(quizState.secondsLeft / 60);
  const s = quizState.secondsLeft % 60;
  t.textContent = `${m}:${String(s).padStart(2, "0")}`;
}

function renderQuizQuestion() {
  const el = document.getElementById("view-test");
  const q = quizState.questions[quizState.index];
  const chosen = quizState.answers[quizState.index];
  const revealed = chosen !== null;
  const pct = Math.round((quizState.index / quizState.questions.length) * 100);
  el.innerHTML = `
    <div class="panel">
      <div class="field-row" style="justify-content:space-between;">
        <div class="sub" style="margin:0;">Pregunta ${quizState.index + 1} de ${quizState.questions.length} — ${q.temaLabel}</div>
        ${quizState.timeLimitSec > 0 ? `<div id="quiz-timer"></div>` : ""}
      </div>
      <div class="quiz-progress"><div class="quiz-progress-fill" style="width:${pct}%"></div></div>
      <div class="quiz-question">${escapeHtml(q.enunciado)}</div>
      <div id="quiz-options">
        ${q.opciones.map((op, idx) => {
          let cls = "";
          let tag = "";
          if (revealed) {
            if (idx === q.correctaIndex) { cls = "correct"; tag = `<span class="option-tag ok">✓ Correcta</span>`; }
            else if (idx === chosen) { cls = "incorrect"; tag = `<span class="option-tag bad">✗ Tu respuesta — incorrecta</span>`; }
            else { tag = `<span class="option-tag muted">✗ Incorrecta</span>`; }
          } else if (chosen === idx) cls = "selected";
          const optExplain = revealed && q.explicaciones && q.explicaciones[idx]
            ? `<div class="option-explain">${escapeHtml(q.explicaciones[idx])}</div>` : "";
          return `
          <div class="quiz-option ${cls}" data-idx="${idx}">
            <div class="quiz-option-row">
              <span class="letter">${"abcd"[idx]})</span><span>${escapeHtml(op)}</span>${tag}
            </div>
            ${optExplain}
          </div>`;
        }).join("")}
      </div>
      ${revealed ? `
        <div class="quiz-feedback ${chosen === q.correctaIndex ? "ok" : "bad"}">
          <div class="quiz-feedback-title">${chosen === q.correctaIndex ? "✓ Correcto." : "✗ Incorrecto."}</div>
          ${chosen !== q.correctaIndex ? `<div class="quiz-feedback-line">La respuesta correcta es <strong>${"abcd"[q.correctaIndex]}) ${escapeHtml(q.opciones[q.correctaIndex])}</strong>.</div>` : ""}
          ${q.explicacion ? `<div class="quiz-explain-text"><strong>Por qué es correcta:</strong> ${escapeHtml(q.explicacion)}</div>` : `<div class="quiz-explain-text muted">Consulta el tema «${escapeHtml(q.temaLabel)}» para más contexto sobre esta pregunta.</div>`}
          ${!q.explicaciones ? `<div class="quiz-explain-text muted" style="margin-top:6px;font-size:12px;">La explicación detallada de por qué cada opción concreta es incorrecta todavía no está disponible para esta pregunta — de momento se marca cuál es la correcta y cuál elegiste.</div>` : ""}
        </div>
      ` : ""}
      <div class="field-row" style="justify-content:space-between; margin-top:18px;">
        <button class="btn secondary" id="btn-prev" ${quizState.index === 0 ? "disabled" : ""}>Anterior</button>
        <button class="btn" id="btn-next">${quizState.index === quizState.questions.length - 1 ? "Finalizar" : "Siguiente"}</button>
      </div>
    </div>
  `;
  if (quizState.timeLimitSec > 0) updateTimerDisplay();
  el.querySelectorAll(".quiz-option").forEach(opt => {
    opt.onclick = () => {
      quizState.answers[quizState.index] = parseInt(opt.dataset.idx, 10);
      renderQuizQuestion();
    };
  });
  document.getElementById("btn-prev").onclick = () => { quizState.index--; renderQuizQuestion(); };
  document.getElementById("btn-next").onclick = () => {
    if (quizState.index === quizState.questions.length - 1) {
      if (quizState.timerHandle) clearInterval(quizState.timerHandle);
      finishQuiz();
    } else {
      quizState.index++;
      renderQuizQuestion();
    }
  };
}

function finishQuiz() {
  let correct = 0;
  const today = todayStr();
  quizState.questions.forEach((q, idx) => {
    const chosen = quizState.answers[idx];
    const isCorrect = chosen !== null && chosen === q.correctaIndex;
    if (isCorrect) correct++;
    const rec = STATE.preguntas[q.id] || { timesAsked: 0, timesCorrect: 0 };
    rec.timesAsked++;
    if (isCorrect) rec.timesCorrect++;
    rec.lastResult = isCorrect;
    rec.lastDate = today;
    STATE.preguntas[q.id] = rec;
  });
  STATE.testHistory.push({ date: today, total: quizState.questions.length, correct });
  markActivity();
  scheduleSave();

  const el = document.getElementById("view-test");
  const pct = Math.round((correct / quizState.questions.length) * 100);
  el.innerHTML = `
    <div class="panel">
      <div class="card result-summary">
        <div class="result-score">${correct} / ${quizState.questions.length}</div>
        <div class="result-label">${pct}% de aciertos</div>
      </div>
      <div class="field-row">
        <button class="btn" id="btn-repeat">Nuevo test</button>
      </div>
      <div class="card">
        <h3>Revisión</h3>
        ${quizState.questions.map((q, idx) => {
          const chosen = quizState.answers[idx];
          return `<div class="review-item">
            <div class="review-q">${idx + 1}. ${escapeHtml(q.enunciado)} <span style="color:var(--text-muted);font-weight:400;">— ${q.temaLabel}</span></div>
            ${q.opciones.map((op, i) => {
              let cls = "";
              let tag = "";
              if (i === q.correctaIndex) { cls = "correct"; tag = " — ✓ correcta"; }
              else if (i === chosen) { cls = "wrong-chosen"; tag = " — ✗ tu respuesta"; }
              const optExplain = q.explicaciones && q.explicaciones[i]
                ? `<div class="option-explain">${escapeHtml(q.explicaciones[i])}</div>` : "";
              return `<div class="review-opt ${cls}">${"abcd"[i]}) ${escapeHtml(op)}${tag}${optExplain}</div>`;
            }).join("")}
            ${q.explicacion ? `<div class="quiz-explain-text"><strong>Por qué es correcta:</strong> ${escapeHtml(q.explicacion)}</div>` : ""}
          </div>`;
        }).join("")}
      </div>
    </div>
  `;
  document.getElementById("btn-repeat").onclick = renderTestSetup;
}

/* ============================= Vista Plan de estudio ============================= */
function renderPlan() {
  const el = document.getElementById("view-plan");
  const temas = allTemas();
  const pendientes = temas.filter(t => statusOf(t.id) !== "dominado");
  let diasRestantes = null, fechaExamen = STATE.examDate;
  if (fechaExamen) {
    const diff = (new Date(fechaExamen) - new Date(todayStr())) / 86400000;
    diasRestantes = Math.max(0, Math.ceil(diff));
  }

  let planHtml = "";
  if (fechaExamen && diasRestantes !== null) {
    const dias = Math.max(1, diasRestantes);
    const porDia = Math.max(1, Math.ceil(pendientes.length / dias));
    const rows = [];
    let cursor = 0;
    for (let d = 0; d < Math.min(dias, 60) && cursor < pendientes.length; d++) {
      const date = new Date();
      date.setDate(date.getDate() + d);
      const grupo = pendientes.slice(cursor, cursor + porDia);
      cursor += porDia;
      if (!grupo.length) continue;
      rows.push(`<div class="plan-day"><div class="day-date">${date.toLocaleDateString("es-ES", { weekday: "short", day: "2-digit", month: "2-digit" })}</div><div class="day-temas">${grupo.map(t => t.titulo.replace(/^BLOQUE ESPECÍFICO — TEMA \d+\.\s*/i, "").replace(/^Tema \d+\.\s*/i, "")).join(" · ")}</div></div>`);
    }
    planHtml = rows.join("") || `<div class="sub">¡Todos los temas están dominados!</div>`;
  }

  el.innerHTML = `
    <div class="panel">
      <h1>Plan de estudio</h1>
      <div class="sub">Reparte los temas que te faltan entre los días que quedan hasta el examen.</div>
      <div class="card">
        <div class="field-row">
          <label>Fecha del examen</label>
          <input type="date" id="exam-date" value="${fechaExamen || ""}">
        </div>
        ${diasRestantes !== null ? `<div class="stat-tile"><div class="num">${diasRestantes}</div><div class="lbl">días restantes</div></div>` : ""}
        <div class="stat-tile" style="margin-top:10px;"><div class="num">${pendientes.length} / ${temas.length}</div><div class="lbl">temas por dominar</div></div>
      </div>
      ${fechaExamen ? `<div class="card"><h3>Reparto sugerido</h3>${planHtml}</div>` : `<div class="sub">Fija una fecha de examen para ver el reparto de temas por día.</div>`}
    </div>
  `;
  document.getElementById("exam-date").onchange = (e) => {
    STATE.examDate = e.target.value || null;
    scheduleSave();
    renderPlan();
  };
}

/* ============================= Vista Progreso ============================= */
function computeStreak() {
  const dates = new Set(STATE.activityDates);
  let streak = 0;
  let cursor = new Date();
  while (true) {
    const s = cursor.toISOString().slice(0, 10);
    if (dates.has(s)) { streak++; cursor.setDate(cursor.getDate() - 1); }
    else break;
  }
  return streak;
}

function renderProgreso() {
  const el = document.getElementById("view-progreso");
  const temas = allTemas();
  const dominados = temas.filter(t => statusOf(t.id) === "dominado").length;
  const enEstudio = temas.filter(t => statusOf(t.id) === "en_estudio").length;
  const pctDominado = Math.round((dominados / temas.length) * 100);

  let totalAsked = 0, totalCorrect = 0;
  for (const id in STATE.preguntas) {
    totalAsked += STATE.preguntas[id].timesAsked;
    totalCorrect += STATE.preguntas[id].timesCorrect;
  }
  const pctAciertos = totalAsked ? Math.round((totalCorrect / totalAsked) * 100) : null;

  const porBloque = {};
  for (const p of PREGUNTAS) {
    const rec = STATE.preguntas[p.id];
    if (!rec || !rec.timesAsked) continue;
    porBloque[p.bloqueId] = porBloque[p.bloqueId] || { asked: 0, correct: 0, nombre: p.bloqueId };
    porBloque[p.bloqueId].asked += rec.timesAsked;
    porBloque[p.bloqueId].correct += rec.timesCorrect;
  }
  for (const b of TEMARIO.bloques) if (porBloque[b.id]) porBloque[b.id].nombre = b.nombre;

  const barsHtml = Object.values(porBloque).sort((a, b) => (a.correct / a.asked) - (b.correct / b.asked)).map(b => {
    const pct = Math.round((b.correct / b.asked) * 100);
    const color = pct >= 70 ? "var(--good)" : pct >= 45 ? "var(--warning)" : "var(--critical)";
    return `<div class="bar-row"><div class="bar-label">${b.nombre}</div><div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div><div class="bar-val">${pct}%</div></div>`;
  }).join("") || `<div class="sub">Todavía no has hecho ningún test.</div>`;

  el.innerHTML = `
    <div class="panel">
      <h1>Progreso</h1>
      <div class="sub">Resumen de tu estudio hasta ahora.</div>
      <div class="stat-grid">
        <div class="card stat-tile"><div class="num">${pctDominado}%</div><div class="lbl">del temario dominado</div></div>
        <div class="card stat-tile"><div class="num">${computeStreak()}</div><div class="lbl">días seguidos de estudio</div></div>
        <div class="card stat-tile"><div class="num">${pctAciertos !== null ? pctAciertos + "%" : "—"}</div><div class="lbl">aciertos en tests (${totalAsked} preguntas)</div></div>
      </div>
      <div class="card">
        <h3>Estado del temario</h3>
        <div class="bar-row"><div class="bar-label">Dominado</div><div class="bar-track"><div class="bar-fill" style="width:${(dominados/temas.length*100)}%;background:var(--good)"></div></div><div class="bar-val">${dominados}</div></div>
        <div class="bar-row"><div class="bar-label">En estudio</div><div class="bar-track"><div class="bar-fill" style="width:${(enEstudio/temas.length*100)}%;background:var(--warning)"></div></div><div class="bar-val">${enEstudio}</div></div>
        <div class="bar-row"><div class="bar-label">Pendiente</div><div class="bar-track"><div class="bar-fill" style="width:${((temas.length-dominados-enEstudio)/temas.length*100)}%;background:var(--border)"></div></div><div class="bar-val">${temas.length-dominados-enEstudio}</div></div>
      </div>
      <div class="card">
        <h3>Precisión por bloque</h3>
        ${barsHtml}
      </div>
    </div>
  `;
}

/* ============================= Navegación entre vistas ============================= */
function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.style.display = "none");
  document.getElementById("view-" + name).style.display = "block";
  document.querySelectorAll(".nav-tab").forEach(t => t.classList.toggle("active", t.dataset.view === name));
  if (name === "test") renderTestSetup();
  if (name === "plan") renderPlan();
  if (name === "progreso") renderProgreso();
  if (name === "admin") renderAdminPanel();
  markActivity();
}

/* ============================= Puerta de persona (nombre + PIN) ============================= */
function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return String(h);
}
function slug(s) {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function showPersonaGate(existing) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("gate-overlay");
    overlay.innerHTML = `
      <div class="gate-card">
        <h2>¿Quién eres?</h2>
        <div class="sub">${CLOUD_ENABLED ? "Entra con tu cuenta de Google, o con tu nombre y PIN si ya tienes uno asignado. Si es la primera vez con Google, tu alta quedará pendiente de aprobación por el administrador." : "Esta página es solo para personas autorizadas. Escribe tu nombre y tu PIN — si no están en la lista de acceso, no podrás entrar."}</div>
        ${FIREBASE_ENABLED ? `
        <button type="button" class="btn google-btn" id="gate-google-btn">
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.16.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"/></svg>
          ${CLOUD_ENABLED ? "Continuar con Google" : "Iniciar sesión con Google"}
        </button>
        ${false ? "" : `<div class="gate-divider"><span>o con nombre y PIN</span></div>`}
        ` : ""}
        ${false ? "" : `
        <input type="text" id="gate-name-input" placeholder="Tu nombre" value="${existing ? escapeHtml(existing.nombre) : ""}" autofocus>
        <input type="password" id="gate-pin-input" placeholder="Tu PIN" inputmode="numeric" maxlength="8">
        `}
        <div class="gate-error" id="gate-persona-error"></div>
        ${false ? "" : `<button class="btn" id="gate-persona-btn">Continuar</button>`}
      </div>
    `;
    overlay.style.display = "flex";
    const err = document.getElementById("gate-persona-error");
    {
      const nameInput = document.getElementById("gate-name-input");
      const pinInput = document.getElementById("gate-pin-input");
      const submit = () => {
        const nombre = nameInput.value.trim();
        const pin = pinInput.value.trim();
        if (!nombre || !pin) {
          err.textContent = "Escribe tu nombre y tu PIN.";
          return;
        }
        const match = findAllowedUser(nombre, pin);
        if (!match) {
          err.textContent = "Nombre o PIN no autorizados. Habla con el administrador de la plataforma.";
          pinInput.value = "";
          pinInput.focus();
          return;
        }
        overlay.style.display = "none";
        logAccess(match.name);
        resolve({ nombre: match.name, pin });
      };
      document.getElementById("gate-persona-btn").onclick = submit;
      pinInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }
    if (FIREBASE_ENABLED) {
      document.getElementById("gate-google-btn").onclick = async () => {
        err.textContent = "";
        try {
          const g = await signInWithGoogle();
          if (g.estado === "pendiente") {
            showPendingScreen(g, resolve);
            return;
          }
          overlay.style.display = "none";
          logAccess(g.email);
          resolve(g);
        } catch (e) {
          err.textContent = e.message || "No se pudo iniciar sesión con Google.";
        }
      };
    }
  });
}

/* Pantalla de espera para altas nuevas con Firestore: el usuario ya ha entrado con Google
   pero el administrador todavía no ha aprobado su acceso. Reintenta comprobar el estado
   cada vez que pulsa el botón, sin necesidad de recargar la página. */
function showPendingScreen(g, resolveOuter) {
  const overlay = document.getElementById("gate-overlay");
  overlay.innerHTML = `
    <div class="gate-card">
      <h2>Alta pendiente de aprobación</h2>
      <div class="sub">Hola ${escapeHtml(g.nombre || g.email)}. Tu solicitud de acceso se ha registrado correctamente, pero todavía tiene que aprobarla el administrador de la plataforma. Vuelve a intentarlo en un rato, o avisa al administrador.</div>
      <div class="gate-error" id="gate-pending-error"></div>
      <button class="btn" id="gate-pending-retry">Comprobar de nuevo</button>
      <button class="link-btn" id="gate-pending-logout" style="margin-top:10px">Cerrar sesión</button>
    </div>
  `;
  overlay.style.display = "flex";
  document.getElementById("gate-pending-retry").onclick = async () => {
    const errEl = document.getElementById("gate-pending-error");
    try {
      const datos = await fetchUserDoc(g.uid);
      if (!datos) { errEl.textContent = "No se ha encontrado tu solicitud."; return; }
      if (datos.estado === "aprobado") {
        overlay.style.display = "none";
        logAccess(g.email);
        resolveOuter({ ...g, estado: "aprobado", admin: !!datos.admin, nombre: datos.nombre || g.nombre });
      } else if (datos.estado === "rechazado" || datos.estado === "baja") {
        errEl.textContent = "Tu acceso no ha sido autorizado por el administrador.";
      } else {
        errEl.textContent = "Todavía está pendiente de aprobación.";
      }
    } catch (e) {
      errEl.textContent = "No se pudo comprobar el estado. Revisa tu conexión.";
    }
  };
  document.getElementById("gate-pending-logout").onclick = async () => {
    try { await firebase.auth().signOut(); } catch (e) {}
    location.reload();
  };
}

function renderPersonaBadge() {
  const nombre = personaLabel();
  const bar = document.getElementById("persona-bar");
  if (!bar) return;
  bar.innerHTML = `
    <span class="persona-name">${escapeHtml(nombre || "")}</span>
    <span id="sync-badge" class="sync-badge">…</span>
    <button id="btn-avisos" class="avisos-btn" title="Avisos" style="display:none">
      🔔<span id="avisos-badge" class="avisos-badge" style="display:none">0</span>
    </button>
    <button id="btn-export" class="link-btn" title="Descargar tu progreso como fichero">Exportar</button>
    <button id="btn-import" class="link-btn" title="Cargar un progreso exportado antes">Importar</button>
    <button id="btn-switch-persona" class="link-btn" title="Cambiar de usuario">Cambiar</button>
    <input type="file" id="import-file-input" accept="application/json" style="display:none">
  `;
  document.getElementById("btn-switch-persona").onclick = async () => {
    lsRemove("tb_persona");
    if (FIREBASE_ENABLED && firebase.auth().currentUser) {
      try { await firebase.auth().signOut(); } catch (e) {}
    }
    location.reload();
  };
  document.getElementById("btn-export").onclick = exportProgress;
  document.getElementById("btn-import").onclick = () => document.getElementById("import-file-input").click();
  document.getElementById("import-file-input").addEventListener("change", importProgressFile);
}

/* ---------- Exportar / importar progreso (para pasarlo entre dispositivos) ---------- */
function exportProgress() {
  const blob = new Blob([JSON.stringify(STATE, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "progreso_temario_bombero_" + slug(personaLabel() || "yo") + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importProgressFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data !== "object") throw new Error("formato inválido");
      STATE = { ...defaultState(), ...data };
      scheduleSave();
      refreshCurrentView();
      alert("Progreso importado correctamente.");
    } catch (err) {
      alert("No se pudo leer ese fichero de progreso: " + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = "";
}

/* ============================= Persona / estado (todo local) ============================= */
async function initPersonaAndState() {
  let persona = null;
  try { persona = JSON.parse(lsGet("tb_persona") || "null"); } catch (e) {}

  if (persona) {
    if (CLOUD_ENABLED && persona.google) {
      // Con Firestore: revalida SIEMPRE en vivo contra el documento del usuario, para que
      // una aprobación, un rechazo o una baja hechos por el admin surtan efecto en el
      // siguiente acceso desde cualquier dispositivo, sin depender de lo que hubiera en caché.
      if (!persona.uid) {
        persona = null; lsRemove("tb_persona");
      } else {
        try {
          const datos = await fetchUserDoc(persona.uid);
          if (!datos || datos.estado === "rechazado" || datos.estado === "baja") {
            persona = null; lsRemove("tb_persona");
            try { await firebase.auth().signOut(); } catch (e) {}
          } else if (datos.estado === "pendiente") {
            persona.estado = "pendiente";
          } else {
            persona.estado = "aprobado";
            persona.admin = !!datos.admin;
            persona.nombre = datos.nombre || persona.nombre;
          }
        } catch (e) {
          // Sin conexión: deja entrar con lo último conocido en caché en vez de bloquear.
        }
      }
    } else if (!CLOUD_ENABLED && persona.google) {
      // Sin Firestore: comportamiento antiguo, lista cerrada fija en el código.
      if (!findAllowedGoogleUser(persona.email)) { persona = null; lsRemove("tb_persona"); }
    } else if (!persona.google) {
      const stillAllowed = ALLOWED_USERS.some(u => slug(u.name) === slug(persona.nombre) && simpleHash(u.pin) === persona.pinHash);
      if (!stillAllowed) { persona = null; lsRemove("tb_persona"); }
    }
  }

  if (!persona) {
    const entered = await showPersonaGate(null);
    persona = entered.google
      ? { nombre: entered.nombre, email: entered.email, google: true, uid: entered.uid, estado: entered.estado, admin: entered.admin }
      : { nombre: entered.nombre, pinHash: simpleHash(entered.pin) };
    lsSet("tb_persona", JSON.stringify(persona));
  } else if (persona.google && persona.estado === "pendiente") {
    const g = await new Promise((resolve) => showPendingScreen(persona, resolve));
    persona = { ...persona, ...g };
    lsSet("tb_persona", JSON.stringify(persona));
  } else {
    logAccess(persona.google ? persona.email : persona.nombre);
  }

  personaLocalKey = persona.google
    ? "tb_state_v3_google_" + slug(persona.email)
    : "tb_state_v3_" + slug(persona.nombre) + "_" + persona.pinHash;
  loadLocalFallback();

  currentUid = persona.google ? (persona.uid || null) : null;
  cloudSyncEnabled = CLOUD_ENABLED && persona.google && persona.estado === "aprobado" && !!currentUid;

  if (cloudSyncEnabled) {
    try {
      const snap = await firestoreDb.collection("progreso").doc(currentUid).get();
      if (snap.exists) {
        // La nube es la copia autorizada entre dispositivos: si hay datos en la nube, sustituyen
        // al progreso local de este navegador (que puede estar desactualizado).
        STATE = { ...defaultState(), ...snap.data() };
      } else if (personaLocalKey && lsGet(personaLocalKey)) {
        // Primera vez con sincronización: sube lo que ya hubiera en este dispositivo.
        scheduleSave();
      }
    } catch (e) {
      console.error("No se pudo leer el progreso en la nube, se usa el local:", e);
    }
  }

  renderPersonaBadge();
  const badge = document.getElementById("sync-badge");
  if (badge) {
    if (cloudSyncEnabled) { badge.textContent = "☁ Sincronizado"; badge.className = "sync-badge cloud"; }
    else { badge.textContent = "💾 Guardado en este dispositivo"; badge.className = "sync-badge local"; }
  }

  document.getElementById("nav-tab-admin").style.display = (CLOUD_ENABLED && persona.admin) ? "" : "none";
  if (CLOUD_ENABLED && cloudSyncEnabled) initAvisos();
}

function loadLocalFallback() {
  try {
    const raw = lsGet(personaLocalKey);
    if (raw) STATE = { ...defaultState(), ...JSON.parse(raw) };
  } catch (e) {}
}

function refreshCurrentView() {
  const active = document.querySelector(".nav-tab.active");
  const name = active ? active.dataset.view : "temario";
  if (name === "temario" && currentTemaId) openTema(currentTemaId);
  else showView(name);
}

/* ============================= Avisos (notificaciones dentro de la plataforma) =============================
   Colección Firestore "avisos": { titulo, cuerpo, fecha (serverTimestamp) }. La publica el
   administrador desde la pestaña Admin — sirven para avisar de cambios legislativos u otras
   actualizaciones de contenido, no para avisos de tipo distinto. Se muestran con una campanita
   con contador de no leídos; "leído" se guarda solo en este navegador (localStorage). */
function avisosLastSeenKey() {
  return "tb_avisos_visto_" + (currentUid || slug(personaLabel() || "yo"));
}

async function initAvisos() {
  const btn = document.getElementById("btn-avisos");
  if (!btn) return;
  btn.style.display = "";
  btn.onclick = (e) => { e.stopPropagation(); toggleAvisosPanel(); };
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("avisos-panel");
    if (panel.style.display !== "none" && !panel.contains(e.target) && e.target !== btn) {
      panel.style.display = "none";
    }
  });
  await refreshAvisosBadge();
}

async function fetchAvisos() {
  const snap = await firestoreDb.collection("avisos").orderBy("fecha", "desc").limit(50).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function refreshAvisosBadge() {
  try {
    const avisos = await fetchAvisos();
    const lastSeen = parseInt(lsGet(avisosLastSeenKey()) || "0", 10);
    const noLeidos = avisos.filter(a => (a.fecha && a.fecha.toMillis ? a.fecha.toMillis() : 0) > lastSeen).length;
    const badge = document.getElementById("avisos-badge");
    if (badge) {
      if (noLeidos > 0) { badge.textContent = String(noLeidos); badge.style.display = ""; }
      else badge.style.display = "none";
    }
    return avisos;
  } catch (e) {
    console.error("No se pudieron cargar los avisos:", e);
    return [];
  }
}

async function toggleAvisosPanel() {
  const panel = document.getElementById("avisos-panel");
  if (panel.style.display !== "none") { panel.style.display = "none"; return; }
  const avisos = await refreshAvisosBadge();
  panel.innerHTML = avisos.length
    ? avisos.map(a => `
        <div class="aviso-item">
          <div class="aviso-titulo">${escapeHtml(a.titulo || "")}</div>
          <div class="aviso-fecha">${a.fecha && a.fecha.toDate ? a.fecha.toDate().toLocaleString("es-ES") : ""}</div>
          <div class="aviso-cuerpo">${escapeHtml(a.cuerpo || "")}</div>
        </div>`).join("")
    : `<div class="sub" style="padding:14px">Todavía no hay avisos.</div>`;
  panel.style.display = "block";
  let maxMillis = 0;
  for (const a of avisos) {
    const m = a.fecha && a.fecha.toMillis ? a.fecha.toMillis() : 0;
    if (m > maxMillis) maxMillis = m;
  }
  if (maxMillis > 0) lsSet(avisosLastSeenKey(), String(maxMillis));
  const badge = document.getElementById("avisos-badge");
  if (badge) badge.style.display = "none";
}

/* ============================= Panel de administración ============================= */
async function renderAdminPanel() {
  const el = document.getElementById("view-admin");
  if (!CLOUD_ENABLED) {
    el.innerHTML = `<div class="sub" style="padding:20px">Panel de administración no disponible: la plataforma no tiene Firestore configurado.</div>`;
    return;
  }
  el.innerHTML = `<div class="sub" style="padding:20px">Cargando…</div>`;
  let usuarios = [];
  try {
    const snap = await firestoreDb.collection("usuarios").get();
    usuarios = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  } catch (e) {
    el.innerHTML = `<div class="sub" style="padding:20px">No se pudo cargar la lista de usuarios: ${escapeHtml(e.message || "")}</div>`;
    return;
  }
  const pendientes = usuarios.filter(u => u.estado === "pendiente");
  const aprobados = usuarios.filter(u => u.estado === "aprobado");
  const otros = usuarios.filter(u => u.estado === "rechazado" || u.estado === "baja");

  function userRow(u, acciones) {
    return `<div class="admin-row">
      <div class="admin-row-info">
        <div class="admin-row-nombre">${escapeHtml(u.nombre || u.email)}${u.admin ? " · admin" : ""}</div>
        <div class="admin-row-email">${escapeHtml(u.email)}</div>
      </div>
      <div class="admin-row-actions">${acciones}</div>
    </div>`;
  }

  el.innerHTML = `
    <div class="view-inner">
      <h2>Administración de altas</h2>
      <div class="card">
        <h3>Pendientes de aprobar (${pendientes.length})</h3>
        ${pendientes.length ? pendientes.map(u => userRow(u, `
          <button class="btn btn-sm" data-admin-action="aprobar" data-uid="${u.uid}">Aprobar</button>
          <button class="link-btn" data-admin-action="rechazar" data-uid="${u.uid}">Rechazar</button>
        `)).join("") : `<div class="sub">No hay altas pendientes.</div>`}
      </div>
      <div class="card">
        <h3>Usuarios activos (${aprobados.length})</h3>
        ${aprobados.length ? aprobados.map(u => userRow(u, u.admin ? "" : `
          <button class="link-btn" data-admin-action="baja" data-uid="${u.uid}">Dar de baja</button>
        `)).join("") : `<div class="sub">No hay usuarios activos todavía.</div>`}
      </div>
      ${otros.length ? `<div class="card">
        <h3>Rechazados / dados de baja (${otros.length})</h3>
        ${otros.map(u => userRow(u, `<button class="link-btn" data-admin-action="aprobar" data-uid="${u.uid}">Reactivar</button>`)).join("")}
      </div>` : ""}
      <div class="card">
        <h3>Publicar un aviso</h3>
        <div class="sub">Se verá en la campanita de todos los usuarios aprobados (por ejemplo, un cambio legislativo).</div>
        <div class="field-row"><label>Título</label><input type="text" id="admin-aviso-titulo" placeholder="Ej: Actualización del Tema 5 (Levante)"></div>
        <div class="field-row"><label>Texto</label><textarea id="admin-aviso-cuerpo" rows="3" placeholder="Explica brevemente el cambio…"></textarea></div>
        <button class="btn" id="admin-aviso-publicar">Publicar aviso</button>
        <div class="gate-error" id="admin-aviso-error"></div>
      </div>
    </div>
  `;

  el.querySelectorAll("[data-admin-action]").forEach(btn => {
    btn.onclick = async () => {
      const uid = btn.dataset.uid;
      const action = btn.dataset.adminAction;
      const estado = action === "aprobar" ? "aprobado" : action === "rechazar" ? "rechazado" : "baja";
      btn.disabled = true;
      try {
        await firestoreDb.collection("usuarios").doc(uid).update({ estado });
        renderAdminPanel();
      } catch (e) {
        alert("No se pudo actualizar: " + (e.message || e));
        btn.disabled = false;
      }
    };
  });

  document.getElementById("admin-aviso-publicar").onclick = async () => {
    const titulo = document.getElementById("admin-aviso-titulo").value.trim();
    const cuerpo = document.getElementById("admin-aviso-cuerpo").value.trim();
    const errEl = document.getElementById("admin-aviso-error");
    if (!titulo) { errEl.textContent = "Ponle un título al aviso."; return; }
    try {
      await firestoreDb.collection("avisos").add({
        titulo, cuerpo,
        fecha: firebase.firestore.FieldValue.serverTimestamp(),
      });
      document.getElementById("admin-aviso-titulo").value = "";
      document.getElementById("admin-aviso-cuerpo").value = "";
      errEl.style.color = "var(--good)";
      errEl.textContent = "Aviso publicado.";
    } catch (e) {
      errEl.textContent = "No se pudo publicar: " + (e.message || e);
    }
  };
}

/* ============================= Init ============================= */
async function init() {
  await initPersonaAndState();

  const [temarioRes, preguntasRes] = await Promise.all([
    fetch("data/temario.json"),
    fetch("data/preguntas.json"),
  ]);
  TEMARIO = await temarioRes.json();
  PREGUNTAS = await preguntasRes.json();

  renderSidebarList("");
  openTema(TEMARIO.bloques[0].temas[0].id);
  markActivity();

  document.getElementById("search-box").addEventListener("input", (e) => renderSidebarList(e.target.value));
  document.querySelectorAll(".nav-tab").forEach(tab => tab.onclick = () => showView(tab.dataset.view));
}

init().catch(err => {
  document.getElementById("content-wrap").innerHTML = `<p style="color:red">Error cargando datos: ${err.message}.</p>`;
  console.error(err);
});
