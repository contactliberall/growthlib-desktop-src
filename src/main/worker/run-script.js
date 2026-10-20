// ═══════════════════════════════════════════════
//  Port de worker.js::runScript() — même logique, deux différences :
//   1. spawn(process.execPath, ..., { env: { ELECTRON_RUN_AS_NODE: '1' } })
//      au lieu de spawn('node', ...) : pas de Node système garanti sur un
//      poste client, on réutilise le binaire Electron déjà présent.
//   2. GROWTHLIB_DESKTOP_ACCESS_TOKEN injecté : le process enfant n'hérite
//      d'aucun état mémoire du process principal (setClientOverride ne vaut
//      que pour CE process) — lib/db-client.js (serveur) sait lire ce jeton.
// ═══════════════════════════════════════════════

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function runScript(serveurRoot, scriptName, args, ctx = {}) {
  return new Promise((resolve) => {
    const scriptPath = path.join(serveurRoot, scriptName);
    if (!fs.existsSync(scriptPath)) {
      return resolve({ ok: false, error: `Script introuvable : ${scriptName}` });
    }
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    if (ctx.userId) env.WORKER_USER_ID = ctx.userId;
    if (ctx.linkedinAccountId) env.WORKER_LI_ACCOUNT_ID = String(ctx.linkedinAccountId);
    else delete env.WORKER_LI_ACCOUNT_ID;
    if (ctx.jobId) env.JOB_ID = String(ctx.jobId);
    if (ctx.jobInput) env.JOB_INPUT = JSON.stringify(ctx.jobInput);
    if (ctx.accessToken) env.GROWTHLIB_DESKTOP_ACCESS_TOKEN = ctx.accessToken;
    env.AUTO_LOGIN = ctx.autoLogin ? 'on' : 'off';
    env.STEALTH_HEADFUL = '1';
    env.STEALTH_OFFSCREEN = '1';
    env.DESKTOP_MODE = '1';

    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: serveurRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '', stderr = '', killed = false, timedOut = false;
    child.stdout.on('data', d => { stdout += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', d => { stderr += d.toString(); process.stderr.write(d); });

    const timeoutMs = ctx.timeoutMs || 8 * 60 * 1000;
    const killTimer = setTimeout(() => {
      if (killed) return;
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (e) {}
      setTimeout(() => {
        if (!killed) { killed = true; resolve({ ok: false, code: -1, stdout, stderr, timedOut: true }); }
      }, 5000);
    }, timeoutMs);

    child.on('close', code => {
      if (killed) return;
      killed = true;
      clearTimeout(killTimer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });
    child.on('error', err => {
      if (killed) return;
      killed = true;
      clearTimeout(killTimer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr + '\n[SPAWN-ERROR] ' + err.message });
    });
  });
}

function readJobOutput(serveurRoot, jobId, prefixes) {
  for (const p of prefixes) {
    const filePath = path.join(serveurRoot, `${p}_job${jobId}.json`);
    if (fs.existsSync(filePath)) {
      try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch (e) { return null; }
    }
  }
  return null;
}

module.exports = { runScript, readJobOutput };
