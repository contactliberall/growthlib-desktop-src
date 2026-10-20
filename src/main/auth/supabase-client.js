// ═══════════════════════════════════════════════
//  Auth du device (D2.3) — port direct du pattern déjà en prod dans
//  liberall-os-extension/background.js::getValidSession() / popup.js::login().
//  Refresh PARESSEUX (décode l'exp du JWT, ne rafraîchit que si <60s restantes),
//  jamais de minuteur périodique — le trafic du mini-worker est en rafales.
//
//  D2.1 — Option A pour ce jalon (pilote, ton propre compte admin) : accès
//  large accepté PARCE QUE le risque devient le tien sur ton propre poste.
//  Option B (device_credentials scopé par linkedin_account_id) reste à
//  construire avant tout client réel — ne JAMAIS copier ce fichier tel quel
//  pour un déploiement client sans l'avoir fait.
// ═══════════════════════════════════════════════

const { safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

// Clé anon PUBLIQUE (même projet Supabase que liberall-os-extension/background.js
// et lib/db-client.js côté serveur) — la RLS fait l'isolation, pas le secret de cette clé.
const SUPA_URL = 'https://rfxnmqykeotlfdscezws.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmeG5tcXlrZW90bGZkc2NlendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3Mjc5NzEsImV4cCI6MjA5MDMwMzk3MX0.aP7g5IyMMsFg-ts6BwDzL9BaOLRFwsLT14SH5MXzuIc';

let sessionFile = null;
let session = null; // { access_token, refresh_token, uid, email }

function init(userDataPath) {
  sessionFile = path.join(userDataPath, 'session.enc');
  if (fs.existsSync(sessionFile) && safeStorage.isEncryptionAvailable()) {
    try {
      session = JSON.parse(safeStorage.decryptString(fs.readFileSync(sessionFile)));
    } catch (e) { session = null; }
  }
}

function persist() {
  if (!sessionFile) throw new Error('auth.init() non appelé');
  fs.writeFileSync(sessionFile, safeStorage.encryptString(JSON.stringify(session)));
}

function clear() {
  session = null;
  try { if (sessionFile && fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile); } catch (e) {}
}

async function login(email, password) {
  const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.msg || j.error || 'Identifiants invalides');
  session = { access_token: j.access_token, refresh_token: j.refresh_token, uid: j.user && j.user.id, email: j.user && j.user.email };
  persist();
  return session;
}

// Décode l'exp SANS vérifier la signature — on ne fait ici que lire une donnée
// publique du payload pour décider s'il faut rafraîchir ; la vérification réelle
// est de toute façon faite par PostgREST/GoTrue à chaque requête.
function expMs(accessToken) {
  try { return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString()).exp * 1000; }
  catch (e) { return 0; }
}

async function refreshIfNeeded() {
  if (!session) throw new Error('Non apparié — lancer le pairing.');
  if (Date.now() < expMs(session.access_token) - 60000) return session;
  const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  const j = await r.json();
  if (!r.ok) { clear(); throw new Error('Session expirée, re-pairing nécessaire.'); }
  // Supabase ROTATE le refresh_token à chaque appel : si on ne persiste pas le
  // NOUVEAU, le refresh suivant échoue avec l'ancien (déjà invalidé).
  session = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    uid: (j.user && j.user.id) || session.uid,
    email: (j.user && j.user.email) || session.email,
  };
  persist();
  return session;
}

function buildClient() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(SUPA_URL, ANON, {
    auth: { persistSession: false },
    // Electron bundle Node 20 (pas de WebSocket natif, arrivé en Node 22) —
    // supabase-js construit son RealtimeClient au chargement même si on ne
    // s'abonne jamais à rien ; sans ce polyfill explicite, la construction
    // du client échoue avant même la première requête REST.
    realtime: { transport: require('ws') },
    global: {
      fetch: async (url, opts = {}) => {
        await refreshIfNeeded();
        // ⚠️ `opts.headers` est une instance Headers (pas un objet simple) :
        // `{ ...opts.headers }` la spreade en `{}` (ses entrées ne sont pas des
        // props énumérables), ce qui faisait disparaître le header `apikey` que
        // supabase-js pose par défaut — PostgREST répondait alors « No API key
        // found in request ». Passer par le constructeur Headers préserve tout.
        const headers = new Headers(opts.headers || {});
        headers.set('Authorization', `Bearer ${session.access_token}`);
        return fetch(url, { ...opts, headers });
      },
    },
  });
}

function isPaired() { return !!session; }
function currentUid() { return session && session.uid; }
async function currentAccessToken() { await refreshIfNeeded(); return session.access_token; }

module.exports = { init, login, clear, buildClient, isPaired, currentUid, currentAccessToken };
