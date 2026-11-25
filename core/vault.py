"""
Kluis: versleutelt geheimen van koppelingen (API-sleutels, tokens) voordat ze
op schijf komen.

Alleen de standaardbibliotheek: HMAC-SHA256 als sleutelstroom (tellermodus) en
een aparte HMAC als controle, zodat een gewijzigde of beschadigde waarde wordt
herkend. De sleutel staat in koppelingen.key in de gegevensmap. Wie de hele
gegevensmap heeft, kan de geheimen dus ontsleutelen; wie alleen een los
bestand (bijv. een back-up van koppelingen.json) ziet, niet.
"""

import base64
import hashlib
import hmac
import secrets

from . import config

PREFIX = 'v1:'
_keys = None


def _load_keys():
    global _keys
    if _keys is None:
        file = config.VAULT_KEY_FILE
        if file.exists():
            master = bytes.fromhex(file.read_text().strip())
        else:
            master = secrets.token_bytes(32)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(master.hex())
        _keys = (hmac.new(master, b'versleutelen', hashlib.sha256).digest(),
                 hmac.new(master, b'controleren', hashlib.sha256).digest())
    return _keys


def _keystream(key, nonce, length):
    blocks = []
    for counter in range((length + 31) // 32):
        blocks.append(hmac.new(key, nonce + counter.to_bytes(8, 'big'), hashlib.sha256).digest())
    return b''.join(blocks)[:length]


def encrypt(text):
    enc_key, mac_key = _load_keys()
    nonce = secrets.token_bytes(16)
    plain = text.encode('utf-8')
    cipher = bytes(a ^ b for a, b in zip(plain, _keystream(enc_key, nonce, len(plain))))
    tag = hmac.new(mac_key, nonce + cipher, hashlib.sha256).digest()
    return PREFIX + base64.b64encode(nonce + cipher + tag).decode('ascii')


def decrypt(value):
    if not isinstance(value, str) or not value.startswith(PREFIX):
        raise ValueError('Geen versleutelde waarde')
    enc_key, mac_key = _load_keys()
    raw = base64.b64decode(value[len(PREFIX):])
    nonce, cipher, tag = raw[:16], raw[16:-32], raw[-32:]
    if not hmac.compare_digest(hmac.new(mac_key, nonce + cipher, hashlib.sha256).digest(), tag):
        raise ValueError('De versleutelde waarde klopt niet (andere sleutel of beschadigd)')
    return bytes(a ^ b for a, b in zip(cipher, _keystream(enc_key, nonce, len(cipher)))).decode('utf-8')
