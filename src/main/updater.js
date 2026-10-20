// ═══════════════════════════════════════════════
//  Auto-update (electron-updater) — publication sur un dépôt GitHub PUBLIC
//  dédié aux releases (contactliberall/growthlib-desktop-releases), séparé du
//  code source. Pourquoi public : electron-updater lit l'API GitHub Releases
//  sans authentification pour un dépôt public ; un dépôt privé exigerait
//  d'embarquer un jeton d'accès dans l'app distribuée (lisible par quiconque
//  l'inspecte) — inacceptable même pour un pilote à 4 personnes. Le CODE
//  SOURCE reste ailleurs (privé ou local) ; ce dépôt-ci ne contient que les
//  artefacts publiés par `electron-builder --publish always`.
//
//  Vérifie au démarrage puis toutes les 4h (app en tray, souvent ouverte des
//  jours d'affilée — jamais qu'au lancement). Télécharge en silence, installe
//  seulement au prochain redémarrage volontaire de l'app (jamais en pleine
//  session de scraping) — `autoUpdater.quitAndInstall()` n'est appelé QUE
//  depuis le clic "Redémarrer et mettre à jour" du tray, jamais tout seul.
// ═══════════════════════════════════════════════

const { autoUpdater } = require('electron-updater');

const VERIF_PERIODIQUE_MS = 4 * 60 * 60 * 1000;

let etat = { phase: 'inactif', version: null, erreur: null }; // inactif|verification|disponible|telechargement|pret|a_jour|erreur
let onChange = () => {};

function etatActuel() { return etat; }

function init(notifierChangement) {
  if (onChange) onChange = notifierChangement || (() => {});
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // jamais sans clic explicite — voir en-tête

  autoUpdater.on('checking-for-update', () => { etat = { phase: 'verification', version: null, erreur: null }; onChange(); });
  autoUpdater.on('update-available', (info) => { etat = { phase: 'telechargement', version: info.version, erreur: null }; onChange(); });
  autoUpdater.on('update-not-available', () => { etat = { phase: 'a_jour', version: null, erreur: null }; onChange(); });
  autoUpdater.on('download-progress', (p) => { etat = { ...etat, phase: 'telechargement', progres: Math.round(p.percent) }; onChange(); });
  autoUpdater.on('update-downloaded', (info) => { etat = { phase: 'pret', version: info.version, erreur: null }; onChange(); });
  // Jamais fatal : une panne réseau/GitHub ne doit jamais empêcher l'app de tourner
  // avec la version déjà installée — c'est un à-côté, pas une dépendance dure.
  autoUpdater.on('error', (e) => { etat = { phase: 'erreur', version: null, erreur: String(e.message || e).slice(0, 200) }; onChange(); console.warn('[updater]', e.message); });

  verifier();
  setInterval(verifier, VERIF_PERIODIQUE_MS);
}

function verifier() {
  autoUpdater.checkForUpdates().catch((e) => console.warn('[updater] checkForUpdates:', e.message));
}

function installerMaintenant() {
  if (etat.phase !== 'pret') return false;
  autoUpdater.quitAndInstall();
  return true;
}

module.exports = { init, verifier, installerMaintenant, etatActuel };
