'use strict';

// ============================================================
//  Bankbestanden inlezen
//  Alleen rekenwerk, geen scherm: een CSV/TXT-bestand wordt een
//  lijst rijen, de bank wordt herkend aan de kolomkoppen, en
//  elke rij wordt een transactie { date, amount, counterparty,
//  counterIban, description }.
// ============================================================

const BankImport = {
  // Bytes → tekst. Banken gebruiken UTF-8 of het oude Windows-1252.
  decode(buffer) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      text = new TextDecoder('windows-1252').decode(buffer);
    }
    return text.replace(/^﻿/, '');
  },

  // Welk scheidingsteken? Tel ze in de eerste regel, buiten aanhalingstekens.
  detectDelimiter(text) {
    const line = text.split(/\r?\n/, 1)[0].replace(/"[^"]*"/g, '');
    const counts = [';', ',', '\t'].map(d => [d, line.split(d).length - 1]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 0 ? counts[0][0] : ',';
  },

  // Eenvoudige CSV-lezer met ondersteuning voor "aanhalingstekens", ook met "" en regeleinden erin
  parseCsv(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === delimiter) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(v => v.trim() !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some(v => v.trim() !== '')) rows.push(row);
    return rows.map(r => r.map(v => v.trim()));
  },

  // '12,34'  '-1.234,56'  '1,234.56'  '+5'  '€ 3,00' → getal
  parseAmount(value) {
    let s = String(value ?? '').replace(/[€\s]|EUR/g, '');
    if (!s) return null;
    const comma = s.lastIndexOf(',');
    const dot = s.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
      s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (comma >= 0) {
      s = s.replace(',', '.');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  },

  // '20261125'  '2026-11-25'  '25-11-2026'  '25/11/2026'  '2026/11/25' → '2026-11-25'
  parseDate(value) {
    const s = String(value ?? '').trim();
    let m;
    let y, mo, d;
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) [, y, mo, d] = m;
    else if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) [, y, mo, d] = m;
    else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/))) [, d, mo, y] = m;
    else return null;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const check = new Date(iso + 'T00:00:00Z');
    return Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso ? null : iso;
  },

  // Bij ABN AMRO staan naam en IBAN in de omschrijving; hier halen we ze eruit
  extractFromDescription(description) {
    const d = description || '';
    let m;
    const iban = (d.match(/\/IBAN\/([A-Z]{2}\d{2}[A-Z0-9]{8,30})\//) || d.match(/IBAN:\s*([A-Z]{2}\d{2}[A-Z0-9]{8,30})/) || [])[1] || '';
    if ((m = d.match(/\/NAME\/([^/]+)\//))) return { counterparty: m[1].trim(), counterIban: iban };
    // Pinbetaling: "BEA, Betaalpas   Albert Heijn 1234,PAS123 NR:..."
    if ((m = d.match(/(?:BEA|GEA|eCom)[,:]?\s+(?:Betaalpas\s+)?(.+?),\s*PAS/i))) {
      return { counterparty: m[1].replace(/\s{2,}/g, ' ').trim(), counterIban: iban };
    }
    if ((m = d.match(/Naam:\s*(.+?)(?:\s{2,}|\s+(?:Omschrijving|Kenmerk|Machtiging|IBAN|BIC):|$)/))) {
      return { counterparty: m[1].trim(), counterIban: iban };
    }
    return { counterparty: '', counterIban: iban };
  },

  // ---------- Banken herkennen ----------
  // Een profiel zegt per veld welke kolom het is (nummer), plus of er een kopregel is.

  profiles: [
    {
      name: 'ING',
      match: h => h.includes('af bij') && h.includes('naam / omschrijving'),
      columns: { date: 'datum', amount: 'bedrag (eur)', sign: 'af bij', counterparty: 'naam / omschrijving',
                 counterIban: 'tegenrekening', description: ['mededelingen'] },
    },
    {
      name: 'Rabobank',
      match: h => h.includes('iban/bban') && h.includes('naam tegenpartij'),
      columns: { date: 'datum', amount: 'bedrag', counterparty: 'naam tegenpartij',
                 counterIban: 'tegenrekening iban/bban', description: ['omschrijving-1', 'omschrijving-2', 'omschrijving-3'] },
    },
    {
      name: 'bunq',
      match: h => h.includes('date') && h.includes('amount') && h.includes('counterparty') && h.includes('name'),
      columns: { date: 'date', amount: 'amount', counterparty: 'name', counterIban: 'counterparty', description: ['description'] },
    },
  ],

  // Geeft { bank, hasHeader, map: {date, amount, sign, counterparty, counterIban, description: []} }
  // met kolomnummers (of -1 als het veld er niet is)
  detect(rows) {
    const header = (rows[0] || []).map(h => h.toLowerCase());
    const index = name => header.indexOf(name);
    for (const profile of this.profiles) {
      if (!profile.match(header)) continue;
      const c = profile.columns;
      return {
        bank: profile.name, hasHeader: true,
        map: {
          date: index(c.date), amount: index(c.amount), sign: c.sign ? index(c.sign) : -1,
          counterparty: index(c.counterparty), counterIban: index(c.counterIban),
          description: c.description.map(index).filter(i => i >= 0),
        },
      };
    }
    // ABN AMRO (TXT/TAB): geen kopregel; rekening, munt, datum, beginsaldo, eindsaldo, rentedatum, bedrag, omschrijving
    const first = rows[0] || [];
    if (first.length >= 8 && /^\d{8}$/.test(first[2]) && /^[A-Z]{3}$/.test(first[1])) {
      return {
        bank: 'ABN AMRO', hasHeader: false,
        map: { date: 2, amount: 6, sign: -1, counterparty: -1, counterIban: -1, description: [7] },
      };
    }
    // Onbekende bank: raden aan de hand van de kolomnamen
    const guess = words => header.findIndex(h => words.some(w => h.includes(w)));
    const description = guess(['omschrijving', 'description', 'mededeling']);
    return {
      bank: null, hasHeader: true,
      map: {
        date: guess(['datum', 'date']), amount: guess(['bedrag', 'amount']), sign: guess(['af bij', 'af/bij', 'debet/credit']),
        counterparty: guess(['naam', 'name', 'tegenpartij']), counterIban: guess(['tegenrekening', 'iban tegen']),
        description: description >= 0 ? [description] : [],
      },
    };
  },

  // Rijen + kolomindeling → transacties (rijen die niet lukken krijgen een foutmelding)
  toTransactions(rows, { hasHeader, map }) {
    const body = hasHeader ? rows.slice(1) : rows;
    return body.map((row, i) => {
      const cell = col => (col >= 0 ? row[col] ?? '' : '');
      const date = this.parseDate(cell(map.date));
      let amount = this.parseAmount(cell(map.amount));
      if (amount != null && map.sign >= 0) {
        const sign = cell(map.sign).toLowerCase();
        if (['af', 'debet', 'debit', 'd'].includes(sign)) amount = -Math.abs(amount);
        if (['bij', 'credit', 'c'].includes(sign)) amount = Math.abs(amount);
      }
      const description = map.description.map(cell).filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
      let counterparty = cell(map.counterparty);
      let counterIban = cell(map.counterIban);
      if (!counterparty) {
        const found = this.extractFromDescription(description);
        counterparty = found.counterparty;
        counterIban ||= found.counterIban;
      }
      const tx = { date, amount: amount == null ? null : Math.round(amount * 100) / 100, counterparty, counterIban, description };
      if (!date) tx.error = `Regel ${i + 1 + (hasHeader ? 1 : 0)}: datum niet herkend ("${cell(map.date)}")`;
      else if (amount == null) tx.error = `Regel ${i + 1 + (hasHeader ? 1 : 0)}: bedrag niet herkend ("${cell(map.amount)}")`;
      return tx;
    });
  },

  // Sleutel om dubbele transacties te herkennen
  key(tx, accountId) {
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return [accountId, tx.date, Math.round(tx.amount * 100), norm(tx.counterparty), norm(tx.description).slice(0, 80)].join('|');
  },

  // Markeert transacties die al bestaan. Twee gelijke transacties op één dag (bijv. twee
  // koffie) blijven allebei, doordat we tellen hoe vaak een sleutel al voorkomt.
  markDuplicates(newOnes, existing, accountId) {
    const counts = new Map();
    for (const tx of existing) {
      if (tx.accountId !== accountId) continue;
      const k = this.key(tx, accountId);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    for (const tx of newOnes) {
      if (tx.error) continue;
      const k = this.key(tx, accountId);
      const left = counts.get(k) || 0;
      tx.duplicate = left > 0;
      if (left > 0) counts.set(k, left - 1);
    }
    return newOnes;
  },
};

// Ook bruikbaar buiten de browser (voor tests)
if (typeof module !== 'undefined') module.exports = BankImport;
