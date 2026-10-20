// ═══════════════════════════════════════════════
//  Mini-worker (D3.4) — port de worker.js::processJob, scopé à UN seul
//  compte. Explicitement hors-scope (restent le cerveau côté cloud) :
//  campaignRunner (déjà 100% file d'attente, rien à déplacer),
//  reclamerJobsOrphelins, la logique comptesHorsService/comptesLocaux (c'est
//  le CLOUD qui s'exclut lui-même en lisant connection_mode).
//
//  workflowRunner (D3.9) : le CLOUD met en file un job `run_workflow` quand
//  un run est dû pour un compte local (au lieu de l'exécuter lui-même — voir
//  le garde-fou dans lib/workflow-runner.js::runWorkflow). Ce mini-worker le
//  réclame et appelle runWorkflow() EN PROCESS (cas spécial dans tick(),
//  pas un JOB_HANDLERS classique) — même fonction que le cloud, partagée via
//  vendor/, donc le step-chaining synchrone entre étapes reste intact.
// ═══════════════════════════════════════════════

const path = require('path');
const { runScript, readJobOutput } = require('./run-script');

// Même carte que worker.js::JOB_HANDLERS (worker.js:32-54) — une seule
// différence volontaire : send_digest est un handler SERVEUR interne
// (mailer, pas de navigateur) et n'a aucune raison de tourner ici ; un
// compte en mode local n'a par construction aucun job send_digest créé
// pour lui (c'est un job par USER, pas par compte).
const JOB_HANDLERS = {
  search:          (input) => ({ script: 'scraper.js',              args: [input.url, String(input.limit || 50)] }),
  sales_nav:       (input) => ({ script: 'scrape-salesnav.js',       args: [input.url, String(input.limit || 25)] }),
  jobs_search:     (input) => ({ script: 'scrape-jobs-search.js',    args: [input.url, String(input.limit || 25)] }),
  full_profile:    (input) => ({ script: 'scrape-profile-full.js',   args: [input.profileUrl] }),
  company_info:    (input) => ({ script: 'scrape-company-info.js',   args: [input.companyUrl] }),
  activity:        (input) => ({ script: 'scrape-activity.js',       args: [input.profileUrl, String(input.limit || 20), String(input.days || 0)] }),
  posts_keyword:   (input) => ({ script: 'scrape-posts-keyword.js',  args: [input.keyword, String(input.limit || 20)] }),
  post_engagement: (input) => ({ script: 'scrape-post-engagement.js',args: [input.postUrl, String(input.limit || 50)] }),
  followers:       (input) => ({ script: 'scrape-followers.js',      args: [String(input.limit || 30)] }),
  connections:     (input) => ({ script: 'scrape-connections.js',    args: [String(input.limit || 500)] }),
  profile_viewers: (input) => ({ script: 'scrape-profile-views.js',  args: [String(input.limit || 20)] }),
  conversations:   (input) => ({ script: 'scrape-conversations.js',  args: [String(input.limit || 30)] }),
  dm_threads:      (input) => ({ script: 'scrape-threads.js',         args: [String(input.limitThreads || 15), String(input.maxMsgPerThread || 50)] }),
  event_attendees: (input) => ({ script: 'scrape-event-attendees.js',args: [input.eventUrl, String(input.limit || 50)] }),
  my_activity:     (input) => ({ script: 'scrape-my-activity.js',    args: [String(input.limit || 30)] }),
  stats:           (input) => ({ script: 'scrape-stats.js',          args: [] }),
  like:            (input) => ({ script: 'auto-liker.js',            args: [input.postUrl] }),
  comment:         (input) => ({ script: 'auto-commenter.js',        args: [input.postUrl, input.text] }),
  dm:              (input) => ({ script: 'auto-dm.js',               args: [input.profileUrl, input.text] }),
  invite:          (input) => ({ script: 'auto-invite.js',           args: [input.profileUrl, input.note || ''] }),
  visit:           (input) => ({ script: 'profile-visitor.js',       args: [input.profileUrl] }),
  test_login:      () => ({ script: 'test-login.js',                 args: [] }),
};

// Port de worker.js::JOB_TIMEOUTS_MS (worker.js:224-251), inchangé.
const JOB_TIMEOUTS_MS = {
  test_login: 10 * 60 * 1000,
  like: 4 * 60 * 1000, comment: 4 * 60 * 1000, dm: 4 * 60 * 1000, invite: 4 * 60 * 1000, visit: 4 * 60 * 1000,
  stats: 3 * 60 * 1000, search: 8 * 60 * 1000, sales_nav: 20 * 60 * 1000, jobs_search: 15 * 60 * 1000,
  full_profile: 6 * 60 * 1000, company_info: 4 * 60 * 1000, activity: 6 * 60 * 1000,
  posts_keyword: 8 * 60 * 1000, post_engagement: 8 * 60 * 1000, followers: 8 * 60 * 1000,
  connections: 14 * 60 * 1000, profile_viewers: 6 * 60 * 1000, conversations: 6 * 60 * 1000,
  event_attendees: 8 * 60 * 1000, my_activity: 6 * 60 * 1000, dm_threads: 14 * 60 * 1000,
};
const DEFAULT_JOB_TIMEOUT_MS = 8 * 60 * 1000;

// Port de worker.js::CODE_ECHEC/CODES_PLATEFORME/REPRISE (worker.js:117-169),
// inchangé — pure, aucune dépendance DB.
const CODE_ECHEC = {
  invalid_profile_url: 'target_not_found', post_not_found: 'target_not_found',
  redirected: 'target_not_found', message_button_not_found: 'target_not_found',
  linkedin_error_page: 'transient_error',
  send_button_not_found: 'ui_changed', publish_button_not_found: 'ui_changed',
  editor_not_found: 'ui_changed', no_button: 'ui_changed',
  send_unconfirmed: 'action_unconfirmed', like_unconfirmed: 'action_unconfirmed', comment_unconfirmed: 'action_unconfirmed',
  note_typing_error: 'script_error', typing_error: 'script_error',
  message_button_click_error: 'script_error', send_error: 'script_error', error: 'script_error',
};
const CODES_PLATEFORME = new Set(['ui_changed']);
function codeEchec(statutSortie) { return statutSortie ? (CODE_ECHEC[statutSortie] || 'unknown') : 'no_data'; }

const REPRISE = {
  transient_error: { essais: 3, delaiMin: 5 },
  proxy_error: { essais: 2, delaiMin: 10 },
  timeout: { essais: 2, delaiMin: 10 },
  script_error: { essais: 2, delaiMin: 10 },
  no_data: { essais: 1, delaiMin: 15 },
  ui_changed: { essais: 1, delaiMin: 20 },
  unknown: { essais: 1, delaiMin: 15 },
};

// Port de worker.js::finaliserEchec (worker.js:173-212) — paramétré sur `sb`
// au lieu d'un `supabase` de module (ce fichier n'a pas de service_role).
// Même sémantique : replanifie si la cause est rejouable, sinon échec définitif.
async function finaliserEchec(sb, serveurRoot, job, { error, code, output }) {
  const regle = REPRISE[code];
  const dejaFait = job.retry_count || 0;
  if (regle && dejaFait < regle.essais) {
    const delaiMs = regle.delaiMin * 60000 * Math.pow(2, dejaFait);
    await sb.from('scrape_jobs').update({
      status: 'pending',
      error: `Tentative ${dejaFait + 1}/${regle.essais + 1} échouée (${code}) : ${String(error).slice(0, 400)}`,
      error_code: code, retry_count: dejaFait + 1,
      scheduled_for: new Date(Date.now() + delaiMs).toISOString(),
      started_at: null, finished_at: null,
    }).eq('id', job.id);
    console.log(`[mini-worker] job #${job.id} rejoué dans ${Math.round(delaiMs / 60000)} min (${code})`);
    return true;
  }
  const suffixe = dejaFait ? ` (abandon après ${dejaFait} relance${dejaFait > 1 ? 's' : ''})` : '';
  try {
    await require(path.join(serveurRoot, 'lib', 'webhooks.js')).emettre('job.failed', job.user_id, {
      job_id: job.id, type: job.type, error_code: code, erreur: String(error).slice(0, 300),
      relances: dejaFait, linkedin_account_id: job.linkedin_account_id,
    });
  } catch (e) { /* jamais bloquant */ }
  await sb.from('scrape_jobs').update({
    status: 'failed',
    output: output !== undefined ? output : undefined,
    error: String(error).slice(0, 2000) + suffixe,
    error_code: code,
    finished_at: new Date().toISOString(),
  }).eq('id', job.id);
  return false;
}

// Port réduit de worker.js::maybeAutoPauseAccount (worker.js:568-624) — même
// seuil/fenêtre, email client identique. Notif Make (lib/notify) omise
// volontairement : ce canal alerte l'ÉQUIPE d'une panne FLOTTE, pas pertinent
// pour un poste client isolé qui ne gère qu'un compte.
const PAUSE_THRESHOLD = 5;
const PAUSE_WINDOW_MIN = 30;
const CAUSES_NON_IMPUTABLES = new Set(['ui_changed', 'proxy_error', 'timeout', 'worker_restart']);

async function maybeAutoPauseAccount(sb, linkedinAccountId, userId) {
  if (!linkedinAccountId) return;
  try {
    const since = new Date(Date.now() - PAUSE_WINDOW_MIN * 60000).toISOString();
    const { data: echecs } = await sb.from('scrape_jobs').select('error_code')
      .eq('linkedin_account_id', linkedinAccountId).eq('status', 'failed').gte('finished_at', since);
    const count = (echecs || []).filter(j => !CAUSES_NON_IMPUTABLES.has(j.error_code)).length;
    if (count < PAUSE_THRESHOLD) return;
    const { data: acc } = await sb.from('linkedin_accounts').select('status').eq('id', linkedinAccountId).maybeSingle();
    if (!acc || acc.status === 'paused') return;
    await sb.from('linkedin_accounts').update({ status: 'paused' }).eq('id', linkedinAccountId);
    console.log(`[mini-worker] compte #${linkedinAccountId} auto-pausé (${count} échecs en ${PAUSE_WINDOW_MIN} min)`);
  } catch (e) { console.warn('[mini-worker] maybeAutoPauseAccount:', e.message); }
}

async function claimNext(sb, { userId, linkedinAccountId }) {
  const { data: jobs, error } = await sb.from('scrape_jobs').select('*')
    .eq('user_id', userId).eq('linkedin_account_id', linkedinAccountId)
    .eq('status', 'pending').lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true }).limit(1);
  if (error) { console.warn('[mini-worker] claimNext select:', error.message); return null; }
  if (!jobs || !jobs.length) return null;
  const job = jobs[0];
  // D5.3 (07/10/2026, RPC confirmée live avant ce câblage) : revérifie
  // connection_mode=='local' dans la même transaction que la réservation —
  // même RPC que worker.js côté cloud, pour qu'aucun des deux exécutants ne
  // puisse réclamer un job qui ne lui revient pas, même juste après un (dé-)pairing.
  const { data: reserved, error: rErr } = await sb
    .rpc('claim_scrape_job', { p_job_id: job.id, p_executor: 'desktop' });
  if (rErr || !reserved || !reserved.length) return null;
  return reserved[0];
}

async function tick(ctx) {
  const { sb, userId, linkedinAccountId, accessToken, serveurRoot } = ctx;
  const job = await claimNext(sb, { userId, linkedinAccountId });
  if (!job) return null;

  console.log(`[mini-worker] job #${job.id} [${job.type}] réclamé`);

  // Cas spécial (D3.9) : un run de workflow entier, mis en file par le cloud
  // parce que ce compte est local (voir lib/workflow-runner.js::runWorkflow).
  // Exécuté EN PROCESS (pas de spawn) — le step-chaining synchrone de
  // runWorkflow() (currentInput transmis d'étape en étape) a besoin d'un seul
  // appel de fonction, pas d'un job par étape. Ce job de FILE ne porte que le
  // signal "ce run est dû" ; runWorkflow() gère tout seul son propre
  // workflow_runs (créé par elle, pas ici) et sa propre notification d'équipe.
  if (job.type === 'run_workflow') {
    try {
      const { data: wf, error: eWf } = await sb.from('workflows').select('*').eq('id', job.input.workflowId).maybeSingle();
      if (eWf || !wf) throw new Error(eWf ? eWf.message : 'workflow introuvable');
      const { runWorkflow } = require(path.join(serveurRoot, 'lib', 'workflow-runner.js'));
      await runWorkflow(wf);
      await sb.from('scrape_jobs').update({ status: 'done', finished_at: new Date().toISOString() }).eq('id', job.id);
      console.log(`[mini-worker] job #${job.id} [run_workflow] → done (workflow #${wf.id} "${wf.name}")`);
      return { job, ok: true };
    } catch (e) {
      await sb.from('scrape_jobs').update({ status: 'failed', error: String(e.message).slice(0, 2000), finished_at: new Date().toISOString() }).eq('id', job.id);
      console.warn(`[mini-worker] job #${job.id} [run_workflow] → failed : ${e.message}`);
      return { job, ok: false };
    }
  }

  // Cas spécial (Phase A/B HubSpot, 08/10/2026) : un run de workflow pour UN
  // SEUL contact externe, déclenché par un clic HubSpot (hubspot_trigger_workflow).
  // Même philosophie que run_workflow ci-dessus (en process, pas de spawn), mais
  // runWorkflowForContact() gère elle-même son propre workflow_runs (créé par
  // elle) et ne touche jamais la planification du workflow (last_run_at/next_run_at).
  if (job.type === 'run_workflow_for_contact') {
    try {
      const { workflowId, profileUrl, note } = job.input || {};
      const { data: wf, error: eWf } = await sb.from('workflows').select('*').eq('id', workflowId).maybeSingle();
      if (eWf || !wf) throw new Error(eWf ? eWf.message : 'workflow introuvable');
      const { runWorkflowForContact } = require(path.join(serveurRoot, 'lib', 'workflow-runner.js'));
      const resume = await runWorkflowForContact(wf, { profileUrl, note }, { parentJobId: job.id });
      await sb.from('scrape_jobs').update({ status: 'done', output: resume || null, finished_at: new Date().toISOString() }).eq('id', job.id);
      console.log(`[mini-worker] job #${job.id} [run_workflow_for_contact] → done (workflow #${wf.id} "${wf.name}")`);
      return { job, ok: true };
    } catch (e) {
      await sb.from('scrape_jobs').update({ status: 'failed', error: String(e.message).slice(0, 2000), finished_at: new Date().toISOString() }).eq('id', job.id);
      console.warn(`[mini-worker] job #${job.id} [run_workflow_for_contact] → failed : ${e.message}`);
      return { job, ok: false };
    }
  }

  const handler = JOB_HANDLERS[job.type];
  if (!handler) {
    await sb.from('scrape_jobs').update({
      status: 'failed',
      error: `Type non supporté par le mini-worker desktop : ${job.type}`,
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
    return { job, ok: false };
  }

  const { script, args } = handler(job.input || {});
  const timeoutMs = JOB_TIMEOUTS_MS[job.type] || DEFAULT_JOB_TIMEOUT_MS;
  const result = await runScript(serveurRoot, script, args, {
    userId, linkedinAccountId, jobId: job.id, jobInput: job.input,
    accessToken, autoLogin: job.type === 'test_login', timeoutMs,
  });

  const { prefixesPour } = require(path.join(serveurRoot, 'lib', 'job-output-prefix.js'));
  const output = readJobOutput(serveurRoot, job.id, prefixesPour(job.type));
  const combinedLog = ((result.stderr || '') + '\n' + (result.stdout || ''));

  // Port de worker.js:421-452 — panne d'infra (testée AVANT le cookie, même raison).
  const pxMatch = combinedLog.match(/\[(?:PROXY_DOWN|PROXY_MANQUANT|PROXY_INDISPONIBLE|IP_DERIVE)(?::([a-z_]+))?\]/i);
  if (pxMatch) {
    const rejoue = await finaliserEchec(sb, serveurRoot, job, {
      error: "Panne du proxy côté Liberall : le job sera rejoué automatiquement.",
      code: 'proxy_error',
    });
    console.log(`[mini-worker] job #${job.id} → panne proxy (${rejoue ? 'rejoué' : 'failed'})`);
    return { job, ok: false };
  }
  const ckMatch = combinedLog.match(/\[COOKIE_EXPIRED(?::([a-z_]+))?\]/i);
  if (ckMatch || /Refus du login fallback/i.test(combinedLog)) {
    const failState = (ckMatch && ckMatch[1]) || 'logged_out';
    try {
      const { flagCookieExpired } = require(path.join(serveurRoot, 'lib', 'notify-cookie.js'));
      await flagCookieExpired({ accountId: linkedinAccountId, userId, reason: failState });
    } catch (e) { console.warn('[mini-worker] flagCookieExpired:', e.message); }
    await finaliserEchec(sb, serveurRoot, job, { error: 'Cookie LinkedIn expiré, reconnexion requise.', code: 'session_dead' });
    console.log(`[mini-worker] job #${job.id} → cookie_expired (${failState})`);
    return { job, ok: false };
  }

  if (!result.ok) {
    const baseErr = result.timedOut
      ? `Timeout (${Math.round(timeoutMs / 1000)}s dépassé).`
      : (result.stderr || result.error || 'exit code ' + result.code);
    const rejoue = await finaliserEchec(sb, serveurRoot, job, { error: baseErr, code: result.timedOut ? 'timeout' : 'script_error' });
    console.log(`[mini-worker] job #${job.id} → échec script (${rejoue ? 'rejoué' : 'failed'})`);
    if (!rejoue) await maybeAutoPauseAccount(sb, linkedinAccountId, userId);
    return { job, ok: false, result };
  }

  // Port de worker.js:454-471 — exit 0 mais aucune sortie produite = échec silencieux.
  const ACTION_TYPES = new Set(['like', 'comment', 'dm', 'invite', 'visit']);
  if (!output && !ACTION_TYPES.has(job.type)) {
    const rejoue = await finaliserEchec(sb, serveurRoot, job, { error: 'Script terminé (exit 0) sans produire de données.', code: 'no_data' });
    console.log(`[mini-worker] job #${job.id} → sans données (${rejoue ? 'rejoué' : 'failed'})`);
    if (!rejoue) await maybeAutoPauseAccount(sb, linkedinAccountId, userId);
    return { job, ok: false, result };
  }

  // Port de worker.js:473-504 — garde-fou "faux succès" pour les actions vérifiables.
  const { estActionVerifiable, estReussi, motifEchec } = require(path.join(serveurRoot, 'lib', 'action-success.js'));
  if (estActionVerifiable(job.type)) {
    const got = output && output.status;
    if (!estReussi(job.type, got)) {
      const code = codeEchec(got);
      const rejoue = await finaliserEchec(sb, serveurRoot, job, { error: motifEchec(got), code, output: output || null });
      console.log(`[mini-worker] job #${job.id} → ${job.type} non abouti (${got || 'no-output'}) → ${code}`);
      if (!rejoue && !CODES_PLATEFORME.has(code)) await maybeAutoPauseAccount(sb, linkedinAccountId, userId);
      return { job, ok: false, result, output };
    }
  }

  // Succès confirmé : routage CRM + quota + last_success_at — port de worker.js:506-535.
  try {
    if (job.input?.sendToCrm !== false) {
      const postJobRouter = require(path.join(serveurRoot, 'lib', 'post-job-router.js'));
      await postJobRouter.route(job, output);
    }
  } catch (e) { console.warn('[mini-worker] post-job-router:', e.message); }

  await sb.from('scrape_jobs').update({
    status: 'done', output: output || null, error_code: null, error: null,
    finished_at: new Date().toISOString(),
  }).eq('id', job.id);
  try { await sb.from('linkedin_accounts').update({ last_success_at: new Date().toISOString() }).eq('id', linkedinAccountId); } catch (e) {}
  try {
    const { recordAction } = require(path.join(serveurRoot, 'lib', 'rate-limiter.js'));
    await recordAction({ userId, linkedinAccountId, actionType: job.type, source: 'job', refId: job.id });
  } catch (e) { console.warn('[mini-worker] recordAction:', e.message); }

  console.log(`[mini-worker] job #${job.id} → done`);
  return { job, ok: true, output, result };
}

module.exports = { tick };
