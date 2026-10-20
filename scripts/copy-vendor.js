// ═══════════════════════════════════════════════
//  Remplit vendor/ depuis le dépôt serveur (li-puppeteer) — D3.1 du plan.
//
//  Avant ce script, l'app référençait li-puppeteer en dur par un chemin
//  relatif inter-dépôts (../../../li-puppeteer) : ça ne marchait QUE sur un
//  poste où les deux dépôts sont clonés côte à côte (le mien). Sur le poste
//  d'un vrai client, li-puppeteer n'existe pas du tout. vendor/ est une
//  COPIE, à régénérer à chaque build — jamais éditée à la main (tout correctif
//  anti-détection du serveur doit être réappliqué en relançant ce script,
//  jamais dupliqué manuellement, sous peine de diverger silencieusement).
//
//  Usage : node scripts/copy-vendor.js
// ═══════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const SERVEUR_ROOT = path.join(__dirname, '..', '..', 'li-puppeteer');
const VENDOR_ROOT = path.join(__dirname, '..', 'vendor');

// Scripts top-level référencés par mini-worker.js::JOB_HANDLERS — liste tenue
// à jour manuellement, car JOB_HANDLERS lui-même est un sous-ensemble conscient
// de worker.js (voir le commentaire en tête de mini-worker.js).
const SCRIPTS_TOP_LEVEL = [
  'config.js', 'test-login.js',
  'scraper.js', 'scrape-salesnav.js', 'scrape-jobs-search.js', 'scrape-profile-full.js', 'scrape-company-info.js',
  'scrape-activity.js', 'scrape-posts-keyword.js', 'scrape-post-engagement.js',
  'scrape-followers.js', 'scrape-connections.js', 'scrape-profile-views.js',
  'scrape-conversations.js', 'scrape-threads.js', 'scrape-event-attendees.js',
  'scrape-my-activity.js', 'scrape-stats.js',
  'auto-liker.js', 'auto-commenter.js', 'auto-dm.js', 'auto-invite.js', 'profile-visitor.js',
  // Référencés par STEP_HANDLERS de lib/workflow-runner.js (D3.9 — exécution
  // locale du run de workflow entier) — pas par worker.js::JOB_HANDLERS.
  'scrape-activity-batch.js', 'scrape-profile-full-batch.js', 'scrape-post-engagement-batch.js',
];

function copierFichier(rel) {
  const src = path.join(SERVEUR_ROOT, rel);
  const dst = path.join(VENDOR_ROOT, rel);
  if (!fs.existsSync(src)) { console.warn(`  ⚠️  absent côté serveur, ignoré : ${rel}`); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copierDossier(relDir) {
  const srcDir = path.join(SERVEUR_ROOT, relDir);
  for (const entree of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entree.isDirectory()) continue; // lib/ est plat aujourd'hui — pas de sous-dossiers à suivre
    if (!entree.name.endsWith('.js')) continue;
    copierFichier(path.join(relDir, entree.name));
  }
}

console.log(`Copie depuis ${SERVEUR_ROOT} vers ${VENDOR_ROOT}...`);
fs.rmSync(VENDOR_ROOT, { recursive: true, force: true });
copierDossier('lib');
for (const s of SCRIPTS_TOP_LEVEL) copierFichier(s);
console.log('Terminé.');
