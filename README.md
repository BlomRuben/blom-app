# 🌿 Blom App

Eén portaal voor al je eigen apps. Je logt één keer in, kiest een app (een *module*) en
stelt koppelingen met andere diensten op één plek in, zodat alle apps ze kunnen gebruiken.
De app draait als Docker-container op een Unraid-server.

*Deze README beschrijft de huidige staat van de app en wordt bij elke wijziging bijgewerkt.*

## Wat erin zit

| Onderdeel | Wat je er ziet en doet |
|---|---|
| **Portaal** | Inloggen, een tegel per app, **Koppelingen**, **Je account** (wachtwoord wijzigen) en voor een admin **Gebruikers**. |
| **🍷 Wijnkelder** | Flessen, rekken, kaart, wensenlijst en automatisch aanvullen via Claude. |
| **💶 Financiën** | Rekeningen, transacties, import van bankafschriften, categorieën, budgetten en regels. |

Bovenin elke app staat de weg terug naar het portaal, een keuzelijst om naar een andere app te
gaan, je naam en **Uitloggen**.

### Portaal
- **Eerste bezoek:** je maakt een admin-account aan.
- **Gebruikers** (alleen admin): toevoegen, rol wijzigen, nieuw wachtwoord instellen,
  verwijderen, en per gebruiker aanvinken welke apps die mag gebruiken. Een admin mag
  altijd alle apps gebruiken. Iedere gebruiker heeft eigen gegevens in elke app.
  De gegevens van een verwijderde gebruiker worden niet gewist maar apart gezet.
- **Koppelingen:** per externe dienst één kaart met de instellingen, **Opslaan**,
  **Verbinding testen** en **Verwijderen**. Er zijn twee soorten:
  - *Voor iedereen*: één instelling voor de hele app, alleen de admin kan die wijzigen.
  - *Persoonlijk*: iedere gebruiker stelt het zelf in.
  Sleutels en wachtwoorden worden versleuteld opgeslagen en nooit meer getoond.
- Wachtwoorden worden alleen als hash opgeslagen (PBKDF2). Je blijft 30 dagen ingelogd.
  Na 10 foute pogingen binnen een kwartier volgt een blokkade.

### Koppelingen die er nu zijn
| Koppeling | Soort | Gebruikt door |
|---|---|---|
| **Claude (Anthropic API)** | voor iedereen | Wijnkelder: direct aanvullen |

Voor de Claude-koppeling heb je een API-sleutel van platform.claude.com nodig. Dat is iets
anders dan een Claude-abonnement: de API rekent per gebruik af. Standaardmodel: `claude-opus-5-5`.

### Wijnkelder
- **Overzicht**: tegels met flessen, waarde, gemiddelde score, vrije plekken, wensenlijst en
  gedronken flessen, plus verdeling per kleur en land, hoogste scores, duurste flessen en wat
  binnenkort op moet.
- **Wijnen**: tabel met zoeken, filteren op kleur, sorteren en "ook op (0 flessen)".
- **Rekken**: meerdere rekken als raster; klik op een leeg vak om er een fles neer te leggen.
- **Kaart**: wereldkaart (Leaflet) met een bolletje per herkomstregio; optioneel ook wijnen die op zijn.
- **Wensenlijst**: met prioriteit, richtprijs en winkel; **Gekocht!** maakt er een wijn van.
- **Gegevens**: back-up downloaden of terugzetten (met foto's), voorbeelddata, alles wissen.
- Per wijn: alle gegevens, een eigen foto van het etiket en een flesafbeelding van Vivino
  (of een getekende fles in de juiste kleur).
- **Automatisch aanvullen** (knop ✨ in het wijnformulier):
  - *Gratis via je abonnement*: de app maakt een vraag die je in een chat op claude.ai plakt;
    het antwoord plak je terug.
  - *Direct* (alleen als de Claude-koppeling is ingesteld): de server stelt de vraag zelf, met
    zoeken op internet. Duurt 20 tot 60 seconden en kost een paar cent API-tegoed.
  - Nieuw ingevulde velden worden geel, vervangen velden oranje (muis erop toont de oude waarde).

### Financiën
- **Overzicht** per maand: saldo, inkomsten, uitgaven, wat er over is, aantal transacties zonder
  categorie, uitgaven per categorie, grootste uitgaven, saldo per rekening en een tabel per maand.
- **Transacties**: zoeken en filteren op maand, rekening en categorie; de categorie kies je direct
  in de tabel. Klik op een transactie om hem te bewerken. Met **Onthoud dit** komt de naam
  voortaan vanzelf in die categorie (er wordt een regel gemaakt).
- **Budget**: per categorie met budget hoeveel je deze maand hebt uitgegeven en nog over hebt;
  over budget staat er met ⚠ en tekst bij.
- **Importeren**: CSV (of TXT) uit je internetbankieren. **ING, Rabobank, ABN AMRO en bunq**
  worden herkend; bij andere banken kies je zelf welke kolom wat is. Je ziet eerst een voorbeeld.
  Transacties die er al in staan, worden overgeslagen; regels delen nieuwe transacties meteen in.
- **Instellingen**: rekeningen (met beginsaldo), regels ("bevat … → categorie"), categorieën
  (uitgaven, inkomsten of eigen overboeking) met budget per maand, back-up, voorbeelddata en alles wissen.
- Eigen overboekingen en sparen tellen niet mee als inkomsten of uitgaven.

## Twee manieren om een app te gebruiken

| | Via de server (`http://…`) | Als los bestand (`modules/<app>/index.html` openen) |
|---|---|---|
| Gegevens staan | Op de server, per gebruiker | In de browser (localStorage, foto's in IndexedDB) |
| Inloggen, portaal, koppelingen | Ja | Nee |
| Handig voor | Dagelijks gebruik | Snel een wijziging bekijken |

## Opbouw

```
server.py                 Start de webserver (alleen standaard-Python, plus anthropic voor de Claude-koppeling)
core/                     De kern:
  config.py                 paden en vaste waarden
  server.py                 webserver en API (inloggen, gebruikers, koppelingen, modules)
  users.py                  gebruikers, wachtwoorden, inlogcookies, rechten per module
  modules.py                laadt alle modules uit modules/
  storage.py                opslaan per module met versienummer en dagelijkse back-ups
  migration.py              zet gegevens van oudere versies om naar de huidige indeling
  vault.py                  versleutelt geheimen van koppelingen
  koppelingen/              één bestand per externe dienst (nu: claude.py)
gedeeld/blom.css          Gedeelde opmaak (knoppen, kaarten, tabellen, vensters, kopbalk)
gedeeld/blom.js           Gedeeld: API-aanroepen, login-controle, kopbalk, ModuleStore
portaal/                  Startscherm, inloggen, koppelingen, account, gebruikers
modules/wijnkelder/       module.py (foto's, direct aanvullen), index.html, css/, js/, img/
modules/financien/        module.py, index.html, css/, js/bankimport.js (bankbestanden), js/financien.js
requirements.txt          Python-pakketten (alleen anthropic)
Dockerfile                Container-image op basis van python:3.12-slim
.github/workflows/        Bouwt de container: bij main ook publiceren, bij dev alleen controleren
UNRAID.md                 Installeren en bijwerken op Unraid
```

Er is geen build-stap: gewone HTML, CSS en JavaScript, plus Leaflet via een CDN voor de kaart.

### Een nieuwe module toevoegen
1. Maak `modules/<id>/module.py` met `MODULE = {'id', 'name', 'icon', 'description', 'color', 'order'}`
   en eventueel `validate(data)` (controle bij opslaan) en `handle(request, method, rest, ctx)`
   (eigen API-adressen onder `/api/<id>/`).
2. Maak `modules/<id>/index.html` met `../../gedeeld/blom.css`, `../../gedeeld/blom.js` en een
   `<div id="blom-head">` in de kopbalk. Roep `Blom.start('<id>')` aan en sla op met `new ModuleStore('<id>')`.
3. Zet de module voor gebruikers aan onder **Gebruikers** in het portaal.

De kern regelt voor elke module `GET/PUT /api/<id>/data` (met versie, zodat apparaten elkaars werk
niet overschrijven) en dagelijkse back-ups.

### Een nieuwe koppeling toevoegen
1. Maak `core/koppelingen/<id>.py` met `CONNECTOR = {'id', 'name', 'description', 'scope': 'global'|'user',
   'used_by', 'fields': [...]}` en een functie `test(settings)`.
2. Zet de naam in `ORDER` in `core/koppelingen/__init__.py`.
3. Een module gebruikt hem met `koppelingen.require('<id>', ctx.user)`; het portaal toont hem vanzelf.

### Gegevens op de server
In de gegevensmap (in de container `/data`, op Unraid `/mnt/user/appdata/wijnkelder`):

```
users.json              gebruikers (wachtwoorden alleen als hash)
secret.key              sleutel die de inlogcookies ondertekent
koppelingen.key         sleutel waarmee geheimen van koppelingen worden versleuteld
koppelingen.json        koppelingen voor iedereen (geheimen versleuteld)
users/<id>/             alles van één gebruiker:
  koppelingen.json        persoonlijke koppelingen
  wijnkelder/             data.json, photos/, backups/ (elke dag een kopie, laatste 30 dagen)
  financien/              data.json, backups/
verwijderd/             gegevens van verwijderde gebruikers
```

Deze map staat nooit in git. Gegevens van een oudere versie (de losse wijnkelder) worden bij het
starten automatisch naar deze indeling verhuisd; er wordt daarbij niets overschreven.

## Ontwikkelen en live zetten

- **`dev`** is de werk-branch. Wijzigingen komen eerst hier. GitHub bouwt de container dan als
  controle, maar publiceert niets.
- **`main`** is wat er op de server draait. Bij elke push naar `main` bouwt GitHub Actions
  automatisch een nieuwe container (`ghcr.io/blomruben/blom-app:latest`).
- Op Unraid: **Docker → Check for Updates → apply update**. Zie [UNRAID.md](UNRAID.md).
- De code staat op [github.com/BlomRuben/blom-app](https://github.com/BlomRuben/blom-app) (tot 25 november 2026: `wijnkelder`).

Lokaal testen met de server:

```
pip install -r requirements.txt   # alleen nodig voor de Claude-koppeling
python server.py                  # standaard op poort 8080, gegevens in ./data
```

## Veiligheid

De app heeft een login, maar is bedoeld voor je thuisnetwerk, zeker nu er financiële gegevens in
staan. Zet de poort niet open in je router. Voor toegang van buitenaf gebruik je Tailscale, of een
Cloudflare Tunnel **met Cloudflare Access** ervoor.
