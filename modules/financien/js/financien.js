'use strict';

// ============================================================
//  Financiën – hoofdlogica
//  Werkwijze (net als de wijnkelder): alle gegevens staan in
//  `data`. Na elke wijziging roep je commit() aan: dat slaat op
//  en tekent alle schermen opnieuw.
//
//  data = {
//    accounts:     [{ id, name, iban, startBalance }]
//    categories:   [{ id, name, kind: 'uit'|'in'|'overboeking', budget }]
//    rules:        [{ id, text, categoryId }]
//    transactions: [{ id, accountId, date, amount, counterparty, counterIban,
//                     description, categoryId, note }]
//  }
//  Een uitgave heeft een negatief bedrag, een inkomst een positief.
// ============================================================

const euro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const MONTH_FORMAT = new Intl.DateTimeFormat('nl-NL', { month: 'long', year: 'numeric' });
const DATE_FORMAT = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' });
const KIND_LABELS = { uit: 'Uitgaven', in: 'Inkomsten', overboeking: 'Eigen overboekingen / sparen' };
const NO_CATEGORY = '__geen';
const MAX_ROWS = 500;            // zoveel transacties tonen we tegelijk

const store = new ModuleStore('financien');
let data = null;
let currentTab = 'overzicht';
let overviewMonth = null;        // 'JJJJ-MM'
let budgetMonth = null;
let editingTxId = null;
let editingAccountId = null;
let editingCategoryId = null;
let editingRuleId = null;
let importState = null;          // { rows, profile, fileName } van het gekozen bankbestand

// ---------- Hulpfuncties ----------

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function today() { return new Date().toISOString().slice(0, 10); }
function num(v) { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function sum(list, fn) { return list.reduce((t, x) => t + (fn(x) || 0), 0); }
function money(n) { return euro.format(n); }
function norm(s) { return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function monthOf(date) { return date.slice(0, 7); }
function monthLabel(m) { const s = MONTH_FORMAT.format(new Date(m + '-01T12:00:00')); return s[0].toUpperCase() + s.slice(1); }
function shortDate(d) { return DATE_FORMAT.format(new Date(d + 'T12:00:00')); }

// Bedrag met teken (+/−) erbij; de kleur is alleen extra
function signed(n) {
  const sign = n > 0.004 ? '+' : n < -0.004 ? '−' : '';
  return `<span class="amount ${n > 0.004 ? 'plus' : ''}">${sign}${money(Math.abs(n))}</span>`;
}

function getCategory(id) { return data.categories.find(c => c.id === id); }
function getAccount(id) { return data.accounts.find(a => a.id === id); }
function getTx(id) { return data.transactions.find(t => t.id === id); }

// Soort van een transactie: die van de categorie, of zonder categorie op basis van het teken
function kindOf(tx) {
  return getCategory(tx.categoryId)?.kind ?? (tx.amount < 0 ? 'uit' : 'in');
}

// Inkomsten en uitgaven (beide positief); eigen overboekingen tellen niet mee
function totals(list) {
  let income = 0;
  let expense = 0;
  for (const tx of list) {
    const kind = kindOf(tx);
    if (kind === 'in') income += tx.amount;
    if (kind === 'uit') expense -= tx.amount;
  }
  return { income, expense, result: income - expense };
}

function inMonth(month) { return data.transactions.filter(t => monthOf(t.date) === month); }

function months() {
  const set = new Set(data.transactions.map(t => monthOf(t.date)));
  set.add(today().slice(0, 7));
  return [...set].sort().reverse();
}

function balance(account) {
  return (account.startBalance || 0) + sum(data.transactions.filter(t => t.accountId === account.id), t => t.amount);
}

// De eerste regel die past, bepaalt de categorie
function ruleCategory(tx) {
  const text = norm(`${tx.counterparty} ${tx.description}`);
  const rule = data.rules.find(r => r.text && getCategory(r.categoryId) && text.includes(norm(r.text)));
  return rule?.categoryId ?? null;
}

function categoryOptions(selected, { empty = '— geen categorie —' } = {}) {
  const groups = Object.entries(KIND_LABELS).map(([kind, label]) => {
    const list = data.categories.filter(c => c.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) return '';
    return `<optgroup label="${esc(label)}">${list.map(c =>
      `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`;
  }).join('');
  return `${empty != null ? `<option value="">${esc(empty)}</option>` : ''}${groups}`;
}

// ---------- Standaardgegevens ----------

function defaultData() {
  const cat = (name, kind, budget = null) => ({ id: uid(), name, kind, budget });
  return {
    accounts: [{ id: uid(), name: 'Betaalrekening', iban: '', startBalance: 0 }],
    categories: [
      cat('Boodschappen', 'uit'), cat('Wonen', 'uit'), cat('Energie en water', 'uit'), cat('Verzekeringen', 'uit'),
      cat('Abonnementen', 'uit'), cat('Vervoer', 'uit'), cat('Uit eten en afhalen', 'uit'), cat('Kleding', 'uit'),
      cat('Gezondheid', 'uit'), cat('Vrije tijd', 'uit'), cat('Cadeaus en giften', 'uit'), cat('Overig', 'uit'),
      cat('Salaris', 'in'), cat('Overige inkomsten', 'in'),
      cat('Sparen en eigen rekeningen', 'overboeking'),
    ],
    rules: [],
    transactions: [],
  };
}

// Zorgt dat ingelezen gegevens (ook uit een back-up) altijd de juiste vorm hebben
function normalize(d) {
  if (!d || !['accounts', 'categories', 'rules', 'transactions'].every(k => Array.isArray(d[k]))) {
    throw new Error('Dit is geen geldig financiën-bestand.');
  }
  return {
    accounts: d.accounts.map(a => ({ id: a.id, name: a.name || 'Rekening', iban: a.iban || '', startBalance: Number(a.startBalance) || 0 })),
    categories: d.categories.map(c => ({ id: c.id, name: c.name || 'Categorie', kind: KIND_LABELS[c.kind] ? c.kind : 'uit', budget: num(c.budget) })),
    rules: d.rules.map(r => ({ id: r.id, text: r.text || '', categoryId: r.categoryId })),
    transactions: d.transactions
      .filter(t => t && typeof t.date === 'string' && Number.isFinite(Number(t.amount)))
      .map(t => ({
        id: t.id, accountId: t.accountId, date: t.date, amount: Number(t.amount),
        counterparty: t.counterparty || '', counterIban: t.counterIban || '', description: t.description || '',
        categoryId: t.categoryId || null, note: t.note || '',
      })),
  };
}

// ---------- Opslaan ----------
// Op de achtergrond, één keer tegelijk; komen er tijdens het opslaan wijzigingen
// bij, dan wordt daarna nog een keer opgeslagen.

let saving = false;
let dirty = false;

function commit() {
  renderAll();
  dirty = true;
  flushSave();
}

async function flushSave() {
  if (saving || !dirty) return;
  saving = true;
  dirty = false;
  try {
    await store.save(data);
    showBanner('');
  } catch (err) {
    if (err instanceof ConflictError) {
      alert('Je gegevens zijn intussen op een ander apparaat gewijzigd. De nieuwste versie wordt geladen; ' +
            'je laatste wijziging is niet bewaard, voer die zo nodig opnieuw in.');
      await reloadData();
    } else if (!(err instanceof AuthError)) {
      dirty = true;
      showBanner(`Opslaan mislukt: ${err.message} Je wijzigingen staan nog alleen op dit scherm; ` +
                 'de app probeert het opnieuw zodra je weer iets wijzigt.');
    }
  } finally {
    saving = false;
    if (dirty && $('#banner').hidden) flushSave();
  }
}

async function reloadData() {
  try {
    const loaded = await store.load();
    data = loaded ? normalize(loaded) : defaultData();
    showBanner('');
  } catch (err) {
    showBanner('Kon de gegevens niet ophalen: ' + err.message);
  }
  renderAll();
}

function showBanner(message) {
  $('#banner').textContent = message;
  $('#banner').hidden = !message;
}

// ---------- Tabs ----------

function showTab(name) {
  currentTab = name;
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
}

// ---------- Overzicht ----------

function tile(label, value, sub, attrs = '') {
  const clickable = attrs.includes('data-action') ? ' clickable" role="button" tabindex="0' : '';
  return `<div class="tile${clickable}" ${attrs}><span class="tile-label">${label}</span><strong>${value}</strong><small>${sub}</small></div>`;
}

function monthSelect(id, selected) {
  return `<select id="${id}" aria-label="Maand">${months().map(m =>
    `<option value="${m}" ${m === selected ? 'selected' : ''}>${esc(monthLabel(m))}</option>`).join('')}</select>`;
}

function renderOverview() {
  const el = $('#tab-overzicht');
  if (!data.transactions.length) {
    el.innerHTML = `
      <div class="empty-state card">
        <h2>Welkom bij je financiën 💶</h2>
        <p>Importeer een bankafschrift om te beginnen, of voeg zelf een transactie toe.
          Wil je eerst rondkijken? Laad dan voorbeelddata.</p>
        <div class="row">
          <button class="primary" data-action="goto-import">Bankafschrift importeren</button>
          <button data-action="add-tx">+ Transactie</button>
          <button data-action="load-sample">Voorbeelddata laden</button>
        </div>
      </div>`;
    return;
  }
  const all = months();
  if (!all.includes(overviewMonth)) overviewMonth = all.find(m => inMonth(m).length) || all[0];
  const list = inMonth(overviewMonth);
  const t = totals(list);
  const total = sum(data.accounts, balance);
  const uncategorized = list.filter(tx => !getCategory(tx.categoryId)).length;

  // Uitgaven per categorie (één reeks, één kleur; het bedrag staat erbij)
  const perCategory = new Map();
  for (const tx of list) {
    if (kindOf(tx) !== 'uit') continue;
    const name = getCategory(tx.categoryId)?.name ?? 'Zonder categorie';
    perCategory.set(name, (perCategory.get(name) || 0) - tx.amount);
  }
  const bars = [...perCategory].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const maxBar = Math.max(...bars.map(([, n]) => n), 1);

  // Laatste 12 maanden
  const last12 = all.slice(0, 12);
  const biggest = list.filter(tx => kindOf(tx) === 'uit' && tx.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, 5);

  el.innerHTML = `
    <div class="toolbar"><h2 class="grow">${esc(monthLabel(overviewMonth))}</h2>${monthSelect('ov-month', overviewMonth)}</div>
    <div class="tiles">
      ${tile('Saldo nu', money(total), `${data.accounts.length} rekening(en)`)}
      ${tile('Inkomsten', signed(t.income), 'deze maand')}
      ${tile('Uitgaven', signed(-t.expense), 'deze maand')}
      ${tile('Over', signed(t.result), t.result >= 0 ? 'inkomsten min uitgaven' : 'meer uitgegeven dan binnengekomen')}
      ${tile('Zonder categorie', uncategorized, uncategorized ? 'klik om in te delen' : 'alles is ingedeeld',
             uncategorized ? 'data-action="show-uncategorized"' : '')}
    </div>
    <div class="cards">
      <div class="card">
        <h3>Uitgaven per categorie</h3>
        ${bars.length ? bars.map(([name, n]) => `
          <div class="bar-row" title="${esc(name)}: ${esc(money(n))} (${Math.round(n / t.expense * 100) || 0}% van de uitgaven)">
            <span class="bar-label">${esc(name)}</span>
            <div class="bar-track"><div class="bar" style="width:${(n / maxBar) * 100}%"></div></div>
            <span class="bar-val">${esc(money(n))}</span>
          </div>`).join('') : '<p class="muted">Geen uitgaven deze maand.</p>'}
      </div>
      <div class="card">
        <h3>Grootste uitgaven</h3>
        ${biggest.length ? `<ul class="mini">${biggest.map(tx => `
          <li class="clickable" data-tx="${tx.id}">
            <span class="grow">${esc(tx.counterparty || tx.description || '–')}<small>${esc(shortDate(tx.date))} · ${esc(getCategory(tx.categoryId)?.name ?? 'zonder categorie')}</small></span>
            <strong>${signed(tx.amount)}</strong>
          </li>`).join('')}</ul>` : '<p class="muted">Geen uitgaven deze maand.</p>'}
      </div>
      <div class="card">
        <h3>Per rekening</h3>
        <ul class="mini">${data.accounts.map(a => `
          <li><span class="grow">${esc(a.name)}<small>${esc(a.iban)}</small></span><strong>${money(balance(a))}</strong></li>`).join('')}</ul>
      </div>
    </div>
    <h3 class="section-title">Per maand</h3>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Maand</th><th class="num">Inkomsten</th><th class="num">Uitgaven</th><th class="num">Over</th></tr></thead>
      <tbody>${last12.map(m => { const x = totals(inMonth(m)); return `
        <tr class="clickable" data-month="${m}"><td>${esc(monthLabel(m))}</td><td class="num">${signed(x.income)}</td>
          <td class="num">${signed(-x.expense)}</td><td class="num">${signed(x.result)}</td></tr>`; }).join('')}
      </tbody>
    </table></div>`;
}

// ---------- Transacties ----------

function renderFilterOptions() {
  const keep = sel => $(sel).value;
  const month = keep('#tx-month');
  const account = keep('#tx-account');
  const category = keep('#tx-category');
  $('#tx-month').innerHTML = `<option value="">Alle maanden</option>` +
    months().map(m => `<option value="${m}">${esc(monthLabel(m))}</option>`).join('');
  $('#tx-account').innerHTML = `<option value="">Alle rekeningen</option>` +
    data.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  $('#tx-category').innerHTML = `<option value="">Alle categorieën</option><option value="${NO_CATEGORY}">Zonder categorie</option>` +
    categoryOptions(null, { empty: null });
  $('#tx-month').value = month;
  $('#tx-account').value = account;
  $('#tx-category').value = category;
  for (const sel of ['#tx-month', '#tx-account', '#tx-category']) if ($(sel).selectedIndex < 0) $(sel).value = '';
}

function filteredTransactions() {
  const q = norm($('#tx-search').value.trim());
  const month = $('#tx-month').value;
  const account = $('#tx-account').value;
  const category = $('#tx-category').value;
  return data.transactions
    .filter(t => !month || monthOf(t.date) === month)
    .filter(t => !account || t.accountId === account)
    .filter(t => !category || (category === NO_CATEGORY ? !getCategory(t.categoryId) : t.categoryId === category))
    .filter(t => !q || norm(`${t.counterparty} ${t.description} ${t.note} ${t.amount.toFixed(2).replace('.', ',')}`).includes(q))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

function renderTransactions() {
  const list = filteredTransactions();
  $('#tx-summary').innerHTML = list.length
    ? `${list.length} transactie(s) · samen ${signed(sum(list, t => t.amount))}` +
      (list.length > MAX_ROWS ? ` · de eerste ${MAX_ROWS} worden getoond, verfijn het filter voor de rest` : '')
    : '';
  if (!list.length) {
    $('#tx-list').innerHTML = `<p class="muted">${data.transactions.length ? 'Geen transacties gevonden.' : 'Nog geen transacties. Importeer een bankafschrift of klik op “+ Transactie”.'}</p>`;
    return;
  }
  const multipleAccounts = data.accounts.length > 1;
  $('#tx-list').innerHTML = `
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Datum</th><th>Naam en omschrijving</th>${multipleAccounts ? '<th>Rekening</th>' : ''}<th>Categorie</th><th class="num">Bedrag</th></tr></thead>
      <tbody>${list.slice(0, MAX_ROWS).map(t => `
        <tr data-tx="${t.id}">
          <td class="num">${esc(shortDate(t.date))}<small>${t.date.slice(0, 4)}</small></td>
          <td><span class="tx-name">${esc(t.counterparty || '–')}</span>
            <span class="tx-desc" title="${esc(t.description)}">${esc(t.note || t.description)}</span></td>
          ${multipleAccounts ? `<td>${esc(getAccount(t.accountId)?.name ?? '?')}</td>` : ''}
          <td><select data-tx-cat="${t.id}" aria-label="Categorie" class="${getCategory(t.categoryId) ? '' : 'no-category'}">
            ${categoryOptions(t.categoryId, { empty: '— kies —' })}</select></td>
          <td class="num">${signed(t.amount)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

function openTxForm(tx = null) {
  editingTxId = tx?.id ?? null;
  const form = $('#form-tx');
  const f = form.elements;
  form.reset();
  $('#tx-form-title').textContent = tx ? 'Transactie bewerken' : 'Transactie toevoegen';
  f.accountId.innerHTML = data.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  f.categoryId.innerHTML = categoryOptions(tx?.categoryId ?? null);
  f.date.value = tx?.date ?? today();
  f.amount.value = tx?.amount ?? '';
  f.counterparty.value = tx?.counterparty ?? '';
  f.description.value = tx?.description ?? '';
  f.accountId.value = tx?.accountId ?? data.accounts[0]?.id ?? '';
  f.categoryId.value = tx?.categoryId ?? '';
  f.note.value = tx?.note ?? '';
  $('#btn-delete-tx').hidden = !tx;
  updateRememberText();
  $('#dlg-tx').showModal();
}

function updateRememberText() {
  const name = $('#form-tx').elements.counterparty.value.trim();
  $('#tx-remember-label').hidden = !name;
  $('#tx-remember-text').textContent = `Onthoud dit: “${name}” voortaan altijd in deze categorie`;
}

function onTxSubmit(e) {
  e.preventDefault();
  const f = e.target.elements;
  if (!data.accounts.length) return alert('Maak eerst een rekening aan (Instellingen).');
  const values = {
    date: f.date.value, amount: Math.round(num(f.amount.value) * 100) / 100,
    counterparty: f.counterparty.value.trim(), description: f.description.value.trim(),
    accountId: f.accountId.value, categoryId: f.categoryId.value || null, note: f.note.value.trim(),
  };
  if (editingTxId) Object.assign(getTx(editingTxId), values);
  else data.transactions.push({ id: uid(), counterIban: '', ...values });
  if (f.remember.checked && values.counterparty && values.categoryId) rememberRule(values.counterparty, values.categoryId);
  $('#dlg-tx').close();
  commit();
}

// Maakt (of wijzigt) een regel "naam → categorie" en past die toe op transacties zonder categorie
function rememberRule(text, categoryId) {
  const existing = data.rules.find(r => norm(r.text) === norm(text));
  if (existing) existing.categoryId = categoryId;
  else data.rules.push({ id: uid(), text, categoryId });
  applyRules();
}

function applyRules() {
  let count = 0;
  for (const tx of data.transactions) {
    if (getCategory(tx.categoryId)) continue;
    const found = ruleCategory(tx);
    if (found) { tx.categoryId = found; count++; }
  }
  return count;
}

function deleteTx() {
  if (!confirm('Deze transactie verwijderen?')) return;
  data.transactions = data.transactions.filter(t => t.id !== editingTxId);
  $('#dlg-tx').close();
  commit();
}

// ---------- Budget ----------

function renderBudget() {
  const all = months();
  if (!all.includes(budgetMonth)) budgetMonth = all[0];
  $('#budget-month').innerHTML = all.map(m => `<option value="${m}">${esc(monthLabel(m))}</option>`).join('');
  $('#budget-month').value = budgetMonth;

  const list = inMonth(budgetMonth);
  // "|| 0" voorkomt "-0,00" als er niets is uitgegeven
  const spentOn = c => -sum(list.filter(t => t.categoryId === c.id), t => t.amount) || 0;
  const withBudget = data.categories.filter(c => c.kind === 'uit' && c.budget > 0);
  const withoutBudget = data.categories
    .filter(c => c.kind === 'uit' && !(c.budget > 0))
    .map(c => ({ c, spent: spentOn(c) }))
    .filter(x => x.spent > 0.004)
    .sort((a, b) => b.spent - a.spent);

  if (!withBudget.length) {
    $('#budget-view').innerHTML = `<div class="empty-state card"><h2>Nog geen budgetten</h2>
      <p>Geef categorieën een budget per maand onder Instellingen → Categorieën en budgetten.
        Hier zie je dan hoeveel je er nog van over hebt.</p>
      <div class="row"><button class="primary" data-action="goto-settings">Naar Instellingen</button></div></div>`;
    return;
  }

  const totalBudget = sum(withBudget, c => c.budget);
  const totalSpent = sum(withBudget, spentOn);
  $('#budget-view').innerHTML = `
    <div class="tiles">
      ${tile('Budget', money(totalBudget), `${withBudget.length} categorieën`)}
      ${tile('Uitgegeven', money(totalSpent), `${Math.round(totalSpent / totalBudget * 100)}% van het budget`)}
      ${tile(totalSpent > totalBudget ? 'Over budget' : 'Nog te besteden', money(Math.abs(totalBudget - totalSpent)),
             totalSpent > totalBudget ? '<span class="over-label">⚠ meer uitgegeven dan gepland</span>' : 'binnen je budget')}
    </div>
    <div class="card">
      ${withBudget.map(c => {
        const spent = spentOn(c);
        const over = spent > c.budget;
        return `
        <div class="budget-row" title="${esc(c.name)}: ${esc(money(spent))} van ${esc(money(c.budget))}">
          <span class="budget-name">${esc(c.name)}</span>
          <div class="budget-track"><div class="budget-fill ${over ? 'over' : ''}" style="width:${Math.min(100, Math.max(0, spent / c.budget * 100))}%"></div></div>
          <span class="budget-nums">${esc(money(spent))} van ${esc(money(c.budget))}
            <small>${over ? `<span class="over-label">⚠ ${esc(money(spent - c.budget))} over budget</span>` : `nog ${esc(money(c.budget - spent))}`}</small></span>
        </div>`;
      }).join('')}
    </div>
    ${withoutBudget.length ? `
      <h3 class="section-title">Uitgaven zonder budget</h3>
      <div class="card"><ul class="mini">${withoutBudget.map(x => `
        <li><span class="grow">${esc(x.c.name)}</span><strong>${esc(money(x.spent))}</strong></li>`).join('')}</ul></div>` : ''}`;
}

// ---------- Importeren ----------

function renderImportAccounts() {
  const sel = $('#import-account');
  const keep = sel.value;
  sel.innerHTML = data.accounts.map(a => `<option value="${a.id}">${esc(a.name)}${a.iban ? ` (${esc(a.iban)})` : ''}</option>`).join('');
  if (keep && getAccount(keep)) sel.value = keep;
}

async function onImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = BankImport.decode(await file.arrayBuffer());
    const rows = BankImport.parseCsv(text, BankImport.detectDelimiter(text));
    if (!rows.length) throw new Error('Het bestand is leeg.');
    importState = { rows, profile: BankImport.detect(rows), fileName: file.name };
    // Herkent de app de rekening aan het IBAN in het bestand? Dan die alvast kiezen.
    const ibanInFile = text.match(/[A-Z]{2}\d{2}[A-Z]{4}\d{10}/)?.[0];
    const account = ibanInFile && data.accounts.find(a => a.iban.replace(/\s/g, '') === ibanInFile);
    if (account) $('#import-account').value = account.id;
  } catch (err) {
    importState = null;
    alert('Dit bestand kon niet worden gelezen: ' + err.message);
  }
  renderImport();
}

function columnLabel(i) {
  const { rows, profile } = importState;
  return profile.hasHeader ? (rows[0][i] || `Kolom ${i + 1}`) : `Kolom ${i + 1}: ${(rows[0][i] || '').slice(0, 30)}`;
}

function columnSelect(field, label, optional) {
  const { rows, profile } = importState;
  const count = Math.max(...rows.slice(0, 5).map(r => r.length));
  const current = profile.map[field];
  return `<label>${label}<select data-map="${field}">
    ${optional ? `<option value="-1">— niet aanwezig —</option>` : ''}
    ${Array.from({ length: count }, (_, i) => `<option value="${i}" ${i === current ? 'selected' : ''}>${esc(columnLabel(i))}</option>`).join('')}
  </select></label>`;
}

function renderImport() {
  if (!importState) {
    $('#import-mapping').innerHTML = '';
    $('#import-preview').innerHTML = '';
    return;
  }
  const { rows, profile, fileName } = importState;
  const count = Math.max(...rows.slice(0, 5).map(r => r.length));
  $('#import-mapping').innerHTML = `
    <div class="card import-card">
      <h3>${esc(fileName)}</h3>
      <p class="small">${profile.bank ? `✓ Herkend als <strong>${esc(profile.bank)}</strong>. Controleer de voorbeeldregels hieronder.`
        : 'Deze bank herkent de app niet. Kies hieronder welke kolom wat is; de voorbeeldregels laten zien of het klopt.'}</p>
      <details ${profile.bank ? '' : 'open'}>
        <summary class="small">Kolommen aanpassen</summary>
        <label class="check small"><input type="checkbox" id="map-header" ${profile.hasHeader ? 'checked' : ''}> De eerste regel bevat de kolomnamen</label>
        <div class="mapping-grid">
          ${columnSelect('date', 'Datum *', false)}
          ${columnSelect('amount', 'Bedrag *', false)}
          ${columnSelect('sign', 'Af / Bij (als het bedrag geen teken heeft)', true)}
          ${columnSelect('counterparty', 'Naam tegenpartij', true)}
          ${columnSelect('counterIban', 'Rekening tegenpartij', true)}
        </div>
        <p class="small muted">Omschrijving (één of meer kolommen):</p>
        <div class="desc-columns">${Array.from({ length: count }, (_, i) => `
          <label class="check"><input type="checkbox" data-desc="${i}" ${profile.map.description.includes(i) ? 'checked' : ''}> ${esc(columnLabel(i))}</label>`).join('')}
        </div>
      </details>
    </div>`;
  renderImportPreview();
}

function importCandidates() {
  const accountId = $('#import-account').value;
  const txs = BankImport.toTransactions(importState.rows, importState.profile);
  return BankImport.markDuplicates(txs, data.transactions, accountId);
}

function renderImportPreview() {
  if (!data.accounts.length) {
    $('#import-preview').innerHTML = '<p class="error">Maak eerst een rekening aan onder Instellingen.</p>';
    return;
  }
  const txs = importCandidates();
  const fresh = txs.filter(t => !t.error && !t.duplicate);
  const dupes = txs.filter(t => t.duplicate);
  const errors = txs.filter(t => t.error);
  const sorted = txs.slice().sort((a, b) => !!a.error - !!b.error || (b.date || '').localeCompare(a.date || ''));
  $('#import-preview').innerHTML = `
    <div class="import-stats">
      <span class="badge good">${fresh.length} nieuw</span>
      <span class="badge">${dupes.length} al aanwezig (worden overgeslagen)</span>
      ${errors.length ? `<span class="badge over-label">${errors.length} niet te lezen</span>` : ''}
    </div>
    ${errors.length ? `<p class="error small">${esc(errors.slice(0, 3).map(t => t.error).join(' · '))}${errors.length > 3 ? ' …' : ''}</p>` : ''}
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Datum</th><th>Naam</th><th>Omschrijving</th><th>Wordt</th><th class="num">Bedrag</th></tr></thead>
      <tbody>${sorted.slice(0, 15).map(t => `
        <tr class="${t.duplicate ? 'is-duplicate' : ''} ${t.error ? 'is-error' : ''}">
          <td>${esc(t.date || '?')}</td>
          <td>${esc(t.counterparty || '–')}</td>
          <td><span class="tx-desc" title="${esc(t.description)}">${esc(t.description || '–')}</span></td>
          <td>${t.error ? 'fout' : t.duplicate ? 'overgeslagen' : esc(getCategory(ruleCategory(t))?.name ?? 'zonder categorie')}</td>
          <td class="num">${t.amount == null ? '?' : signed(t.amount)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    ${txs.length > 15 ? `<p class="muted small">De eerste 15 van ${txs.length} regels.</p>` : ''}
    <div class="row">
      <button class="primary" data-action="do-import" ${fresh.length ? '' : 'disabled'}>${fresh.length} transactie(s) importeren</button>
      <button data-action="cancel-import">Annuleren</button>
    </div>`;
}

function onMappingChange(e) {
  if (!importState) return;
  const map = importState.profile.map;
  if (e.target.id === 'map-header') importState.profile.hasHeader = e.target.checked;
  if (e.target.dataset.map) map[e.target.dataset.map] = Number(e.target.value);
  if (e.target.dataset.desc) {
    const i = Number(e.target.dataset.desc);
    map.description = e.target.checked ? [...map.description, i].sort((a, b) => a - b) : map.description.filter(x => x !== i);
  }
  // Kopregel aan/uit verandert de namen in de keuzelijsten
  if (e.target.id === 'map-header') renderImport();
  else renderImportPreview();
}

function doImport() {
  const accountId = $('#import-account').value;
  const fresh = importCandidates().filter(t => !t.error && !t.duplicate);
  let categorized = 0;
  for (const t of fresh) {
    const categoryId = ruleCategory(t);
    if (categoryId) categorized++;
    data.transactions.push({
      id: uid(), accountId, date: t.date, amount: t.amount, counterparty: t.counterparty,
      counterIban: t.counterIban, description: t.description, categoryId, note: '',
    });
  }
  importState = null;
  $('#import-file').value = '';
  commit();
  $('#import-preview').innerHTML = `
    <div class="card">
      <p class="ok"><strong>✓ ${fresh.length} transactie(s) geïmporteerd.</strong> ${categorized} automatisch ingedeeld met je regels,
        ${fresh.length - categorized} nog zonder categorie.</p>
      <p class="small muted">Tip: deel een transactie in en vink “Onthoud dit” aan; dan gaat het de volgende keer vanzelf.</p>
      <div class="row">${fresh.length - categorized ? '<button class="primary" data-action="show-uncategorized-all">Transacties indelen</button>' : ''}
        <button data-action="goto-overview">Naar het overzicht</button></div>
    </div>`;
}

// ---------- Instellingen ----------

function renderSettings() {
  $('#account-list').innerHTML = data.accounts.length ? `<ul class="list-plain">${data.accounts.map(a => `
    <li data-edit-account="${a.id}"><span class="grow">${esc(a.name)}<small>${esc(a.iban || 'geen IBAN')}</small></span>
      <strong>${money(balance(a))}</strong></li>`).join('')}</ul>` : '<p class="muted">Nog geen rekeningen.</p>';

  $('#rule-list').innerHTML = data.rules.length ? `<ul class="list-plain">${data.rules.map(r => `
    <li data-edit-rule="${r.id}"><span class="grow">bevat “${esc(r.text)}”</span>
      <span class="badge accent">${esc(getCategory(r.categoryId)?.name ?? '(categorie verwijderd)')}</span></li>`).join('')}</ul>`
    : '<p class="muted small">Nog geen regels.</p>';

  const thisMonth = inMonth(today().slice(0, 7));
  $('#category-list').innerHTML = `
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Naam</th><th>Soort</th><th class="num">Budget per maand</th><th class="num">Deze maand</th></tr></thead>
      <tbody>${Object.keys(KIND_LABELS).flatMap(kind => data.categories.filter(c => c.kind === kind)
        .sort((a, b) => a.name.localeCompare(b.name)).map(c => `
        <tr class="clickable" data-edit-category="${c.id}">
          <td>${esc(c.name)}</td><td>${esc(KIND_LABELS[c.kind])}</td>
          <td class="num">${c.budget > 0 ? money(c.budget) : '–'}</td>
          <td class="num">${signed(sum(thisMonth.filter(t => t.categoryId === c.id), t => t.amount))}</td>
        </tr>`)).join('')}
      </tbody>
    </table></div>`;
}

function openAccountForm(account = null) {
  editingAccountId = account?.id ?? null;
  const f = $('#form-account').elements;
  $('#form-account').reset();
  $('#account-form-title').textContent = account ? 'Rekening bewerken' : 'Rekening toevoegen';
  f.name.value = account?.name ?? '';
  f.iban.value = account?.iban ?? '';
  f.startBalance.value = account?.startBalance ?? 0;
  $('#btn-delete-account').hidden = !account;
  $('#dlg-account').showModal();
}

function onAccountSubmit(e) {
  e.preventDefault();
  const f = e.target.elements;
  const values = { name: f.name.value.trim(), iban: f.iban.value.replace(/\s/g, '').toUpperCase(), startBalance: num(f.startBalance.value) || 0 };
  if (editingAccountId) Object.assign(getAccount(editingAccountId), values);
  else data.accounts.push({ id: uid(), ...values });
  $('#dlg-account').close();
  commit();
}

function deleteAccount() {
  if (data.accounts.length === 1) return alert('Je hebt minstens één rekening nodig.');
  const account = getAccount(editingAccountId);
  const count = data.transactions.filter(t => t.accountId === account.id).length;
  if (!confirm(`Rekening “${account.name}” verwijderen?` + (count ? ` De ${count} transactie(s) van deze rekening worden ook verwijderd.` : ''))) return;
  data.transactions = data.transactions.filter(t => t.accountId !== account.id);
  data.accounts = data.accounts.filter(a => a !== account);
  $('#dlg-account').close();
  commit();
}

function openCategoryForm(category = null) {
  editingCategoryId = category?.id ?? null;
  const f = $('#form-category').elements;
  $('#form-category').reset();
  $('#category-form-title').textContent = category ? 'Categorie bewerken' : 'Categorie toevoegen';
  f.name.value = category?.name ?? '';
  f.kind.value = category?.kind ?? 'uit';
  f.budget.value = category?.budget ?? '';
  $('#btn-delete-category').hidden = !category;
  $('#dlg-category').showModal();
}

function onCategorySubmit(e) {
  e.preventDefault();
  const f = e.target.elements;
  const values = { name: f.name.value.trim(), kind: f.kind.value, budget: num(f.budget.value) };
  if (editingCategoryId) Object.assign(getCategory(editingCategoryId), values);
  else data.categories.push({ id: uid(), ...values });
  $('#dlg-category').close();
  commit();
}

function deleteCategory() {
  const category = getCategory(editingCategoryId);
  const count = data.transactions.filter(t => t.categoryId === category.id).length;
  if (!confirm(`Categorie “${category.name}” verwijderen?` +
               (count ? ` ${count} transactie(s) staan daarna zonder categorie.` : '') +
               ' Regels voor deze categorie worden ook verwijderd.')) return;
  data.transactions.forEach(t => { if (t.categoryId === category.id) t.categoryId = null; });
  data.rules = data.rules.filter(r => r.categoryId !== category.id);
  data.categories = data.categories.filter(c => c !== category);
  $('#dlg-category').close();
  commit();
}

function openRuleForm(rule = null) {
  if (!data.categories.length) return alert('Maak eerst een categorie aan.');
  editingRuleId = rule?.id ?? null;
  const f = $('#form-rule').elements;
  $('#form-rule').reset();
  $('#rule-form-title').textContent = rule ? 'Regel bewerken' : 'Regel toevoegen';
  f.categoryId.innerHTML = categoryOptions(rule?.categoryId ?? null, { empty: null });
  f.text.value = rule?.text ?? '';
  if (rule) f.categoryId.value = rule.categoryId;
  $('#btn-delete-rule').hidden = !rule;
  $('#dlg-rule').showModal();
}

function onRuleSubmit(e) {
  e.preventDefault();
  const f = e.target.elements;
  const values = { text: f.text.value.trim(), categoryId: f.categoryId.value };
  if (editingRuleId) Object.assign(data.rules.find(r => r.id === editingRuleId), values);
  else data.rules.push({ id: uid(), ...values });
  $('#dlg-rule').close();
  const count = applyRules();
  commit();
  if (count) alert(`${count} transactie(s) zonder categorie zijn met deze regel ingedeeld.`);
}

function deleteRule() {
  if (!confirm('Deze regel verwijderen? Transacties die al zijn ingedeeld, blijven zoals ze zijn.')) return;
  data.rules = data.rules.filter(r => r.id !== editingRuleId);
  $('#dlg-rule').close();
  commit();
}

// ---------- Back-up en voorbeelddata ----------

function exportData() {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `financien-backup-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importBackup(file) {
  try {
    const imported = normalize(JSON.parse(await file.text()));
    if (!confirm(`Back-up met ${imported.transactions.length} transacties terugzetten? Je huidige gegevens worden vervangen.`)) return;
    data = imported;
    commit();
  } catch (err) {
    alert('Dit bestand kon niet worden ingelezen: ' + err.message);
  }
}

function clearAll() {
  if (!confirm('Weet je zeker dat je ALLE financiële gegevens wilt wissen? Maak eerst een back-up!')) return;
  data = defaultData();
  commit();
}

// Drie maanden verzonnen transacties om de module uit te proberen
function loadSample() {
  if (data.transactions.length && !confirm('Je huidige gegevens worden vervangen door voorbeelddata. Doorgaan?')) return;
  const d = defaultData();
  const cat = name => d.categories.find(c => c.name === name).id;
  const pay = d.accounts[0];
  pay.name = 'Betaalrekening';
  pay.startBalance = 1850;
  Object.assign(d.categories.find(c => c.name === 'Boodschappen'), { budget: 450 });
  Object.assign(d.categories.find(c => c.name === 'Uit eten en afhalen'), { budget: 150 });
  Object.assign(d.categories.find(c => c.name === 'Vrije tijd'), { budget: 100 });
  Object.assign(d.categories.find(c => c.name === 'Kleding'), { budget: 75 });
  d.rules = [
    ['werkgever bv', 'Salaris'], ['albert heijn', 'Boodschappen'], ['jumbo', 'Boodschappen'],
    ['woonstichting', 'Wonen'], ['vattenfall', 'Energie en water'], ['zilveren kruis', 'Verzekeringen'],
    ['netflix', 'Abonnementen'], ['spotify', 'Abonnementen'], ['shell', 'Vervoer'], ['ns groep', 'Vervoer'],
    ['thuisbezorgd', 'Uit eten en afhalen'], ['spaarrekening', 'Sparen en eigen rekeningen'],
  ].map(([text, name]) => ({ id: uid(), text, categoryId: cat(name) }));

  // Vaste "willekeur", zodat de voorbeelddata elke keer hetzelfde is
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const now = new Date();
  const txs = [];
  const add = (date, amount, counterparty, description) =>
    txs.push({ id: uid(), accountId: pay.id, date, amount: Math.round(amount * 100) / 100, counterparty, counterIban: '', description, categoryId: null, note: '' });
  for (let back = 2; back >= 0; back--) {
    const y = now.getFullYear();
    const m = now.getMonth() - back;
    const day = n => {
      const date = new Date(Date.UTC(y, m, n));
      return date.toISOString().slice(0, 10);
    };
    const lastDay = back === 0 ? now.getDate() : 28;
    const when = n => (n <= lastDay ? day(n) : null);
    const maybe = (n, ...args) => { const date = when(n); if (date) add(date, ...args); };
    maybe(1, -1150, 'Woonstichting De Linde', 'Huur woning');
    maybe(2, -300, 'Spaarrekening', 'Maandelijks sparen');
    maybe(3, -145, 'Vattenfall', 'Termijnbedrag energie');
    maybe(5, -128.45, 'Zilveren Kruis', 'Zorgverzekering');
    maybe(8, -13.99, 'Netflix', 'Abonnement');
    maybe(12, -10.99, 'Spotify', 'Premium');
    for (let week = 0; week < 4; week++) {
      maybe(4 + week * 7, -(55 + rnd() * 60), 'Albert Heijn 1234', 'Betaalpas');
      if (rnd() > 0.4) maybe(6 + week * 7, -(20 + rnd() * 30), 'Jumbo', 'Betaalpas');
    }
    maybe(14, -(60 + rnd() * 20), 'Shell Utrecht', 'Tanken');
    maybe(16, -(25 + rnd() * 30), 'Thuisbezorgd.nl', 'Bestelling');
    maybe(19, -(22 + rnd() * 10), 'NS Groep', 'Treinreis');
    maybe(21, -(30 + rnd() * 60), 'Bol.com', 'Bestelling');
    maybe(25, 2850, 'Werkgever BV', 'Salaris');
  }
  d.transactions = txs;
  data = d;
  applyRules();
  commit();
  showTab('overzicht');
}

// ---------- Alles tekenen ----------

function renderAll() {
  renderOverview();
  renderFilterOptions();
  renderTransactions();
  renderBudget();
  renderImportAccounts();
  if (importState) renderImportPreview();
  renderSettings();
}

function showUncategorized(month) {
  $('#tx-search').value = '';
  $('#tx-month').value = month || '';
  $('#tx-account').value = '';
  $('#tx-category').value = NO_CATEGORY;
  renderTransactions();
  showTab('transacties');
}

// Eén centrale klik-afhandeling
function onDocumentClick(e) {
  const action = e.target.closest('[data-action]');
  if (action) {
    switch (action.dataset.action) {
      case 'add-tx':           return openTxForm();
      case 'add-account':      return openAccountForm();
      case 'add-category':     return openCategoryForm();
      case 'add-rule':         return openRuleForm();
      case 'apply-rules': {
        const count = applyRules();
        if (count) commit();
        return alert(count ? `${count} transactie(s) ingedeeld.` : 'Er waren geen transacties die met een regel konden worden ingedeeld.');
      }
      case 'goto-import':      return showTab('importeren');
      case 'goto-settings':    return showTab('instellingen');
      case 'goto-overview':    return showTab('overzicht');
      case 'show-uncategorized':     return showUncategorized(overviewMonth);
      case 'show-uncategorized-all': return showUncategorized('');
      case 'do-import':        return doImport();
      case 'cancel-import':    importState = null; $('#import-file').value = ''; return renderImport();
      case 'export':           return exportData();
      case 'import-backup':    return $('#backup-file').click();
      case 'load-sample':      return loadSample();
      case 'clear-all':        return clearAll();
    }
    return;
  }
  if (e.target.closest('select')) return;   // een keuzelijst in een rij opent geen venster
  const tx = e.target.closest('[data-tx]');
  if (tx) return openTxForm(getTx(tx.dataset.tx));
  const month = e.target.closest('[data-month]');
  if (month) { overviewMonth = month.dataset.month; renderOverview(); window.scrollTo(0, 0); return; }
  const account = e.target.closest('[data-edit-account]');
  if (account) return openAccountForm(getAccount(account.dataset.editAccount));
  const category = e.target.closest('[data-edit-category]');
  if (category) return openCategoryForm(getCategory(category.dataset.editCategory));
  const rule = e.target.closest('[data-edit-rule]');
  if (rule) return openRuleForm(data.rules.find(r => r.id === rule.dataset.editRule));
  if (e.target.matches('[data-close]')) e.target.closest('dialog').close();
}

function onDocumentChange(e) {
  if (e.target.id === 'ov-month') { overviewMonth = e.target.value; renderOverview(); return; }
  if (e.target.id === 'budget-month') { budgetMonth = e.target.value; renderBudget(); return; }
  if (e.target.dataset.txCat) {
    const tx = getTx(e.target.dataset.txCat);
    tx.categoryId = e.target.value || null;
    commit();
  }
}

async function init() {
  $$('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('change', onDocumentChange);
  ['#tx-search', '#tx-month', '#tx-account', '#tx-category'].forEach(sel => $(sel).addEventListener('input', renderTransactions));
  $('#form-tx').addEventListener('submit', onTxSubmit);
  $('#form-tx').elements.counterparty.addEventListener('input', updateRememberText);
  $('#btn-delete-tx').addEventListener('click', deleteTx);
  $('#form-account').addEventListener('submit', onAccountSubmit);
  $('#btn-delete-account').addEventListener('click', deleteAccount);
  $('#form-category').addEventListener('submit', onCategorySubmit);
  $('#btn-delete-category').addEventListener('click', deleteCategory);
  $('#form-rule').addEventListener('submit', onRuleSubmit);
  $('#btn-delete-rule').addEventListener('click', deleteRule);
  $('#import-file').addEventListener('change', onImportFile);
  $('#import-account').addEventListener('change', () => { if (importState) renderImportPreview(); });
  $('#import-mapping').addEventListener('change', onMappingChange);
  $('#backup-file').addEventListener('change', e => {
    if (e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = '';
  });
  // Klikbare tegel ook met het toetsenbord
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.tile[data-action]')) { e.preventDefault(); e.target.click(); }
  });

  // Ander apparaat heeft iets opgeslagen terwijl deze app op de achtergrond stond? Dan nu ophalen.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !store.remote) return;
    if (saving || dirty || $$('dialog[open]').length) return;
    try {
      if (await store.hasNewer()) await reloadData();
    } catch {
      // Server even niet bereikbaar: de volgende keer opnieuw proberen
    }
  });
  window.addEventListener('beforeunload', e => { if (saving || dirty) e.preventDefault(); });
  document.addEventListener('blom:uitgelogd', () => { dirty = false; });

  $('#storage-info').textContent = store.remote
    ? 'Je gegevens staan op je server en zijn alleen voor jou. De server bewaart elke dag een kopie; een back-up downloaden kan altijd nog extra.'
    : 'Je gegevens worden opgeslagen in deze browser. Maak af en toe een back-up, dan raak je nooit iets kwijt.';

  try {
    await Blom.start('financien');
    const loaded = await store.load();
    data = loaded ? normalize(loaded) : defaultData();
  } catch (err) {
    $('#tab-overzicht').innerHTML = `<div class="empty-state card"><h2>Financiën kan niet openen</h2>
      <p>${esc(err.message)} Ververs de pagina om het opnieuw te proberen.</p></div>`;
    return;
  }
  renderAll();
}

init();
