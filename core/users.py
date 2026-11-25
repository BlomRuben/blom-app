"""
Gebruikers, wachtwoorden, inlogcookies en rechten per module.

Een admin mag alle modules gebruiken en beheert gebruikers en de koppelingen
die voor iedereen gelden. Een gewone gebruiker ziet alleen de modules die de
admin voor hem of haar heeft aangezet (het veld 'modules').
"""

import hashlib
import hmac
import re
import secrets
import time
from datetime import date
from http import HTTPStatus

from . import config
from .errors import ApiError
from .storage import lock, read_json, write_json

USERNAME = re.compile(r'^[A-Za-z0-9._-]{1,32}$')

failed_logins = {}                     # IP-adres -> tijdstippen van mislukte pogingen
SECRET = None                          # wordt bij het starten geladen (load_secret)


# ---------- Bestand met gebruikers ----------

def read_users():
    return read_json(config.USERS_FILE, {'users': []})['users']


def write_users(users):
    write_json(config.USERS_FILE, {'users': users})


def public(user):
    """Wat de app over een gebruiker mag weten (dus zonder wachtwoord-hash)."""
    info = {key: user[key] for key in ('id', 'username', 'role', 'created')}
    info['modules'] = list(user.get('modules') or [])
    return info


def find_user(users, username):
    return next((u for u in users if u['username'].casefold() == username.casefold()), None)


def user_dir(user):
    return config.USERS_DIR / user['id']


def may_use(user, module_id):
    return user['role'] == 'admin' or module_id in (user.get('modules') or [])


# ---------- Wachtwoorden ----------

def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, config.PASSWORD_ROUNDS)
    return {'salt': salt.hex(), 'hash': digest.hex(), 'rounds': config.PASSWORD_ROUNDS}


def check_password(user, password):
    p = user['password']
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(p['salt']), p['rounds'])
    return hmac.compare_digest(digest.hex(), p['hash'])


def set_password(user, password):
    user['password'] = hash_password(password)
    # Ingelogde apparaten met het oude wachtwoord worden hierdoor uitgelogd
    user['session'] = user.get('session', 0) + 1


def validate_username(value):
    name = value.strip() if isinstance(value, str) else ''
    if not USERNAME.match(name):
        raise ApiError(HTTPStatus.BAD_REQUEST,
                       'Gebruik voor de gebruikersnaam 1 tot 32 letters, cijfers, punten, streepjes of liggende streepjes.')
    return name


def validate_password(value):
    if not isinstance(value, str) or len(value) < config.MIN_PASSWORD:
        raise ApiError(HTTPStatus.BAD_REQUEST, f'Kies een wachtwoord van minstens {config.MIN_PASSWORD} tekens.')
    if len(value) > 200:
        raise ApiError(HTTPStatus.BAD_REQUEST, 'Dat wachtwoord is te lang.')
    return value


def new_user(username, password, role, modules):
    user = {'id': secrets.token_hex(8), 'username': username, 'role': role,
            'created': date.today().isoformat(), 'session': 0, 'modules': modules}
    set_password(user, password)
    return user


# ---------- Inlogcookie ----------
# Het cookie bevat gebruiker, vervaldatum en sessienummer, ondertekend met een
# geheime sleutel. Zo hoeft de server geen sessies bij te houden en blijf je
# ook na een herstart van de container ingelogd.

def load_secret():
    global SECRET
    if config.SECRET_FILE.exists():
        SECRET = bytes.fromhex(config.SECRET_FILE.read_text().strip())
        return
    SECRET = secrets.token_bytes(32)
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config.SECRET_FILE.write_text(SECRET.hex())


def sign(payload):
    return hmac.new(SECRET, payload.encode(), hashlib.sha256).hexdigest()


def make_session(user):
    expires = int(time.time()) + config.SESSION_DAYS * 86400
    payload = f'{user["id"]}.{expires}.{user["session"]}'
    return f'{payload}.{sign(payload)}'


def user_from_session(value, users):
    parts = value.split('.')
    if len(parts) != 4:
        return None
    user_id, expires, session, signature = parts
    if not hmac.compare_digest(sign(f'{user_id}.{expires}.{session}'), signature):
        return None
    if not expires.isdigit() or int(expires) < time.time():
        return None
    user = next((u for u in users if u['id'] == user_id), None)
    if not user or str(user['session']) != session:
        return None
    return user


def too_many_failed_logins(ip):
    now = time.time()
    with lock:
        recent = [t for t in failed_logins.get(ip, []) if now - t < config.FAILED_LOGIN_WINDOW]
        failed_logins[ip] = recent
        return len(recent) >= config.MAX_FAILED_LOGINS


def record_failed_login(ip):
    with lock:
        failed_logins.setdefault(ip, []).append(time.time())
