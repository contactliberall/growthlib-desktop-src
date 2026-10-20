async function seConnecter() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const err = document.getElementById('erreur');
  const btn = document.getElementById('btn-login');
  err.textContent = '';
  if (!email || !password) { err.textContent = 'E-mail et mot de passe requis.'; return; }
  btn.disabled = true;
  try {
    await window.pairingAPI.login(email, password);
    const comptes = await window.pairingAPI.listAccounts();
    if (!comptes.length) { err.textContent = "Aucun compte LinkedIn trouvé pour cet utilisateur."; return; }
    const sel = document.getElementById('compte');
    sel.innerHTML = comptes.map(c => `<option value="${c.id}">${c.label || c.email || ('Compte #' + c.id)}</option>`).join('');
    document.getElementById('etape-login').style.display = 'none';
    document.getElementById('etape-compte').style.display = 'block';
  } catch (e) {
    err.textContent = e.message || String(e);
  } finally {
    btn.disabled = false;
  }
}

async function choisirCompte() {
  const id = document.getElementById('compte').value;
  const btn = document.getElementById('btn-choisir');
  const err = document.getElementById('erreur');
  btn.disabled = true;
  try {
    await window.pairingAPI.selectAccount(Number(id));
    // La fenêtre se ferme côté main process une fois la bascule confirmée.
  } catch (e) {
    err.textContent = e.message || String(e);
    btn.disabled = false;
  }
}
