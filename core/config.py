"""Instellingen en vaste waarden van de Blom App."""

import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get('DATA_DIR', APP_DIR / 'data')).resolve()
PORT = int(os.environ.get('PORT', '8080'))

USERS_FILE = DATA_DIR / 'users.json'
SECRET_FILE = DATA_DIR / 'secret.key'
VAULT_KEY_FILE = DATA_DIR / 'koppelingen.key'
GLOBAL_CONNECTIONS_FILE = DATA_DIR / 'koppelingen.json'
USERS_DIR = DATA_DIR / 'users'            # per gebruiker een map, met daarin een map per module
REMOVED_DIR = DATA_DIR / 'verwijderd'     # mappen van verwijderde gebruikers (niet gewist)

MODULES_DIR = APP_DIR / 'modules'

KEEP_BACKUPS = 30                         # aantal dagelijkse back-ups per module
MAX_BODY = 20 * 1024 * 1024               # grootste verzoek dat we accepteren (20 MB)

COOKIE_NAME = 'blom_sessie'
SESSION_DAYS = 30                         # zo lang blijf je ingelogd
PASSWORD_ROUNDS = 600_000                 # maakt wachtwoorden raden traag
MIN_PASSWORD = 8
ROLES = ('admin', 'user')
MAX_FAILED_LOGINS = 10                    # per IP-adres per kwartier
FAILED_LOGIN_WINDOW = 15 * 60

# Bestanden die de server als onderdeel van de app mag serveren
CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
}
