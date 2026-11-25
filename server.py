"""
Blom App: één portaal voor al je eigen apps (modules), met één login en
koppelingen met externe diensten op één plek.

Starten:   python server.py
Instellingen (omgevingsvariabelen):
  PORT      poort waarop de app draait (standaard 8080)
  DATA_DIR  map voor gegevens, foto's en back-ups (standaard: map 'data' naast dit bestand)

Bij het eerste bezoek maak je een admin-account aan. De admin voegt gebruikers
toe en kiest per gebruiker welke modules die mag gebruiken.
Gebruik de app alleen op je thuisnetwerk of via een VPN zoals Tailscale, en
zet de poort niet open in je router.

Indeling van de gegevensmap:
  users.json                gebruikers (wachtwoorden alleen als hash)
  secret.key                sleutel waarmee inlogcookies worden ondertekend
  koppelingen.key           sleutel waarmee geheimen van koppelingen worden versleuteld
  koppelingen.json          koppelingen die voor iedereen gelden (geheimen versleuteld)
  users/<id>/               alles van één gebruiker:
    koppelingen.json          eigen koppelingen
    <module>/                 per module: data.json, backups/ (en bijv. photos/)
  verwijderd/               mappen van verwijderde gebruikers (niet gewist)
"""

import signal
import sys
from http.server import ThreadingHTTPServer

from core import config, migration, users
from core.modules import MODULES
from core.server import Handler
from core.storage import lock


def main():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    users.load_secret()
    # Gegevens van een oudere versie naar de huidige indeling
    with lock:
        migration.migrate()
    # Netjes stoppen als Docker de container stopt
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    print(f'Blom App draait op poort {config.PORT}, gegevens in {config.DATA_DIR}', flush=True)
    print(f'Modules: {", ".join(MODULES)}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', config.PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
