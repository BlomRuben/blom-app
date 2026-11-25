"""
Gegevens van oudere versies naar de huidige indeling verhuizen.

Draait bij elke start (en na het aanmaken van de eerste admin) en doet alleen
iets als er nog iets oud is. Er wordt nooit iets overschreven: staat het doel
er al, dan blijft het oude bestand staan waar het stond.

Versie 1 (vóór de inlogfunctie), alles direct in de gegevensmap:
  wijnkelder.json, photos/, backups/
Versie 2 (wijnkelder met login), per gebruiker:
  users/<id>/wijnkelder.json, photos/, backups/wijnkelder-<datum>.json
Nu (Blom App), per gebruiker per module:
  users/<id>/wijnkelder/data.json, photos/, backups/data-<datum>.json
"""

import shutil

from . import config
from .users import read_users, write_users

OLD_ITEMS = ('wijnkelder.json', 'photos', 'backups')


def has_pre_login_data():
    return any((config.DATA_DIR / name).exists() for name in OLD_ITEMS)


def _move_cellar(source_dir, target_dir):
    """Verhuist een kelder (wijnkelder.json, photos/, backups/) naar de map van de module."""
    moved = False
    target_dir.mkdir(parents=True, exist_ok=True)
    old_file = source_dir / 'wijnkelder.json'
    if old_file.exists() and not (target_dir / 'data.json').exists():
        shutil.move(str(old_file), str(target_dir / 'data.json'))
        moved = True
    old_photos = source_dir / 'photos'
    if old_photos.is_dir() and not (target_dir / 'photos').exists():
        shutil.move(str(old_photos), str(target_dir / 'photos'))
        moved = True
    old_backups = source_dir / 'backups'
    if old_backups.is_dir():
        (target_dir / 'backups').mkdir(exist_ok=True)
        for backup in old_backups.glob('wijnkelder-*.json'):
            target = target_dir / 'backups' / backup.name.replace('wijnkelder-', 'data-', 1)
            if not target.exists():
                shutil.move(str(backup), str(target))
                moved = True
        if not any(old_backups.iterdir()):
            old_backups.rmdir()
    return moved


def migrate():
    users = read_users()

    # Versie 1: de kelder van vóór de inlogfunctie gaat naar de eerste admin
    admin = next((u for u in users if u['role'] == 'admin'), None)
    if admin and has_pre_login_data():
        if _move_cellar(config.DATA_DIR, config.USERS_DIR / admin['id'] / 'wijnkelder'):
            print(f'Kelder van vóór de inlogfunctie verhuisd naar {admin["username"]}', flush=True)

    # Versie 2: de kelder per gebruiker gaat naar de map van de module
    for user in users:
        folder = config.USERS_DIR / user['id']
        if (folder / 'wijnkelder.json').exists() or (folder / 'photos').is_dir() or (folder / 'backups').is_dir():
            if _move_cellar(folder, folder / 'wijnkelder'):
                print(f'Kelder van {user["username"]} verhuisd naar de module wijnkelder', flush=True)

    # Gebruikers van vóór de modules hadden alleen de wijnkelder
    changed = False
    for user in users:
        if 'modules' not in user:
            user['modules'] = ['wijnkelder']
            changed = True
    if changed:
        write_users(users)
