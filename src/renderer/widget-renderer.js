document.getElementById('carte').addEventListener('click', () => window.widgetAPI.openDashboard());
document.getElementById('fermer').addEventListener('click', (e) => {
  e.stopPropagation(); // sinon le clic remonte à #carte et ouvre aussi le tableau de bord
  window.widgetAPI.hide();
});

async function rafraichir() {
  try {
    const r = await window.widgetAPI.getJobs();
    const carte = document.getElementById('carte');
    const badge = document.getElementById('badge');
    const dot = document.getElementById('dot');
    const rowAlertes = document.getElementById('row-alertes');

    if (!r.kpi) {
      document.getElementById('titre').textContent = 'Growth\'Lib — non apparié';
      dot.className = 'dot off';
      document.getElementById('n-pending').textContent = '—';
      document.getElementById('n-alertes').textContent = '—';
      badge.style.display = 'none';
      carte.classList.remove('erreur');
      return;
    }

    document.getElementById('titre').textContent = r.compteLabel || 'Growth\'Lib';
    document.getElementById('n-pending').textContent = r.kpi.jobsEnAttente;
    document.getElementById('n-alertes').textContent = r.kpi.alertes10j;

    const enErreur = r.kpi.alertes10j > 0;
    dot.className = 'dot' + (enErreur ? ' err' : '');
    carte.classList.toggle('erreur', enErreur);
    rowAlertes.classList.toggle('alerte', enErreur);
    badge.style.display = enErreur ? 'block' : 'none';
    badge.textContent = r.kpi.alertes10j > 9 ? '9+' : String(r.kpi.alertes10j);
  } catch (e) {
    document.getElementById('titre').textContent = '⚠ ' + e.message;
  }
}

rafraichir();
setInterval(rafraichir, 10000);
