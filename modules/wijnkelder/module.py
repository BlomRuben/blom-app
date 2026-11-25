"""
Module Wijnkelder: wijnen, rekken, wensenlijst en foto's.

Gegevens per gebruiker in users/<id>/wijnkelder/:
  data.json      wijnen, rekken en wensenlijst (via de kern)
  photos/        eigen foto's van etiketten (<wijn-id>.jpg)
  backups/       elke dag een kopie (via de kern)

Eigen adressen (naast /data en /version van de kern):
  GET/DELETE  /api/wijnkelder/photos           lijst van foto's / alle foto's wissen
  GET/PUT/DELETE /api/wijnkelder/photos/<id>   één foto
  POST        /api/wijnkelder/aanvullen        vraag aan Claude via de koppeling 'claude'
"""

import base64
import os
import re
from http import HTTPStatus

from core import koppelingen
from core.errors import ApiError
from core.koppelingen import claude

MODULE = {
    'id': 'wijnkelder',
    'name': 'Wijnkelder',
    'icon': '🍷',
    'description': 'Je flessen, rekken, wensenlijst en een kaart van waar je wijnen vandaan komen.',
    'color': '#8e1b3a',
    'order': 10,
}

PHOTO_URL = re.compile(r'^/photos/([a-z0-9]{1,40})$')
MAX_PROMPT = 20_000
MAX_PHOTO = 8 * 1024 * 1024


def validate(data):
    if not isinstance(data, dict) or not isinstance(data.get('wines'), list):
        return 'Dit zijn geen wijnkelder-gegevens'
    return None


def handle(request, method, rest, ctx):
    photo_dir = ctx.folder / 'photos'

    if rest == '/photos':
        if method == 'GET':
            photos = {p.stem: int(p.stat().st_mtime) for p in photo_dir.glob('*.jpg')} if photo_dir.exists() else {}
            request.send_json({'photos': photos})
            return True
        if method == 'DELETE':
            for photo in photo_dir.glob('*.jpg'):
                photo.unlink()
            request.send_json({'ok': True})
            return True

    match = PHOTO_URL.match(rest)
    if match:
        file = photo_dir / f'{match[1]}.jpg'
        if method == 'GET':
            request.send_file(file, cache=True)
            return True
        if method == 'PUT':
            image = request.read_body()
            if not image.startswith(b'\xff\xd8'):
                raise ApiError(HTTPStatus.BAD_REQUEST, 'Alleen JPEG-foto\'s worden geaccepteerd')
            photo_dir.mkdir(parents=True, exist_ok=True)
            tmp = photo_dir / f'{match[1]}.tmp'
            tmp.write_bytes(image)
            os.replace(tmp, file)
            request.send_json({'ok': True})
            return True
        if method == 'DELETE':
            file.unlink(missing_ok=True)
            request.send_json({'ok': True})
            return True

    if (method, rest) == ('POST', '/aanvullen'):
        request.send_json({'answer': fill_in(request.read_json(), ctx.user)})
        return True

    return False


def fill_in(body, user):
    """Stelt de vraag uit de app (en eventueel de foto) direct aan Claude, met zoeken op internet."""
    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT:
        raise ApiError(HTTPStatus.BAD_REQUEST, 'Ongeldige vraag')
    content = []
    photo = body.get('photo')
    if photo:
        # Een foto komt binnen als data-URL: data:image/jpeg;base64,....
        if not isinstance(photo, str) or not photo.startswith('data:image/jpeg;base64,') or len(photo) > MAX_PHOTO:
            raise ApiError(HTTPStatus.BAD_REQUEST, 'Ongeldige foto')
        data = photo.split(',', 1)[1]
        try:
            base64.b64decode(data, validate=True)
        except ValueError:
            raise ApiError(HTTPStatus.BAD_REQUEST, 'Ongeldige foto')
        content.append({'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/jpeg', 'data': data}})
    content.append({'type': 'text', 'text': prompt})
    return claude.ask(koppelingen.require('claude', user), content, web_search=True)
