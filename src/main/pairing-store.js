// ═══════════════════════════════════════════════
//  Config locale de l'installation (D3.4) — QUEL compte LinkedIn ce poste
//  pilote. Jamais de secret ici (le token vit chiffré via safeStorage dans
//  auth/supabase-client.js) — juste des identifiants, lisibles en clair.
// ═══════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

let file = null;

function init(userDataPath) { file = path.join(userDataPath, 'config.json'); }

function read() {
  if (!file || !fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function write(cfg) {
  if (!file) throw new Error('pairing-store.init() non appelé');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

function clear() {
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch (e) {}
}

module.exports = { init, read, write, clear };
