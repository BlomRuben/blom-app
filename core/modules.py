"""
Modules laden.

Een module is een map in modules/ met:
  module.py     MODULE = {...} en eventueel validate(data) en handle(request, method, rest, ctx)
  index.html    de pagina van de module, plus eigen css/ en js/

De kern regelt voor elke module:
  GET/PUT /api/<id>/data      de gegevens van de ingelogde gebruiker (met versie en back-ups)
  GET     /api/<id>/version   alleen het versienummer
Andere adressen onder /api/<id>/ gaan naar handle() van de module.
"""

import importlib.util
from dataclasses import dataclass

from . import config

MODULE_ID_CHARS = set('abcdefghijklmnopqrstuvwxyz0123456789-')


@dataclass
class Context:
    """Wat een module over het verzoek weet: wie het doet en waar de gegevens staan."""
    user: dict
    folder: object          # Path naar users/<gebruiker>/<module>/
    module: dict


def _load_all():
    found = {}
    for file in sorted(config.MODULES_DIR.glob('*/module.py')):
        module_id = file.parent.name
        if not set(module_id) <= MODULE_ID_CHARS:
            continue
        spec = importlib.util.spec_from_file_location(f'blom_module_{module_id.replace("-", "_")}', file)
        code = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(code)
        if code.MODULE['id'] != module_id:
            raise RuntimeError(f'{file}: MODULE["id"] moet "{module_id}" zijn (de naam van de map)')
        found[module_id] = code
    return dict(sorted(found.items(), key=lambda item: (item[1].MODULE.get('order', 99), item[0])))


MODULES = _load_all()


def meta(module_id):
    info = dict(MODULES[module_id].MODULE)
    info['url'] = f'modules/{module_id}/'
    return info
