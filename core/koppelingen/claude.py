"""
Koppeling met Claude via de Anthropic API.

Hiervoor is een API-sleutel van platform.claude.com nodig. Let op: dat is
iets anders dan een Claude-abonnement; de API rekent per gebruik af.
Gebruikt het officiële pakket 'anthropic' (zie requirements.txt).
"""

from . import ConnectorError

DEFAULT_MODEL = 'claude-opus-5-5'

CONNECTOR = {
    'id': 'claude',
    'name': 'Claude (Anthropic API)',
    'description': 'Laat modules Claude direct een vraag stellen, bijvoorbeeld om een wijn automatisch '
                   'aan te vullen. Je betaalt per gebruik via je API-tegoed, los van een Claude-abonnement.',
    'scope': 'global',
    'used_by': ['Wijnkelder: direct aanvullen'],
    'fields': [
        {'name': 'api_key', 'label': 'API-sleutel', 'type': 'secret', 'required': True,
         'hint': 'Maak een sleutel aan op platform.claude.com onder API keys. Begint met sk-ant-.'},
        {'name': 'model', 'label': 'Model', 'type': 'text', 'default': DEFAULT_MODEL,
         'hint': f'Leeg laten = {DEFAULT_MODEL}.'},
    ],
}

# Bij een weigering om veiligheidsredenen probeert de API het zelf op een ander model
FALLBACK_BETA = 'server-side-fallback-2026-07-01'


def _client(settings):
    try:
        import anthropic
    except ImportError:
        raise ConnectorError('Het pakket "anthropic" is niet geïnstalleerd op de server '
                             '(pip install -r requirements.txt).')
    return anthropic, anthropic.Anthropic(api_key=settings['api_key'], timeout=300.0)


def _friendly(anthropic, err):
    """Zet een fout van de API om in een begrijpelijke melding."""
    if isinstance(err, anthropic.AuthenticationError):
        return ConnectorError('De API-sleutel wordt niet geaccepteerd. Controleer hem onder Koppelingen.')
    if isinstance(err, anthropic.PermissionDeniedError):
        return ConnectorError('Deze API-sleutel heeft geen toegang tot dit model of deze functie.')
    if isinstance(err, anthropic.NotFoundError):
        return ConnectorError('Dit model bestaat niet (meer). Pas het model aan onder Koppelingen.')
    if isinstance(err, anthropic.RateLimitError):
        return ConnectorError('Claude is even te druk of je limiet is bereikt. Probeer het over een minuut opnieuw.')
    if isinstance(err, anthropic.APIStatusError):
        if err.status_code >= 500:
            return ConnectorError('Claude is tijdelijk niet beschikbaar. Probeer het later opnieuw.')
        return ConnectorError(f'Claude gaf een fout: {err.message}')
    if isinstance(err, anthropic.APIConnectionError):
        return ConnectorError('De server kan Claude niet bereiken. Heeft de server internet?')
    return ConnectorError(f'Er ging iets mis met Claude: {err}')


def test(settings):
    anthropic, client = _client(settings)
    try:
        model = client.models.retrieve(settings['model'])
    except anthropic.APIError as err:
        raise _friendly(anthropic, err)
    return f'Verbonden. Model {model.display_name} is beschikbaar.'


def ask(settings, content, web_search=False, max_tokens=16000):
    """
    Stelt Claude één vraag en geeft de tekst van het antwoord terug.
    content: tekst, of een lijst met blokken (bijv. een foto en tekst).
    web_search: Claude mag op internet zoeken (kost iets extra per zoekopdracht).
    """
    anthropic, client = _client(settings)
    messages = [{'role': 'user', 'content': content}]
    tools = [{'type': 'web_search_20260209', 'name': 'web_search', 'max_uses': 5}] if web_search else []
    try:
        # Bij lang zoeken pauzeert de API soms; dan gaan we verder waar hij was
        for _ in range(5):
            response = client.beta.messages.create(
                model=settings['model'],
                max_tokens=max_tokens,
                betas=[FALLBACK_BETA],
                fallbacks='default',
                messages=messages,
                **({'tools': tools} if tools else {}),
            )
            if response.stop_reason != 'pause_turn':
                break
            messages.append({'role': 'assistant', 'content': response.content})
    except anthropic.APIError as err:
        raise _friendly(anthropic, err)

    if response.stop_reason == 'refusal':
        raise ConnectorError('Claude wilde deze vraag niet beantwoorden.')
    text = ''.join(block.text for block in response.content if block.type == 'text').strip()
    if not text:
        raise ConnectorError('Claude gaf geen antwoord. Probeer het opnieuw.')
    return text
