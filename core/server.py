"""
De webserver van de Blom App.

Serveert het portaal, de gedeelde bestanden en de modules, en de API:
  /api/session, /api/setup, /api/login, /api/logout     inloggen (deels zonder login)
  /api/password                                       eigen wachtwoord wijzigen
  /api/users[/<id>]                                   gebruikers beheren (admin)
  /api/koppelingen[/<id>[/test]]                      koppelingen bekijken, instellen en testen
  /api/<module>/...                                   de gegevens van een module
"""

import json
import re
import shutil
import traceback
from datetime import date
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler
from urllib.parse import unquote, urlparse

from . import config, koppelingen, migration
from .errors import ApiError
from .modules import MODULES, Context, meta
from .storage import lock, read_store, write_store
from .users import (check_password, find_user, make_session, may_use, new_user, public, read_users,
                    record_failed_login, set_password, too_many_failed_logins, user_dir,
                    user_from_session, validate_password, validate_username, write_users)

USER_URL = re.compile(r'^/api/users/([a-f0-9]{16})$')
CONNECTOR_URL = re.compile(r'^/api/koppelingen/([a-z0-9-]{1,40})(/test)?$')
MODULE_URL = re.compile(r'^/api/([a-z0-9-]{1,40})(/.*)?$')
STATIC_FOLDERS = ('portaal', 'gedeeld', 'modules')


class Handler(BaseHTTPRequestHandler):
    server_version = 'Blom'

    def do_GET(self):
        self.handle_request('GET')

    def do_POST(self):
        self.handle_request('POST')

    def do_PUT(self):
        self.handle_request('PUT')

    def do_DELETE(self):
        self.handle_request('DELETE')

    def handle_request(self, method):
        path = urlparse(self.path).path
        if not path.startswith('/api/'):
            if method != 'GET':
                return self.send_error_json(HTTPStatus.METHOD_NOT_ALLOWED, 'Niet toegestaan')
            return self.serve_app(path)
        try:
            self.handle_api(method, path)
        except ApiError as err:
            self.send_error_json(err.status, str(err))
        except koppelingen.ConnectorError as err:
            self.send_error_json(HTTPStatus.BAD_GATEWAY, str(err))
        except Exception:
            # Onverwachte fout: in het log zetten en de app een nette melding geven
            traceback.print_exc()
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, 'Er ging iets mis op de server.')

    def handle_api(self, method, path):
        # Zonder inloggen: status, eerste admin aanmaken, inloggen en uitloggen
        if (method, path) == ('GET', '/api/session'):
            return self.send_session()
        if (method, path) == ('POST', '/api/setup'):
            return self.create_first_admin()
        if (method, path) == ('POST', '/api/login'):
            return self.log_in()
        if (method, path) == ('POST', '/api/logout'):
            return self.send_json({'ok': True}, cookie='')

        # Al het andere alleen voor wie is ingelogd
        with lock:
            user = self.session_user(read_users())
        if not user:
            raise ApiError(HTTPStatus.UNAUTHORIZED, 'Je bent niet (meer) ingelogd.')

        if (method, path) == ('POST', '/api/password'):
            return self.change_own_password(user)
        if path == '/api/users' or USER_URL.match(path):
            if user['role'] != 'admin':
                raise ApiError(HTTPStatus.FORBIDDEN, 'Alleen een admin mag gebruikers beheren.')
            return self.manage_users(method, path, user)
        if path == '/api/koppelingen' or CONNECTOR_URL.match(path):
            return self.manage_connectors(method, path, user)

        match = MODULE_URL.match(path)
        if match and match[1] in MODULES:
            return self.handle_module(method, match[1], match[2] or '/', user)
        raise ApiError(HTTPStatus.NOT_FOUND, 'Onbekend adres')

    # ---------- Inloggen ----------
    # (Let op: 'setup' en 'handle' zijn al namen van de webserver zelf)

    def send_session(self):
        with lock:
            users = read_users()
            user = self.session_user(users)
        if not user:
            return self.send_json({'setup': not users, 'legacy': not users and migration.has_pre_login_data(),
                                   'user': None, 'modules': [], 'connectors': []})
        self.send_json({
            'setup': False, 'legacy': False, 'user': public(user),
            'modules': [meta(m) for m in MODULES if may_use(user, m)],
            'connectors': koppelingen.configured(user),
        })

    def create_first_admin(self):
        body = self.read_json()
        username = validate_username(body.get('username'))
        password = validate_password(body.get('password'))
        user = new_user(username, password, 'admin', list(MODULES))
        with lock:
            if read_users():
                raise ApiError(HTTPStatus.FORBIDDEN, 'Er is al een admin-account. Log in.')
            write_users([user])
            migration.migrate()
        print(f'Admin-account {username} aangemaakt', flush=True)
        self.send_json({'user': public(user)}, cookie=make_session(user))

    def log_in(self):
        ip = self.client_address[0]
        if too_many_failed_logins(ip):
            raise ApiError(HTTPStatus.TOO_MANY_REQUESTS,
                           'Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.')
        body = self.read_json()
        username = body.get('username') if isinstance(body.get('username'), str) else ''
        password = body.get('password') if isinstance(body.get('password'), str) else ''
        with lock:
            user = find_user(read_users(), username.strip())
        # Het controleren duurt even; buiten het slot, zodat anderen niet hoeven te wachten
        if not user or not check_password(user, password):
            record_failed_login(ip)
            raise ApiError(HTTPStatus.BAD_REQUEST, 'Gebruikersnaam of wachtwoord klopt niet.')
        self.send_json({'user': public(user)}, cookie=make_session(user))

    def change_own_password(self, user):
        body = self.read_json()
        if not check_password(user, body.get('current') if isinstance(body.get('current'), str) else ''):
            raise ApiError(HTTPStatus.BAD_REQUEST, 'Je huidige wachtwoord klopt niet.')
        password = validate_password(body.get('password'))
        with lock:
            users = read_users()
            me = next(u for u in users if u['id'] == user['id'])
            set_password(me, password)
            write_users(users)
        # Andere apparaten worden uitgelogd, dit apparaat krijgt een nieuw cookie
        self.send_json({'ok': True}, cookie=make_session(me))

    # ---------- Gebruikers beheren (alleen admin) ----------

    @staticmethod
    def validate_modules(value):
        if not isinstance(value, list) or not all(isinstance(m, str) and m in MODULES for m in value):
            raise ApiError(HTTPStatus.BAD_REQUEST, 'Onbekende module')
        return sorted(set(value))

    def manage_users(self, method, path, admin):
        if (method, path) == ('GET', '/api/users'):
            with lock:
                users = read_users()
            return self.send_json({'users': [public(u) for u in sorted(users, key=lambda u: u['username'].casefold())]})

        if (method, path) == ('POST', '/api/users'):
            body = self.read_json()
            username = validate_username(body.get('username'))
            password = validate_password(body.get('password'))
            role = body.get('role')
            if role not in config.ROLES:
                raise ApiError(HTTPStatus.BAD_REQUEST, 'Onbekende rol')
            modules = self.validate_modules(body.get('modules', []))
            user = new_user(username, password, role, modules)
            with lock:
                users = read_users()
                if find_user(users, username):
                    raise ApiError(HTTPStatus.BAD_REQUEST, f'De gebruikersnaam "{username}" bestaat al.')
                users.append(user)
                write_users(users)
            return self.send_json({'user': public(user)})

        match = USER_URL.match(path)
        if not match:
            raise ApiError(HTTPStatus.NOT_FOUND, 'Onbekend adres')

        if method == 'PUT':
            body = self.read_json()
            password = validate_password(body['password']) if body.get('password') else None
            role = body.get('role')
            if role is not None and role not in config.ROLES:
                raise ApiError(HTTPStatus.BAD_REQUEST, 'Onbekende rol')
            modules = self.validate_modules(body['modules']) if 'modules' in body else None
            with lock:
                users = read_users()
                user = next((u for u in users if u['id'] == match[1]), None)
                if not user:
                    raise ApiError(HTTPStatus.NOT_FOUND, 'Deze gebruiker bestaat niet (meer).')
                if role and role != user['role']:
                    admins = [u for u in users if u['role'] == 'admin']
                    if user['role'] == 'admin' and len(admins) == 1:
                        raise ApiError(HTTPStatus.BAD_REQUEST, 'Er moet minstens één admin blijven.')
                    user['role'] = role
                if modules is not None:
                    user['modules'] = modules
                if password:
                    set_password(user, password)
                write_users(users)
            # Eigen wachtwoord gewijzigd? Dan blijft dit apparaat ingelogd
            cookie = make_session(user) if password and user['id'] == admin['id'] else None
            return self.send_json({'user': public(user)}, cookie=cookie)

        if method == 'DELETE':
            if match[1] == admin['id']:
                raise ApiError(HTTPStatus.BAD_REQUEST, 'Je kunt je eigen account niet verwijderen.')
            with lock:
                users = read_users()
                user = next((u for u in users if u['id'] == match[1]), None)
                if not user:
                    raise ApiError(HTTPStatus.NOT_FOUND, 'Deze gebruiker bestaat niet (meer).')
                # De gegevens niet wissen maar apart zetten, voor het geval het een vergissing was
                folder = user_dir(user)
                if folder.exists():
                    config.REMOVED_DIR.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(folder), str(config.REMOVED_DIR / f'{user["username"]}-{date.today().isoformat()}-{user["id"]}'))
                write_users([u for u in users if u['id'] != user['id']])
            return self.send_json({'ok': True})

        raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, 'Niet toegestaan')

    # ---------- Koppelingen ----------

    def manage_connectors(self, method, path, user):
        if (method, path) == ('GET', '/api/koppelingen'):
            return self.send_json({'connectors': koppelingen.describe(user)})
        match = CONNECTOR_URL.match(path)
        if not match:
            raise ApiError(HTTPStatus.NOT_FOUND, 'Onbekend adres')
        connector_id, is_test = match[1], bool(match[2])
        if is_test and method == 'POST':
            try:
                return self.send_json({'ok': True, 'message': koppelingen.test(connector_id, user)})
            except koppelingen.ConnectorError as err:
                return self.send_json({'ok': False, 'message': str(err)})
        if not is_test and method == 'PUT':
            koppelingen.save(connector_id, user, self.read_json().get('values'))
            return self.send_json({'ok': True})
        if not is_test and method == 'DELETE':
            koppelingen.remove(connector_id, user)
            return self.send_json({'ok': True})
        raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, 'Niet toegestaan')

    # ---------- Modules ----------

    def handle_module(self, method, module_id, rest, user):
        if not may_use(user, module_id):
            raise ApiError(HTTPStatus.FORBIDDEN, 'Je hebt geen toegang tot deze module.')
        code = MODULES[module_id]
        ctx = Context(user=user, folder=user_dir(user) / module_id, module=code.MODULE)

        if (method, rest) == ('GET', '/data'):
            with lock:
                return self.send_json(read_store(ctx.folder))

        if (method, rest) == ('GET', '/version'):
            with lock:
                return self.send_json({'version': read_store(ctx.folder)['version']})

        if (method, rest) == ('PUT', '/data'):
            body = self.read_json()
            data = body.get('data')
            problem = code.validate(data) if hasattr(code, 'validate') else None
            if not isinstance(data, dict) or problem:
                raise ApiError(HTTPStatus.BAD_REQUEST, problem or 'Ongeldige gegevens')
            with lock:
                store = read_store(ctx.folder)
                # Alleen opslaan als het apparaat de nieuwste versie had;
                # anders zou het de wijzigingen van een ander apparaat overschrijven
                if body.get('version') != store['version']:
                    return self.send_json({'error': 'conflict', 'version': store['version']}, HTTPStatus.CONFLICT)
                new = {'version': store['version'] + 1, 'data': data}
                write_store(ctx.folder, new)
            return self.send_json({'version': new['version']})

        if hasattr(code, 'handle') and code.handle(self, method, rest, ctx):
            return
        raise ApiError(HTTPStatus.NOT_FOUND, 'Onbekend adres')

    # ---------- Hulpfuncties ----------

    def session_user(self, users):
        try:
            cookie = SimpleCookie(self.headers.get('Cookie') or '')
        except CookieError:
            return None
        morsel = cookie.get(config.COOKIE_NAME)
        return user_from_session(morsel.value, users) if morsel else None

    def serve_app(self, path):
        """Serveert alleen de app zelf (portaal/, gedeeld/ en modules/), nooit code of gegevens."""
        rel = unquote(path.lstrip('/'))
        # Het portaal is de startpagina; de adressen volgen de mappen, zodat relatieve links kloppen
        if rel in ('', 'portaal'):
            return self.redirect('portaal/')
        parts = rel.split('/')
        # modules/<id> zonder / aan het eind: doorsturen, anders kloppen de relatieve links niet
        if len(parts) == 2 and parts[0] == 'modules' and parts[1] in MODULES:
            return self.redirect(f'{parts[1]}/')
        if rel.endswith('/'):
            rel += 'index.html'
        file = (config.APP_DIR / rel).resolve()
        # Pas na het oplossen van '..' controleren, anders kan /gedeeld/../core/server.py er toch doorheen
        allowed = (
            any(config.APP_DIR / folder in file.parents for folder in STATIC_FOLDERS)
            and file.suffix.lower() in config.CONTENT_TYPES
            and not any(part.startswith(('.', '__')) for part in file.relative_to(config.APP_DIR).parts)
        )
        if not allowed:
            return self.send_error_json(HTTPStatus.NOT_FOUND, 'Niet gevonden')
        self.send_file(file)

    def redirect(self, location):
        self.send_response(HTTPStatus.MOVED_PERMANENTLY)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def send_file(self, file, cache=False):
        if not file.is_file():
            return self.send_error_json(HTTPStatus.NOT_FOUND, 'Niet gevonden')
        content = file.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header('Content-Type', config.CONTENT_TYPES.get(file.suffix.lower(), 'application/octet-stream'))
        self.send_header('Content-Length', str(len(content)))
        # De app zelf altijd opnieuw controleren, zodat een nieuwe versie meteen zichtbaar is.
        # Foto's veranderen nooit onder hetzelfde adres, maar zijn wel privé.
        self.send_header('Cache-Control', 'private, max-age=31536000, immutable' if cache else 'no-cache')
        self.end_headers()
        self.wfile.write(content)

    def read_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > config.MAX_BODY:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, 'Verzoek te groot')
        return self.rfile.read(length)

    def read_json(self):
        # Alleen JSON accepteren: een formulier op een andere website kan dat niet sturen
        if not (self.headers.get('Content-Type') or '').startswith('application/json'):
            raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, 'Verwacht JSON')
        try:
            body = json.loads(self.read_body())
        except (ValueError, UnicodeDecodeError):
            raise ApiError(HTTPStatus.BAD_REQUEST, 'Ongeldige JSON')
        if not isinstance(body, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, 'Ongeldige JSON')
        return body

    def send_json(self, value, status=HTTPStatus.OK, cookie=None):
        content = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        if cookie is not None:
            # Leeg cookie = uitloggen
            max_age = config.SESSION_DAYS * 86400 if cookie else 0
            secure = '; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''
            self.send_header('Set-Cookie', f'{config.COOKIE_NAME}={cookie}; Max-Age={max_age}; Path=/; HttpOnly; SameSite=Strict{secure}')
        self.end_headers()
        self.wfile.write(content)

    def send_error_json(self, status, message):
        self.send_json({'error': message}, status)
