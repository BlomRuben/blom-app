"""
Koppelingen met externe diensten, op één plek.

Elke koppeling is één bestand in deze map met een CONNECTOR-beschrijving en
eventueel een test-functie. Modules gebruiken een koppeling via
settings(id, user) en de functies van die koppeling, en hoeven dus zelf
nooit een sleutel te bewaren.

Twee soorten:
  scope 'global'  één instelling voor de hele app, alleen de admin wijzigt die
                  (bijv. een API-sleutel van een dienst)
  scope 'user'    iedere gebruiker stelt het zelf in (bijv. de eigen bank)

Velden van het type 'secret' worden versleuteld opgeslagen (zie vault.py) en
nooit teruggestuurd naar de browser.

Een nieuwe koppeling toevoegen:
  1. Maak core/koppelingen/<id>.py met CONNECTOR = {...} en een test(settings).
  2. Zet de naam in ORDER hieronder.
  Het scherm Koppelingen in het portaal toont hem dan vanzelf.
"""

import importlib
from datetime import datetime
from http import HTTPStatus

from .. import config, vault
from ..errors import ApiError
from ..storage import lock, read_json, write_json
from ..users import user_dir

ORDER = ['claude']


class ConnectorError(Exception):
    """Een koppeling werkt niet; de tekst is een nette melding voor de gebruiker."""


def _load():
    connectors = {}
    for name in ORDER:
        module = importlib.import_module(f'{__name__}.{name}')
        connectors[module.CONNECTOR['id']] = module
    return connectors


CONNECTORS = _load()


def _file(connector, user):
    if connector.CONNECTOR['scope'] == 'global':
        return config.GLOBAL_CONNECTIONS_FILE
    return user_dir(user) / 'koppelingen.json'


def _get(module_id, user):
    connector = CONNECTORS.get(module_id)
    if not connector:
        raise ApiError(HTTPStatus.NOT_FOUND, 'Deze koppeling bestaat niet.')
    return connector


def _may_edit(connector, user):
    return connector.CONNECTOR['scope'] == 'user' or user['role'] == 'admin'


def _fields(connector):
    return connector.CONNECTOR['fields']


def describe(user):
    """Alle koppelingen met hun status, zoals het portaal ze toont (zonder geheimen)."""
    result = []
    with lock:
        for connector in CONNECTORS.values():
            info = connector.CONNECTOR
            stored = read_json(_file(connector, user), {}).get(info['id'])
            values, secrets_set = {}, {}
            for field in _fields(connector):
                if field['type'] == 'secret':
                    secrets_set[field['name']] = bool(stored and stored['values'].get(field['name']))
                elif stored:
                    values[field['name']] = stored['values'].get(field['name'], '')
            result.append({
                'id': info['id'], 'name': info['name'], 'description': info['description'],
                'scope': info['scope'], 'fields': info['fields'], 'used_by': info.get('used_by', []),
                'configured': bool(stored), 'updated': stored['updated'] if stored else None,
                'values': values, 'secrets_set': secrets_set,
                'editable': _may_edit(connector, user),
            })
    return result


def configured(user):
    """Id's van de koppelingen die voor deze gebruiker klaarstaan."""
    return [c['id'] for c in describe(user) if c['configured']]


def save(connector_id, user, values):
    connector = _get(connector_id, user)
    if not _may_edit(connector, user):
        raise ApiError(HTTPStatus.FORBIDDEN, 'Alleen een admin mag deze koppeling instellen.')
    if not isinstance(values, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, 'Ongeldige waarden')
    file = _file(connector, user)
    with lock:
        all_stored = read_json(file, {})
        old = all_stored.get(connector_id, {'values': {}})['values']
        new = {}
        for field in _fields(connector):
            name = field['name']
            value = values.get(name)
            value = value.strip() if isinstance(value, str) else ''
            if len(value) > 4000:
                raise ApiError(HTTPStatus.BAD_REQUEST, f'{field["label"]} is te lang.')
            if field['type'] == 'secret':
                # Leeg laten = de bestaande waarde houden
                new[name] = vault.encrypt(value) if value else old.get(name, '')
            else:
                new[name] = value or field.get('default', '')
            if field.get('required') and not new[name]:
                raise ApiError(HTTPStatus.BAD_REQUEST, f'Vul {field["label"]} in.')
        all_stored[connector_id] = {'values': new, 'updated': datetime.now().isoformat(timespec='seconds')}
        write_json(file, all_stored)


def remove(connector_id, user):
    connector = _get(connector_id, user)
    if not _may_edit(connector, user):
        raise ApiError(HTTPStatus.FORBIDDEN, 'Alleen een admin mag deze koppeling verwijderen.')
    file = _file(connector, user)
    with lock:
        all_stored = read_json(file, {})
        all_stored.pop(connector_id, None)
        write_json(file, all_stored)


def settings(connector_id, user):
    """De ontsleutelde instellingen van een koppeling, of None als die niet is ingesteld."""
    connector = _get(connector_id, user)
    with lock:
        stored = read_json(_file(connector, user), {}).get(connector_id)
    if not stored:
        return None
    result = {}
    for field in _fields(connector):
        value = stored['values'].get(field['name'], '')
        if field['type'] == 'secret' and value:
            try:
                value = vault.decrypt(value)
            except ValueError:
                raise ConnectorError(f'De opgeslagen {field["label"]} kan niet worden gelezen. Stel de koppeling opnieuw in.')
        result[field['name']] = value or field.get('default', '')
    return result


def require(connector_id, user):
    """Zoals settings(), maar met een nette fout als de koppeling niet is ingesteld."""
    found = settings(connector_id, user)
    if not found:
        name = CONNECTORS[connector_id].CONNECTOR['name']
        raise ConnectorError(f'De koppeling "{name}" is nog niet ingesteld. Doe dat in het portaal onder Koppelingen.')
    return found


def test(connector_id, user):
    connector = _get(connector_id, user)
    return connector.test(require(connector_id, user))
