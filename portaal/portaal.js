'use strict';

// ============================================================
//  Portaal: inloggen, de tegels met apps, koppelingen,
//  het eigen account en (voor een admin) gebruikersbeheer.
// ============================================================

const ROLE_LABELS = { admin: 'Admin', user: 'Gebruiker' };
const SCOPE_LABELS = {
  global: 'Voor iedereen · beheerd door de admin',
  user: 'Persoonlijk · alleen voor jou',
};

let session = null;
let allModules = [];       // alle modules (alleen bekend bij een admin: die mag alles)
let users = [];
let editingUserId = null;

const Auth = {
  setup(username, password) { return apiSend('POST', 'api/setup', { username, password }); },
  login(username, password) { return apiSend('POST', 'api/login', { username, password }); },
  changePassword(current, password) { return apiSend('POST', 'api/password', { current, password }); },
  listUsers() { return api('api/users'); },
  createUser(user) { return apiSend('POST', 'api/users', user); },
  updateUser(id, changes) { return apiSend('PUT', `api/users/${id}`, changes); },
  deleteUser(id) { return api(`api/users/${id}`, { method: 'DELETE' }); },
};

const Connectors = {
  list() { return api('api/koppelingen'); },
  save(id, values) { return apiSend('PUT', `api/koppelingen/${id}`, { values }); },
  remove(id) { return api(`api/koppelingen/${id}`, { method: 'DELETE' }); },
  test(id) { return apiSend('POST', `api/koppelingen/${id}/test`); },
};

// ---------- Inlogscherm ----------

// mode is 'setup' (eerste admin aanmaken) of 'login'
function showAuthScreen(mode, { legacy = false } = {}) {
  $('#auth-screen').hidden = false;
  const form = $('#form-auth');
  const setup = mode === 'setup';
  form.dataset.mode = mode;
  form.reset();
  $('#auth-title').textContent = setup ? 'Welkom! Maak een admin-account aan' : 'Inloggen';
  $('#auth-intro').textContent = setup
    ? 'Met dit account beheer je de Blom App: je voegt gebruikers toe en stelt koppelingen in.' +
      (legacy ? ' Je bestaande wijnkelder wordt aan dit account gekoppeld.' : '')
    : '';
  $('#auth-intro').hidden = !$('#auth-intro').textContent;
  $('#auth-repeat').hidden = !setup;
  form.elements.repeat.required = setup;
  form.elements.password.autocomplete = setup ? 'new-password' : 'current-password';
  form.querySelector('button[type=submit]').textContent = setup ? 'Account aanmaken' : 'Inloggen';
  $('#auth-error').textContent = '';
  form.elements.username.focus();
}

async function onAuthSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const f = form.elements;
  const setup = form.dataset.mode === 'setup';
  if (setup && f.password.value !== f.repeat.value) {
    $('#auth-error').textContent = 'De twee wachtwoorden zijn niet gelijk.';
    return;
  }
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    if (setup) await Auth.setup(f.username.value, f.password.value);
    else await Auth.login(f.username.value, f.password.value);
    location.reload();
  } catch (err) {
    $('#auth-error').textContent = err.message;
    button.disabled = false;
  }
}

// ---------- Tabs ----------

function showTab(name) {
  $$('#portal-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  if (name === 'koppelingen') loadConnectors();
  if (name === 'gebruikers') loadUsers();
}

// ---------- Start: tegels ----------

function renderTiles() {
  const hour = new Date().getHours();
  const part = hour < 6 ? 'Goedenacht' : hour < 12 ? 'Goedemorgen' : hour < 18 ? 'Goedemiddag' : 'Goedenavond';
  $('#greeting').textContent = `${part}, ${session.user.username}`;
  $('#module-tiles').innerHTML = session.modules.length
    ? session.modules.map(m => `
        <a class="module-tile" href="${esc(blomUrl(m.url))}" style="--tile-color:${esc(m.color || '')}">
          <span class="icon" aria-hidden="true">${esc(m.icon)}</span>
          <strong>${esc(m.name)}</strong>
          <p>${esc(m.description)}</p>
        </a>`).join('')
    : '<p class="muted">Je hebt nog geen apps. Vraag de admin om er een voor je aan te zetten.</p>';
}

// ---------- Koppelingen ----------

async function loadConnectors() {
  try {
    const { connectors } = await Connectors.list();
    renderConnectors(connectors);
  } catch (err) {
    $('#connector-list').innerHTML = `<p class="error">Kon de koppelingen niet ophalen: ${esc(err.message)}</p>`;
  }
}

function connectorField(c, field) {
  const id = `c-${c.id}-${field.name}`;
  const disabled = c.editable ? '' : 'disabled';
  const hint = field.hint ? `<span class="hint">${esc(field.hint)}</span>` : '';
  if (field.type === 'secret') {
    const set = c.secrets_set[field.name];
    return `<label class="span2" for="${id}">${esc(field.label)}${field.required ? ' *' : ''}
      <input id="${id}" name="${esc(field.name)}" type="password" autocomplete="off" ${disabled}
        placeholder="${set ? '•••••••• (ingesteld; leeg laten = niet wijzigen)' : 'nog niet ingesteld'}">
      ${hint}</label>`;
  }
  return `<label class="span2" for="${id}">${esc(field.label)}${field.required ? ' *' : ''}
    <input id="${id}" name="${esc(field.name)}" value="${esc(c.values[field.name] ?? '')}" ${disabled}
      placeholder="${esc(field.default || '')}" autocomplete="off">
    ${hint}</label>`;
}

function renderConnectors(connectors) {
  if (!connectors.length) {
    $('#connector-list').innerHTML = '<p class="muted">Er zijn nog geen koppelingen beschikbaar.</p>';
    return;
  }
  $('#connector-list').innerHTML = connectors.map(c => `
    <form class="card connector" data-connector="${esc(c.id)}">
      <div class="connector-head">
        <h3 class="grow">${esc(c.name)}</h3>
        <span class="badge ${c.configured ? 'good' : ''}">${c.configured ? '✓ Ingesteld' : 'Niet ingesteld'}</span>
      </div>
      <p class="muted small">${esc(c.description)}</p>
      <p class="small used-by"><span class="badge accent">${esc(SCOPE_LABELS[c.scope] || c.scope)}</span>
        ${c.used_by.length ? ` Gebruikt door: ${esc(c.used_by.join(', '))}` : ''}</p>
      <div class="form-grid">${c.fields.map(f => connectorField(c, f)).join('')}</div>
      ${c.editable ? `
        <div class="row">
          <button type="submit" class="primary">Opslaan</button>
          ${c.configured ? `<button type="button" data-connector-action="test">Verbinding testen</button>
            <button type="button" class="danger" data-connector-action="remove">Verwijderen</button>` : ''}
        </div>` : `<p class="muted small">Alleen een admin kan deze koppeling instellen.</p>`}
      <p class="connector-status small" role="status"></p>
    </form>`).join('');
}

function setConnectorStatus(form, message, ok) {
  const el = form.querySelector('.connector-status');
  el.textContent = message;
  el.className = `connector-status small ${ok ? 'ok' : 'error'}`;
}

async function onConnectorSubmit(e) {
  const form = e.target.closest('form[data-connector]');
  if (!form) return;
  e.preventDefault();
  const values = {};
  for (const el of form.elements) if (el.name) values[el.name] = el.value;
  try {
    await Connectors.save(form.dataset.connector, values);
    await loadConnectors();
    const fresh = $(`form[data-connector="${form.dataset.connector}"]`);
    setConnectorStatus(fresh, 'Opgeslagen. Klik op "Verbinding testen" om te controleren of het werkt.', true);
  } catch (err) {
    setConnectorStatus(form, err.message, false);
  }
}

async function onConnectorAction(button) {
  const form = button.closest('form[data-connector]');
  const id = form.dataset.connector;
  if (button.dataset.connectorAction === 'test') {
    setConnectorStatus(form, 'Bezig met testen…', true);
    button.disabled = true;
    try {
      const result = await Connectors.test(id);
      setConnectorStatus(form, result.message, result.ok);
    } catch (err) {
      setConnectorStatus(form, err.message, false);
    } finally {
      button.disabled = false;
    }
  }
  if (button.dataset.connectorAction === 'remove') {
    if (!confirm('Deze koppeling verwijderen? Apps die hem gebruiken, kunnen dat daarna niet meer.')) return;
    try {
      await Connectors.remove(id);
      await loadConnectors();
    } catch (err) {
      setConnectorStatus(form, err.message, false);
    }
  }
}

// ---------- Eigen wachtwoord ----------

async function onPasswordSubmit(e) {
  e.preventDefault();
  const f = e.target.elements;
  $('#password-ok').hidden = true;
  $('#password-error').textContent = '';
  if (f.password.value !== f.repeat.value) {
    $('#password-error').textContent = 'De twee nieuwe wachtwoorden zijn niet gelijk.';
    return;
  }
  try {
    await Auth.changePassword(f.current.value, f.password.value);
    e.target.reset();
    $('#password-ok').hidden = false;
  } catch (err) {
    $('#password-error').textContent = err.message;
  }
}

// ---------- Gebruikers (alleen admin) ----------

async function loadUsers() {
  try {
    users = (await Auth.listUsers()).users;
  } catch (err) {
    $('#user-list').innerHTML = `<p class="error">Kon de gebruikers niet ophalen: ${esc(err.message)}</p>`;
    return;
  }
  renderUsers();
}

function moduleNames(user) {
  if (user.role === 'admin') return 'Alle apps';
  const names = allModules.filter(m => user.modules.includes(m.id)).map(m => `${m.icon} ${m.name}`);
  return names.length ? names.join(', ') : 'Geen';
}

function renderUsers() {
  $('#user-list').innerHTML = `
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Gebruikersnaam</th><th>Rol</th><th>Apps</th><th>Sinds</th><th></th></tr></thead>
      <tbody>${users.map(u => `
        <tr>
          <td>${esc(u.username)}${u.id === session.user.id ? ' <span class="muted small">(jij)</span>' : ''}</td>
          <td>${ROLE_LABELS[u.role] || esc(u.role)}</td>
          <td>${esc(moduleNames(u))}</td>
          <td>${esc(new Date(u.created).toLocaleDateString('nl-NL'))}</td>
          <td class="actions">
            <button data-action="edit-user" data-id="${u.id}">Bewerken</button>
            ${u.id === session.user.id ? '' : `<button class="danger" data-action="delete-user" data-id="${u.id}">Verwijderen</button>`}
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <p class="muted small">Iedere gebruiker heeft eigen gegevens en ziet alleen de apps die hier zijn aangevinkt.
      Een admin mag alle apps gebruiken, beheert gebruikers en stelt de koppelingen voor iedereen in.</p>`;
}

function updateModuleChecks() {
  const isAdmin = $('#form-user').elements.role.value === 'admin';
  $$('#user-module-checks input').forEach(input => { input.disabled = isAdmin; });
  $('#user-modules-admin').hidden = !isAdmin;
}

function openUserForm(user = null) {
  editingUserId = user?.id ?? null;
  const form = $('#form-user');
  const f = form.elements;
  form.reset();
  $('#user-form-title').textContent = user ? `Gebruiker ${user.username} bewerken` : 'Gebruiker toevoegen';
  f.username.value = user?.username ?? '';
  f.username.readOnly = !!user;
  f.role.value = user?.role ?? 'user';
  f.password.required = !user;
  f.password.placeholder = user ? 'leeg laten = niet wijzigen' : 'minstens 8 tekens';
  $('#user-password-label').firstChild.textContent = user ? 'Nieuw wachtwoord' : 'Wachtwoord *';
  const chosen = user ? user.modules : allModules.map(m => m.id);
  $('#user-module-checks').innerHTML = allModules.map(m => `
    <label class="check"><input type="checkbox" value="${esc(m.id)}" ${chosen.includes(m.id) ? 'checked' : ''}>
      ${esc(m.icon)} ${esc(m.name)}</label>`).join('');
  updateModuleChecks();
  $('#user-error').textContent = '';
  $('#dlg-user').showModal();
}

async function onUserSubmit(e) {
  e.preventDefault();
  const f = e.target.elements;
  const modules = $$('#user-module-checks input:checked').map(input => input.value);
  try {
    if (editingUserId) {
      const changes = { role: f.role.value, modules };
      if (f.password.value) changes.password = f.password.value;
      await Auth.updateUser(editingUserId, changes);
      // Jezelf geen admin meer gemaakt? Dan verdwijnt het gebruikersbeheer
      if (editingUserId === session.user.id && f.role.value !== 'admin') return location.reload();
    } else {
      await Auth.createUser({ username: f.username.value, password: f.password.value, role: f.role.value, modules });
    }
    $('#dlg-user').close();
    await loadUsers();
  } catch (err) {
    $('#user-error').textContent = err.message;
  }
}

async function deleteUser(id) {
  const user = users.find(u => u.id === id);
  if (!user) return;
  if (!confirm(`Gebruiker "${user.username}" verwijderen? Deze gebruiker kan daarna niet meer inloggen.\n\n` +
               'De gegevens worden niet gewist, maar op de server apart gezet in de map "verwijderd".')) return;
  try {
    await Auth.deleteUser(id);
    await loadUsers();
  } catch (err) {
    alert(err.message);
  }
}

// ---------- Opstarten ----------

function onDocumentClick(e) {
  const action = e.target.closest('[data-action]');
  if (action) {
    const id = action.dataset.id;
    switch (action.dataset.action) {
      case 'add-user':    openUserForm(); break;
      case 'edit-user':   openUserForm(users.find(u => u.id === id)); break;
      case 'delete-user': deleteUser(id); break;
    }
    return;
  }
  const connectorButton = e.target.closest('[data-connector-action]');
  if (connectorButton) return onConnectorAction(connectorButton);
  if (e.target.matches('[data-close]')) e.target.closest('dialog').close();
}

async function init() {
  document.addEventListener('click', onDocumentClick);
  $$('#portal-tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#form-auth').addEventListener('submit', onAuthSubmit);
  $('#form-password').addEventListener('submit', onPasswordSubmit);
  $('#form-user').addEventListener('submit', onUserSubmit);
  $('#form-user').elements.role.addEventListener('change', updateModuleChecks);
  $('#connector-list').addEventListener('submit', onConnectorSubmit);

  if (!Blom.serverMode) {
    Blom.renderHeader(null, null);
    $('#portal-main').hidden = false;
    $('#tab-start').innerHTML = `<div class="empty-state card"><h2>Open de Blom App via de server</h2>
      <p>Het portaal, inloggen en koppelingen werken alleen via de server (python server.py).
      Wil je snel iets bekijken? Open dan een module direct, bijvoorbeeld
      <a href="../modules/wijnkelder/index.html">de wijnkelder</a>.</p></div>`;
    return;
  }

  try {
    session = await api('api/session');
  } catch (err) {
    Blom.renderHeader(null, null);
    $('#portal-main').hidden = false;
    $('#tab-start').innerHTML = `<div class="empty-state card"><h2>De server is niet bereikbaar</h2>
      <p>${esc(err.message)} Ververs de pagina om het opnieuw te proberen.</p></div>`;
    return;
  }
  Blom.renderHeader(null, session.user ? session : null);
  if (!session.user) return showAuthScreen(session.setup ? 'setup' : 'login', { legacy: session.legacy });

  Blom.session = session;
  const isAdmin = session.user.role === 'admin';
  // Een admin mag alle modules, dus de lijst uit de sessie is dan de volledige lijst
  allModules = isAdmin ? session.modules : [];
  $('#portal-tabs').hidden = false;
  $('#tab-btn-gebruikers').hidden = !isAdmin;
  $('#portal-main').hidden = false;
  $('#account-name').textContent = session.user.username;
  renderTiles();
}

init();
