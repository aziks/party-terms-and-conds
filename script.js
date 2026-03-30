/* ============================================================
   CONFIGURACIÓN DE FIREBASE
   ─────────────────────────────────────────────────────────────
   Reemplaza los valores YOUR_* con los de tu proyecto Firebase.
   Encuéntralos en: Firebase Console → Configuración del proyecto
   → Tus aplicaciones → Configuración del SDK.
   ============================================================ */
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL:       "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

/* ============================================================
   CLAVE DEL MODO DIRECTOR
   ─────────────────────────────────────────────────────────────
   Cambia "backstage" por la clave secreta que prefieras.
   Acceso: añade ?director=TU_CLAVE a la URL.
   ============================================================ */
const DIRECTOR_KEY = "backstage";

/* ============================================================
   INICIALIZACIÓN DE FIREBASE
   ============================================================ */
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// Referencias a los nodos principales de Firebase
const sessionRef = db.ref('session');
const usersRef   = db.ref('session/users');
const statusRef  = db.ref('session/status');

/* ============================================================
   ESTADO LOCAL DEL CLIENTE
   ============================================================ */

// UUID del participante: persiste en sessionStorage durante la visita
let userId = sessionStorage.getItem('participantId');
if (!userId) {
  userId = 'u' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
  sessionStorage.setItem('participantId', userId);
}

const myRef = usersRef.child(userId); // referencia al nodo de este usuario

let hasAccepted       = false;  // si este cliente pulsó ACEPTO
let currentStatus     = null;   // estado global actual
let countdownTimer    = null;   // intervalo de cuenta atrás
let confettiAnimId    = null;   // requestAnimationFrame del confeti
let confettiActive    = false;  // ¿está el confeti generando partículas?
let confettiParticles = [];     // array de partículas activas

// ¿Es modo director?
const params     = new URLSearchParams(window.location.search);
const isDirector = params.get('director') === DIRECTOR_KEY;

/* ============================================================
   ARRANQUE SEGÚN MODO
   ============================================================ */
if (isDirector) {
  // Modo director: mostrar overlay, no registrar como usuario público
  document.getElementById('director-overlay').classList.add('on');
  startDirectorListeners();
} else {
  // Modo participante: registrar presencia y arrancar la experiencia
  registerUser();
  initScrollDetection();
  document.getElementById('btn-accept').addEventListener('click', onAccept);
  document.getElementById('btn-reject').addEventListener('click', onReject);
}

/* ============================================================
   REGISTRO DEL USUARIO EN FIREBASE
   ============================================================ */
function registerUser() {
  // Escribir nodo de usuario
  myRef.set({
    connected:   true,
    accepted:    null,   // null = sin respuesta todavía
    connectedAt: firebase.database.ServerValue.TIMESTAMP
  });

  // Limpiar el nodo cuando el usuario cierre la pestaña / navegador
  myRef.onDisconnect().remove();

  // Escuchar el estado global (controla qué pantalla se muestra)
  statusRef.on('value', onStatusChange);

  // Escuchar el recuento de usuarios (actualiza la barra y la pantalla de espera)
  usersRef.on('value', onUsersChange);
}

/* ============================================================
   RECONEXIÓN: si Firebase detecta que volvemos a estar online,
   re-publicamos nuestra presencia (por si el nodo fue eliminado).
   ============================================================ */
db.ref('.info/connected').on('value', snap => {
  if (snap.val() === true && !isDirector) {
    myRef.set({
      connected:   true,
      accepted:    hasAccepted ? true : null,
      connectedAt: firebase.database.ServerValue.TIMESTAMP
    });
    myRef.onDisconnect().remove();
  }
});

/* ============================================================
   MANEJADOR DE CAMBIOS DE ESTADO GLOBAL
   ============================================================ */
function onStatusChange(snap) {
  const status = snap.val(); // puede ser null, 'waiting', 'accepted', 'rejected'
  currentStatus = status;

  stopCountdown(); // detener cuenta atrás si estaba corriendo

  if (!status || status === 'waiting') {
    // Estado inicial o reset: comprobar si el nodo de usuario sigue existiendo
    myRef.once('value').then(userSnap => {
      if (!userSnap.exists()) {
        // La sesión fue reseteada: volver al estado inicial
        hasAccepted = false;
        stopConfetti();
        // Re-registrar el usuario
        myRef.set({
          connected:   true,
          accepted:    null,
          connectedAt: firebase.database.ServerValue.TIMESTAMP
        });
        myRef.onDisconnect().remove();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        // Rearmar detección de scroll y botones
        initScrollDetection();
        document.getElementById('action-zone').classList.remove('visible');
        document.getElementById('scroll-hint').style.opacity = '1';
        document.getElementById('btn-accept').disabled = false;
        document.getElementById('btn-reject').disabled = false;
      }
      // Mostrar pantalla correspondiente según si ya aceptó
      showScreen(hasAccepted ? 'waiting' : 'tc');
    });

  } else if (status === 'accepted') {
    showScreen('accepted');
    startConfetti();

  } else if (status === 'rejected') {
    showScreen('rejected');
    startCountdown();
  }
}

/* ============================================================
   MANEJADOR DE CAMBIOS EN EL CONJUNTO DE USUARIOS
   ============================================================ */
function onUsersChange(snap) {
  const users    = snap.val() || {};
  const list     = Object.values(users);
  const total    = list.length;
  const accepted = list.filter(u => u.accepted === true).length;

  // Actualizar barra de estado
  const bar = document.getElementById('status-text');
  if (total === 0) {
    bar.textContent = 'Esperando participantes…';
  } else {
    bar.innerHTML = `<span id="status-count">${accepted}</span>&nbsp;de&nbsp;<span>${total}</span>&nbsp;participantes han prestado su conformidad`;
  }

  // Clases visuales de la barra
  const statusBar = document.getElementById('status-bar');
  statusBar.classList.toggle('all-accepted', total > 0 && accepted === total);
  statusBar.classList.toggle('has-rejected', list.some(u => u.accepted === false));

  // Actualizar texto de espera
  const wp = document.getElementById('waiting-progress');
  if (wp) wp.textContent = total > 0
    ? `${accepted} de ${total} participantes han formalizado su adhesión`
    : '—';

  // Si todos han aceptado y el estado sigue en espera, avanzar
  if (total > 0 && accepted === total && currentStatus === 'waiting') {
    statusRef.set('accepted');
  }
}

/* ============================================================
   ACCIONES DEL PARTICIPANTE
   ============================================================ */
function onAccept() {
  if (hasAccepted) return;
  hasAccepted = true;
  document.getElementById('btn-accept').disabled = true;
  document.getElementById('btn-reject').disabled = true;
  myRef.update({ accepted: true });
  showScreen('waiting');
}

function onReject() {
  // Registrar el rechazo en Firebase → activa PITV para todos
  myRef.update({ accepted: false });
  statusRef.set('rejected');
}

/* ============================================================
   NAVEGACIÓN ENTRE PANTALLAS
   ============================================================ */
function showScreen(name) {
  // name: 'tc' | 'waiting' | 'rejected' | 'accepted'
  const map = {
    'tc':       { id: 'screen-tc',       display: 'block' },
    'waiting':  { id: 'screen-waiting',  display: 'flex'  },
    'rejected': { id: 'screen-rejected', display: 'flex'  },
    'accepted': { id: 'screen-accepted', display: 'flex'  }
  };
  Object.entries(map).forEach(([key, { id, display }]) => {
    const el = document.getElementById(id);
    el.style.display = (key === name) ? display : 'none';
  });
}

/* ============================================================
   DETECCIÓN DE SCROLL: revela botones al llegar al final
   ============================================================ */
function initScrollDetection() {
  const hint = document.getElementById('scroll-hint');
  const zone = document.getElementById('action-zone');

  function checkScroll() {
    const scrolled  = window.scrollY + window.innerHeight;
    const docHeight = document.documentElement.scrollHeight;
    const atBottom  = scrolled >= docHeight - 60;

    if (atBottom) {
      hint.style.opacity = '0';
      zone.classList.add('visible');
    } else {
      hint.style.opacity = '1';
      // No quitamos 'visible' una vez añadida (no se vuelve a ocultar)
    }
  }

  // Limpiar listeners previos sustituyendo el elemento (evita duplicados en resets)
  window.removeEventListener('scroll', checkScroll);
  window.addEventListener('scroll', checkScroll, { passive: true });
  checkScroll(); // comprobar estado inicial
}

/* ============================================================
   CUENTA ATRÁS DE RECHAZO (10 segundos → reset automático)
   ============================================================ */
function startCountdown() {
  if (countdownTimer) return; // ya está corriendo

  let secs = 10;
  const el = document.getElementById('countdown-num');
  if (el) el.textContent = secs;

  countdownTimer = setInterval(() => {
    secs -= 1;
    if (el) el.textContent = secs;
    if (secs <= 0) {
      stopCountdown();
      triggerReset();
    }
  }, 1000);
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

/* ============================================================
   RESET DE SESIÓN (llamado al finalizar la cuenta atrás)
   ============================================================ */
function triggerReset() {
  // Borrar toda la sesión en Firebase y volver a 'waiting'
  sessionRef.remove().then(() => {
    statusRef.set('waiting');
  });
}

/* ============================================================
   CONFETI — animación pura en canvas (sin librerías)
   ============================================================ */
const confCanvas = document.getElementById('confetti-canvas');
const confCtx    = confCanvas.getContext('2d');

// Paleta de colores del confeti
const CONF_COLORS = [
  '#ff3399', '#ff6600', '#ffcc00', '#33ff99',
  '#3399ff', '#cc33ff', '#ff9966', '#00ffcc',
  '#ff3366', '#66ff00', '#ff99cc', '#33ccff'
];

// Ajustar tamaño del canvas al viewport
function resizeConfCanvas() {
  confCanvas.width  = window.innerWidth;
  confCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeConfCanvas, { passive: true });
resizeConfCanvas();

// Crear una partícula de confeti
function newParticle() {
  const isCircle = Math.random() < 0.3;
  return {
    x:      Math.random() * confCanvas.width,
    y:      -12,
    w:      isCircle ? (Math.random() * 7 + 4) : (Math.random() * 9 + 5),
    h:      isCircle ? 0 : (Math.random() * 4 + 2), // 0 = círculo
    color:  CONF_COLORS[Math.floor(Math.random() * CONF_COLORS.length)],
    speed:  Math.random() * 2.5 + 1.2,
    drift:  (Math.random() - 0.5) * 1.8,
    spin:   (Math.random() - 0.5) * 0.14,
    angle:  Math.random() * Math.PI * 2,
    alpha:  Math.random() * 0.4 + 0.6,
    circle: isCircle
  };
}

// Bucle de animación del confeti
function animConf() {
  confCtx.clearRect(0, 0, confCanvas.width, confCanvas.height);

  // Generar nuevas partículas mientras esté activo y no haya demasiadas
  if (confettiActive && confettiParticles.length < 220) {
    for (let i = 0; i < 4; i++) confettiParticles.push(newParticle());
  }

  // Eliminar las que salieron del canvas
  confettiParticles = confettiParticles.filter(p => p.y < confCanvas.height + 20);

  // Dibujar cada partícula
  confettiParticles.forEach(p => {
    p.y     += p.speed;
    p.x     += p.drift;
    p.angle += p.spin;

    confCtx.save();
    confCtx.globalAlpha = p.alpha;
    confCtx.fillStyle   = p.color;
    confCtx.translate(p.x, p.y);
    confCtx.rotate(p.angle);

    if (p.circle) {
      confCtx.beginPath();
      confCtx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
      confCtx.fill();
    } else {
      confCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    }

    confCtx.restore();
  });

  if (confettiParticles.length > 0 || confettiActive) {
    confettiAnimId = requestAnimationFrame(animConf);
  } else {
    confettiAnimId = null;
  }
}

function startConfetti() {
  confettiActive = true;
  if (!confettiAnimId) animConf();
}

function stopConfetti() {
  confettiActive    = false;
  confettiParticles = [];
  if (confettiAnimId) {
    cancelAnimationFrame(confettiAnimId);
    confettiAnimId = null;
  }
  confCtx.clearRect(0, 0, confCanvas.width, confCanvas.height);
}

/* ============================================================
   MODO DIRECTOR — escuchadores en tiempo real
   ============================================================ */
function startDirectorListeners() {
  // Escuchar todos los usuarios
  usersRef.on('value', snap => {
    const users    = snap.val() || {};
    const list     = Object.entries(users);
    const total    = list.length;
    const accepted = list.filter(([, u]) => u.accepted === true).length;
    const rejected = list.filter(([, u]) => u.accepted === false).length;
    const pending  = total - accepted - rejected;

    document.getElementById('d-total').textContent    = total;
    document.getElementById('d-accepted').textContent = accepted;
    document.getElementById('d-pending').textContent  = pending;
    document.getElementById('d-rejected').textContent = rejected;

    // Resaltar si hay rechazos
    document.getElementById('d-rejected').className =
      rejected > 0 ? 'dir-stat-val danger' : 'dir-stat-val';

    document.getElementById('d-progress').textContent =
      total > 0 ? `${accepted} / ${total}` : '—';
  });

  // Log de entradas individuales
  usersRef.on('child_added', snap => {
    dirLog(`Participante #${snap.key.slice(-6)} conectado`, 'connect');
  });

  usersRef.on('child_changed', snap => {
    const d   = snap.val();
    const key = snap.key.slice(-6);
    if (d.accepted === true)  dirLog(`Participante #${key} ha aceptado`, 'accept');
    if (d.accepted === false) dirLog(`Participante #${key} ha rechazado`, 'reject');
  });

  usersRef.on('child_removed', snap => {
    dirLog(`Participante #${snap.key.slice(-6)} desconectado`, 'disconnect');
  });

  // Escuchar estado global
  statusRef.on('value', snap => {
    const s    = snap.val() || 'waiting';
    const pill = document.getElementById('dir-pill');
    const txt  = document.getElementById('d-status-text');

    if (s === 'accepted') {
      pill.className   = 'dir-pill dir-pill-accepted';
      pill.textContent = 'Aceptado';
      txt.textContent  = 'Aceptación global';
    } else if (s === 'rejected') {
      pill.className   = 'dir-pill dir-pill-rejected';
      pill.textContent = 'Rechazado';
      txt.textContent  = 'Rechazo activo — PITV en curso';
    } else {
      pill.className   = 'dir-pill dir-pill-waiting';
      pill.textContent = 'En espera';
      txt.textContent  = 'En espera';
    }

    dirLog(`Estado global → ${s.toUpperCase()}`, 'system');
  });
}

/* ============================================================
   MODO DIRECTOR — añadir entrada al log
   ============================================================ */
function dirLog(msg, type) {
  const log = document.getElementById('dir-log');
  if (!log) return;
  const now = new Date();
  const ts  = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
  const line = document.createElement('div');
  line.className   = `log-line log-${type}`;
  line.textContent = `${ts} — ${msg}`;
  log.insertBefore(line, log.firstChild);
  // Mantener máximo 120 entradas
  while (log.children.length > 120) log.removeChild(log.lastChild);
}

/* ============================================================
   MODO DIRECTOR — controles (llamados desde onclick en el HTML)
   ============================================================ */
function dirForceAccept() {
  statusRef.set('accepted');
  dirLog('Director forzó ACEPTACIÓN global', 'system');
}

function dirForceReject() {
  statusRef.set('rejected');
  dirLog('Director forzó RECHAZO global', 'system');
}

function dirReset() {
  dirLog('Director inició RESETEO de sesión', 'system');
  sessionRef.remove().then(() => {
    statusRef.set('waiting');
    dirLog('Sesión reseteada. Sistema en estado inicial.', 'system');
  });
}
