// ═══════════════════════════════════════════════
//  growthlib-desktop — process principal
//
//  D3.5 : vrai pairing (fenêtre de connexion) + boucle continue du
//  mini-worker + heartbeat — remplace les mécanismes manuels (fichier/env)
//  utilisés pour les jalons précédents (D3.8 points 2-3).
//
//  D3.1 : utilise désormais vendor/ (copie gérée par scripts/copy-vendor.js),
//  plus la référence en dur vers le dépôt serveur li-puppeteer — nécessaire
//  pour tourner sur un poste qui n'a QUE cette app, pas les deux dépôts
//  côte à côte comme sur le poste de dev.
// ═══════════════════════════════════════════════

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const pkg = require('../../package.json');

const SERVEUR_ROOT = path.join(__dirname, '..', '..', 'vendor');
const POLL_MS = 15000; // même cadence que worker.js côté cloud

const auth = require('./auth/supabase-client');
const pairingStore = require('./pairing-store');
const miniWorker = require('./worker/mini-worker');
const updater = require('./updater');

// ─── Démarrage automatique (D3.2) ───────────────────────────────────────────
// Pas de `path` explicite : auto-launch AUTO-DÉTECTE le bon chemin pour une
// app Electron PACKAGÉE (electron-builder, D3.7 — pas encore fait). En dev
// (`electron .`), cette détection vise le binaire Electron générique, pas
// cette app précise — le réglage se posera mais ne survivra pas forcément à
// un redémarrage tant que l'app tourne en mode dev. À re-vérifier après
// packaging, pas un problème à résoudre maintenant.
const AutoLaunch = require('auto-launch');
const autoLauncher = new AutoLaunch({ name: "Growth'Lib Desktop" });
let autoLaunchActif = false; // rafraîchi au démarrage via isEnabled()

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let tray = null;
let pairingWindow = null;
let statusWindow = null;
let widgetWindow = null;
let boucleTimer = null;
let dernierTick = null; // { ok, jobId } | null

async function testerLancementChromeHorsEcran() {
  process.env.STEALTH_HEADFUL = '1';
  process.env.STEALTH_OFFSCREEN = '1';
  process.env.DESKTOP_MODE = '1';
  process.env.PROFILE_ROOT = path.join(app.getPath('userData'), 'profiles-test');

  const li = require(path.join(SERVEUR_ROOT, 'lib', 'browser.js'));
  const browser = await li.launchBrowser();
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 20000 });

  const cdp = await page.target().createCDPSession();
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
  const horsEcran = bounds.left <= -5000;

  await browser.close();
  return { horsEcran, bounds };
}

// ─── Heartbeat (D3.6) ───────────────────────────────────────────────────────
async function envoyerHeartbeat(sb, linkedinAccountId) {
  await sb.from('linkedin_accounts').update({
    desktop_last_seen_at: new Date().toISOString(),
    desktop_app_version: pkg.version,
  }).eq('id', linkedinAccountId);
}

// ─── Boucle continue (remplace les ticks manuels des jalons précédents) ────
//
// ⚠️ BUG RÉEL, trouvé en conditions réelles le 06/10 : `setInterval(executer,
// POLL_MS)` déclenche le tick suivant sur une horloge fixe, SANS attendre que
// le tick précédent (dont l'exécution d'un job — ouverture Chrome, action
// réelle — dépasse presque toujours 15s) soit terminé. Deux jobs (#7787 like,
// #7788 comment) ont ainsi tourné en PARALLÈLE sur LE MÊME compte, deux
// sessions Chrome concurrentes sur le même profil persistant — exactement le
// signal ("connexion concurrente") que ce produit détecte et redoute déjà
// côté cloud. Un setTimeout reprogrammé APRÈS la fin de chaque tick garantit
// une exécution strictement séquentielle, comme pollLoop() dans worker.js.
let boucleActive = false;
// D5.5 (07/10/2026) : un tick en vol (Chrome ouvert, job en cours) n'était ni
// attendu ni annulé par arreterBoucle() — dePairer() rebasculait connection_mode
// vers 'cloud' immédiatement, pendant que ce job pouvait encore écrire dans
// scrape_jobs juste au moment où le worker cloud redevenait éligible à réclamer
// ce même compte. `tickEnCours` + `attendreTickEnCours()` ferment cette fenêtre.
let tickEnCours = false;
let resolveTickActuel = null;
function attendreTickEnCours() {
  if (!tickEnCours) return Promise.resolve();
  return new Promise((resolve) => { resolveTickActuel = resolve; });
}

function demarrerBoucle(cfg) {
  if (boucleActive) return; // déjà en cours
  boucleActive = true;
  process.env.PROFILE_ROOT = path.join(app.getPath('userData'), 'profiles');
  const executer = async () => {
    tickEnCours = true;
    try {
      const sb = auth.buildClient();
      await envoyerHeartbeat(sb, cfg.linkedinAccountId);
      const accessToken = await auth.currentAccessToken();
      // lib/post-job-router.js, lib/rate-limiter.js, lib/notify-cookie.js et
      // lib/webhooks.js tournent dans CE process (pas un enfant spawné) et
      // résolvent leur client via lib/db-client.js, qui lit cette variable.
      process.env.GROWTHLIB_DESKTOP_ACCESS_TOKEN = accessToken;
      // D5.4 : lu par lib/db-client.js pour forcer le scoping défensif
      // (linkedin_account_id/id) sur scrape_jobs/linkedin_accounts/rate_limit_log,
      // indépendamment de la RLS admin partagée (Option A, pilote uniquement).
      process.env.GROWTHLIB_DESKTOP_ACCOUNT_ID = String(cfg.linkedinAccountId);
      const r = await miniWorker.tick({ sb, userId: cfg.userId, linkedinAccountId: cfg.linkedinAccountId, accessToken, serveurRoot: SERVEUR_ROOT });
      if (r) dernierTick = { ok: r.ok, jobId: r.job.id, quand: new Date() };
      majTray();
    } catch (e) {
      console.error('[boucle]', e.message);
      dernierTick = { ok: false, erreur: e.message, quand: new Date() };
      majTray();
    } finally {
      tickEnCours = false;
      if (resolveTickActuel) { resolveTickActuel(); resolveTickActuel = null; }
      if (boucleActive) boucleTimer = setTimeout(executer, POLL_MS);
    }
  };
  executer(); // premier tick immédiat, pas d'attente de 15s
}

function arreterBoucle() {
  boucleActive = false;
  if (boucleTimer) { clearTimeout(boucleTimer); boucleTimer = null; }
}

// ─── Pairing (D3.5) ─────────────────────────────────────────────────────────
function ouvrirFenetrePairing() {
  if (pairingWindow) { pairingWindow.focus(); return; }
  pairingWindow = new BrowserWindow({
    width: 420, height: 420, resizable: false,
    title: "Growth'Lib Desktop — Connexion",
    webPreferences: { preload: path.join(__dirname, 'preload-pairing.js'), contextIsolation: true, nodeIntegration: false },
  });
  pairingWindow.setMenuBarVisibility(false);
  pairingWindow.loadFile(path.join(__dirname, '..', 'renderer', 'pairing.html'));
  pairingWindow.on('closed', () => { pairingWindow = null; });
}

// ─── Widget permanent, coin bas-droit (façon Time to TAF) ──────────────────
const WIDGET_W = 190, WIDGET_H = 64, WIDGET_MARGE = 16;
function ouvrirWidget() {
  if (widgetWindow) { widgetWindow.show(); return; }
  const { width, height } = screen.getPrimaryDisplay().workArea;
  widgetWindow = new BrowserWindow({
    width: WIDGET_W, height: WIDGET_H,
    x: width - WIDGET_W - WIDGET_MARGE, y: height - WIDGET_H - WIDGET_MARGE,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload-widget.js'), contextIsolation: true, nodeIntegration: false },
  });
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widgetWindow.loadFile(path.join(__dirname, '..', 'renderer', 'widget.html'));
  widgetWindow.on('closed', () => { widgetWindow = null; });
}
function fermerWidget() {
  if (widgetWindow) { widgetWindow.close(); widgetWindow = null; }
}

ipcMain.handle('widget:open-dashboard', () => ouvrirFenetreStatut());
ipcMain.handle('widget:hide', () => fermerWidget());

// ─── Tableau de bord (KPI + tendance 10j + détail) ─────────────────────────
function ouvrirFenetreStatut() {
  if (statusWindow) { statusWindow.focus(); return; }
  statusWindow = new BrowserWindow({
    width: 720, height: 680,
    title: "Growth'Lib Desktop — Tableau de bord",
    webPreferences: { preload: path.join(__dirname, 'preload-status.js'), contextIsolation: true, nodeIntegration: false },
  });
  statusWindow.setMenuBarVisibility(false);
  statusWindow.loadFile(path.join(__dirname, '..', 'renderer', 'status.html'));
  statusWindow.on('closed', () => { statusWindow = null; });
}

const FENETRE_TENDANCE_J = 10;

ipcMain.handle('status:get-jobs', async () => {
  const cfg = pairingStore.read();
  if (!cfg) return { compteLabel: 'Non apparié' };
  const sb = auth.buildClient();
  const depuis10j = new Date(Date.now() - FENETRE_TENDANCE_J * 86400000).toISOString();

  const [acc, pending, pendingCount, recents, workflowsActifs, realises10j, echecs10j] = await Promise.all([
    sb.from('linkedin_accounts').select('label,email').eq('id', cfg.linkedinAccountId).maybeSingle(),
    sb.from('scrape_jobs').select('id,type,input,scheduled_for')
      .eq('linkedin_account_id', cfg.linkedinAccountId).eq('status', 'pending')
      .order('scheduled_for', { ascending: true }).limit(50),
    sb.from('scrape_jobs').select('id', { count: 'exact', head: true })
      .eq('linkedin_account_id', cfg.linkedinAccountId).eq('status', 'pending'),
    sb.from('scrape_jobs').select('id,type,input,status,finished_at,error')
      .eq('linkedin_account_id', cfg.linkedinAccountId).in('status', ['done', 'failed'])
      .order('finished_at', { ascending: false }).limit(20),
    sb.from('workflows').select('id', { count: 'exact', head: true }).eq('user_id', cfg.userId).eq('enabled', true),
    // Tendance : on redemande juste finished_at (léger) pour regrouper par jour nous-mêmes —
    // pas de GROUP BY côté PostgREST sans RPC dédiée, et ça n'en vaut pas la peine pour 10 jours.
    sb.from('scrape_jobs').select('finished_at')
      .eq('linkedin_account_id', cfg.linkedinAccountId).eq('status', 'done').gte('finished_at', depuis10j),
    sb.from('scrape_jobs').select('id', { count: 'exact', head: true })
      .eq('linkedin_account_id', cfg.linkedinAccountId).eq('status', 'failed').gte('finished_at', depuis10j),
  ]);

  // Tendance jour par jour, 10 derniers jours, aujourd'hui inclus en dernier.
  const parJour = {};
  for (const j of (realises10j.data || [])) {
    const jour = j.finished_at.slice(0, 10);
    parJour[jour] = (parJour[jour] || 0) + 1;
  }
  const tendance = [];
  for (let i = FENETRE_TENDANCE_J - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    tendance.push({ jour: iso, n: parJour[iso] || 0 });
  }

  const compteLabel = (acc.data && (acc.data.label || acc.data.email)) || `Compte #${cfg.linkedinAccountId}`;
  return {
    compteLabel,
    pending: pending.data || [],
    recents: recents.data || [],
    kpi: {
      workflowsActifs: workflowsActifs.count || 0,
      jobsEnAttente: pendingCount.count || 0,
      jobsRealises10j: (realises10j.data || []).length,
      alertes10j: echecs10j.count || 0,
    },
    tendance,
    fenetreJours: FENETRE_TENDANCE_J,
  };
});

ipcMain.handle('pairing:login', async (_evt, email, password) => {
  await auth.login(email, password);
  return true;
});

ipcMain.handle('pairing:list-accounts', async () => {
  const sb = auth.buildClient();
  const uid = auth.currentUid();
  const { data, error } = await sb.from('linkedin_accounts').select('id,label,email').eq('user_id', uid).order('id');
  if (error) throw new Error('Lecture des comptes : ' + error.message);
  return data || [];
});

// D5.6 (07/10/2026) : rien n'empêchait jusqu'ici deux postes de se parier au
// même compte, chacun démarrant sa propre boucle — deux sessions Chrome
// indépendantes sur le même compte. On bloque si le compte est déjà 'local'
// avec un heartbeat récent (un autre poste tourne vraisemblablement dessus).
const SEUIL_AUTRE_POSTE_ACTIF_MIN = 5;

ipcMain.handle('pairing:select-account', async (_evt, linkedinAccountId) => {
  const sb = auth.buildClient();
  const uid = auth.currentUid();

  const { data: actuel, error: eLecture } = await sb.from('linkedin_accounts')
    .select('connection_mode,desktop_last_seen_at').eq('id', linkedinAccountId).eq('user_id', uid).maybeSingle();
  if (eLecture) throw new Error('Lecture du compte : ' + eLecture.message);
  if (actuel && actuel.connection_mode === 'local' && actuel.desktop_last_seen_at) {
    const minutesDepuis = (Date.now() - new Date(actuel.desktop_last_seen_at).getTime()) / 60000;
    if (minutesDepuis < SEUIL_AUTRE_POSTE_ACTIF_MIN) {
      throw new Error(`Ce compte est déjà piloté en local, vu actif il y a ${Math.round(minutesDepuis)} min — probablement un autre poste. Dé-pairer cet autre poste avant de continuer ici.`);
    }
  }

  const { error } = await sb.from('linkedin_accounts')
    .update({ connection_mode: 'local' }).eq('id', linkedinAccountId).eq('user_id', uid);
  if (error) throw new Error('Bascule connection_mode : ' + error.message);
  pairingStore.write({ userId: uid, linkedinAccountId });
  if (pairingWindow) { pairingWindow.close(); }
  demarrerBoucle({ userId: uid, linkedinAccountId });
  ouvrirWidget();
  // Activé par défaut au premier pairing — cohérent avec l'objectif initial
  // ("se lance automatiquement quand l'ordinateur est allumé"). Réversible
  // depuis le tray, jamais ré-imposé si l'utilisateur l'a désactivé lui-même.
  try { await autoLauncher.enable(); autoLaunchActif = true; } catch (e) { console.warn('[auto-launch] enable:', e.message); }
  majTray();
  return true;
});

async function basculerAutoLaunch() {
  try {
    if (autoLaunchActif) { await autoLauncher.disable(); autoLaunchActif = false; }
    else { await autoLauncher.enable(); autoLaunchActif = true; }
  } catch (e) { dialog.showErrorBox('Démarrage automatique', e.message); }
  majTray();
}

async function dePairer() {
  const cfg = pairingStore.read();
  arreterBoucle();
  await attendreTickEnCours(); // ⚠️ laisser le job en cours se terminer avant de rebasculer connection_mode
  if (cfg) {
    try {
      const sb = auth.buildClient();
      await sb.from('linkedin_accounts').update({ connection_mode: 'cloud' }).eq('id', cfg.linkedinAccountId).eq('user_id', cfg.userId);
    } catch (e) { console.warn('dé-pairing : bascule cloud a échoué —', e.message); }
  }
  pairingStore.clear();
  auth.clear();
  dernierTick = null;
  fermerWidget();
  majTray();
  ouvrirFenetrePairing();
}

// ─── Tray ───────────────────────────────────────────────────────────────────
function majTray() {
  if (!tray) return;
  const cfg = pairingStore.read();
  let statut;
  if (!cfg) statut = 'Non apparié';
  else if (!dernierTick) statut = `Compte #${cfg.linkedinAccountId} — en attente du premier cycle`;
  else if (dernierTick.erreur) statut = `Compte #${cfg.linkedinAccountId} — erreur : ${dernierTick.erreur.slice(0, 60)}`;
  else if (dernierTick.jobId) statut = `Compte #${cfg.linkedinAccountId} — job #${dernierTick.jobId} → ${dernierTick.ok ? 'done' : 'failed'} (${dernierTick.quand.toLocaleTimeString()})`;
  else statut = `Compte #${cfg.linkedinAccountId} — actif, aucun job en attente (${dernierTick.quand.toLocaleTimeString()})`;
  tray.setToolTip("Growth'Lib Desktop — " + statut);

  const items = [{ label: statut, enabled: false }, { type: 'separator' }];
  if (cfg) {
    items.push(
      { label: 'Tableau de bord complet', click: ouvrirFenetreStatut },
      { label: widgetWindow ? 'Masquer le widget' : 'Afficher le widget', click: () => (widgetWindow ? fermerWidget() : ouvrirWidget()) },
      { label: 'Dé-pairer (revenir au cloud)', click: dePairer },
    );
  } else {
    items.push({ label: 'Se connecter…', click: ouvrirFenetrePairing });
  }
  const maj = updater.etatActuel();
  items.push({ type: 'separator' });
  if (maj.phase === 'pret') {
    items.push({ label: `⬇ Mise à jour ${maj.version} prête — redémarrer`, click: () => updater.installerMaintenant() });
  } else if (maj.phase === 'telechargement') {
    items.push({ label: `Téléchargement ${maj.version || ''}… ${maj.progres != null ? maj.progres + '%' : ''}`, enabled: false });
  } else if (maj.phase === 'erreur') {
    items.push({ label: 'Vérifier les mises à jour (dernière vérif. en échec)', click: () => updater.verifier() });
  } else {
    items.push({ label: 'Vérifier les mises à jour', click: () => updater.verifier() });
  }
  items.push(
    { type: 'separator' },
    {
      label: autoLaunchActif ? '✓ Démarrage automatique' : 'Activer le démarrage automatique',
      click: basculerAutoLaunch,
    },
    { type: 'separator' },
    {
      label: 'Diagnostic : Chrome hors écran',
      click: async () => {
        try {
          const { horsEcran, bounds } = await testerLancementChromeHorsEcran();
          dialog.showMessageBox({ message: horsEcran ? `OK — hors écran (${JSON.stringify(bounds)})` : `ÉCHEC — re-clampé (${JSON.stringify(bounds)})` });
        } catch (e) { dialog.showErrorBox('Diagnostic Chrome hors écran — erreur', e.message); }
      },
    },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

app.whenReady().then(async () => {
  auth.init(app.getPath('userData'));
  pairingStore.init(app.getPath('userData'));
  try { autoLaunchActif = await autoLauncher.isEnabled(); } catch (e) { console.warn('[auto-launch] isEnabled:', e.message); }

  const icone = nativeImage.createEmpty(); // placeholder — remplacer avant toute diffusion réelle
  tray = new Tray(icone);
  majTray();
  updater.init(majTray);

  const cfg = pairingStore.read();
  if (cfg && auth.isPaired()) {
    demarrerBoucle(cfg);
    ouvrirWidget();
  } else {
    ouvrirFenetrePairing();
  }

  // Vérifications automatisées héritées des jalons précédents (D3.8.2/D3.8.3) —
  // toujours utiles pour un diagnostic rapide sans passer par le tray.
  if (process.env.GROWTHLIB_DESKTOP_SELFTEST_CHROME === '1') {
    try {
      const { horsEcran, bounds } = await testerLancementChromeHorsEcran();
      console.log('SELFTEST_CHROME_RESULT', JSON.stringify({ ok: horsEcran, bounds }));
    } catch (e) { console.log('SELFTEST_CHROME_RESULT', JSON.stringify({ ok: false, error: e.message })); }
    app.quit();
  }
});
app.on('window-all-closed', (e) => e.preventDefault()); // app sans fenêtre visible, reste en tray
