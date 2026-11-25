"""
Opslag op schijf.

Elke module bewaart per gebruiker één JSON-bestand met een versienummer:
  users/<gebruiker>/<module>/data.json      {'version': getal, 'data': ...}
  users/<gebruiker>/<module>/backups/       elke dag een kopie, de laatste 30 dagen

Het versienummer voorkomt dat twee apparaten elkaars wijzigingen overschrijven:
opslaan mag alleen vanaf de nieuwste versie.
"""

import json
import os
import shutil
import threading
from datetime import date

from .config import KEEP_BACKUPS

# Eén verzoek tegelijk mag de gegevens lezen of schrijven
lock = threading.RLock()


def write_json(file, value):
    # Eerst naar een tijdelijk bestand, dan in één keer vervangen:
    # zo raakt het bestand nooit half geschreven, ook niet bij stroomuitval
    file.parent.mkdir(parents=True, exist_ok=True)
    tmp = file.with_suffix('.tmp')
    with tmp.open('w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, file)


def read_json(file, default=None):
    if not file.exists():
        return default
    # utf-8-sig: leest ook een bestand dat in Kladblok of PowerShell is opgeslagen
    with file.open(encoding='utf-8-sig') as f:
        return json.load(f)


def read_store(folder):
    """Geeft {'version': getal, 'data': gegevens of None} terug."""
    return read_json(folder / 'data.json', {'version': 0, 'data': None})


def write_store(folder, store):
    backup_once_a_day(folder)
    write_json(folder / 'data.json', store)


def backup_once_a_day(folder):
    """Bewaart bij de eerste wijziging van de dag een kopie van de stand van daarvoor."""
    file = folder / 'data.json'
    if not file.exists():
        return
    backups = folder / 'backups'
    backups.mkdir(exist_ok=True)
    target = backups / f'data-{date.today().isoformat()}.json'
    if not target.exists():
        shutil.copy2(file, target)
    for old in sorted(backups.glob('data-*.json'))[:-KEEP_BACKUPS]:
        old.unlink()
