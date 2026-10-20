function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function detailJob(j) {
  const i = j.input || {};
  return esc(i.profileUrl || i.postUrl || i.companyUrl || i.url || i.keyword || (i.workflowId ? ('workflow #' + i.workflowId) : '') || '');
}

function heure(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function jourCourt(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '');
}

function badge(status) {
  return `<span class="badge badge-${esc(status)}">${esc(status)}</span>`;
}

function rendreTendance(tendance) {
  const max = Math.max(1, ...tendance.map(t => t.n));
  const el = document.getElementById('tendance');
  el.innerHTML = tendance.map(t => {
    const h = Math.round((t.n / max) * 100);
    return `<div class="barre" title="${t.n} job(s) le ${esc(t.jour)}">
      <div class="b" style="height:${Math.max(h, t.n ? 4 : 1)}%"></div>
      <div class="j">${esc(jourCourt(t.jour))}</div>
    </div>`;
  }).join('');
}

async function rafraichir() {
  try {
    const r = await window.statusAPI.getJobs();
    document.getElementById('compte-label').textContent = r.compteLabel || 'Compte —';
    if (!r.kpi) { document.getElementById('refresh').textContent = '⚠ non apparié'; return; }

    document.getElementById('k-workflows').textContent = r.kpi.workflowsActifs;
    document.getElementById('k-pending').textContent = r.kpi.jobsEnAttente;
    document.getElementById('k-done').textContent = r.kpi.jobsRealises10j;
    document.getElementById('l-done').textContent = `Réalisés (${r.fenetreJours}j)`;
    document.getElementById('l-alertes').textContent = `Alertes (${r.fenetreJours}j)`;
    const kAlertes = document.getElementById('k-alertes');
    kAlertes.textContent = r.kpi.alertes10j;
    kAlertes.parentElement.classList.toggle('zero', r.kpi.alertes10j === 0);

    rendreTendance(r.tendance || []);

    const tbPending = document.querySelector('#t-pending tbody');
    document.getElementById('n-pending').textContent = (r.pending || []).length;
    tbPending.innerHTML = (r.pending || []).length
      ? r.pending.map(j => `<tr><td>${esc(j.type)}</td><td class="quand">${heure(j.scheduled_for)}</td><td>${detailJob(j)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="vide">Rien en attente</td></tr>';

    const tbDone = document.querySelector('#t-done tbody');
    tbDone.innerHTML = (r.recents || []).length
      ? r.recents.map(j => `<tr><td>${esc(j.type)}</td><td>${badge(j.status)}</td><td class="quand">${heure(j.finished_at)}</td><td>${detailJob(j)}${j.error ? ' — <span style="color:#e07c7c">' + esc(j.error.slice(0, 80)) + '</span>' : ''}</td></tr>`).join('')
      : '<tr><td colspan="4" class="vide">Rien encore</td></tr>';

    document.getElementById('refresh').textContent = '⟳ ' + new Date().toLocaleTimeString('fr-FR');
  } catch (e) {
    document.getElementById('refresh').textContent = '⚠ ' + e.message;
  }
}

rafraichir();
setInterval(rafraichir, 10000);
