"""
Module Financiën: rekeningen, transacties (o.a. importeren uit een CSV van de bank),
categorieën met budget en regels die transacties automatisch indelen.

Gegevens per gebruiker in users/<id>/financien/data.json (via de kern, met
dagelijkse back-ups). Het importeren en indelen gebeurt in de browser; de
server bewaart alleen het resultaat.
"""

MODULE = {
    'id': 'financien',
    'name': 'Financiën',
    'icon': '💶',
    'description': 'Je rekeningen, uitgaven en inkomsten per categorie, budgetten en import van je bankafschriften.',
    'color': '#1f6f5c',
    'order': 20,
}

LISTS = ('accounts', 'categories', 'rules', 'transactions')


def validate(data):
    if not isinstance(data, dict) or not all(isinstance(data.get(key), list) for key in LISTS):
        return 'Dit zijn geen financiële gegevens'
    return None
