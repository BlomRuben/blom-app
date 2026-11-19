# 🍷 Wijnkelder

Een eenvoudige web-app om een wijnkelder bij te houden: welke flessen je hebt, waar ze
in je rekken liggen, wat ze waard zijn en waar ze vandaan komen. De app draait als
Docker-container op een Unraid-server, maar kan ook als los bestand in de browser.

*Deze README beschrijft de huidige staat van de app en wordt bij elke wijziging bijgewerkt.*

## Wat de app kan

| Tab | Wat je er ziet en doet |
|---|---|
| **Overzicht** | Tegels met het aantal flessen, de totale waarde, de gemiddelde score, de vrije plekken in de rekken, de wensenlijst en het aantal gedronken flessen. Daaronder een verdeling per kleur en per land, de hoogste scores, de duurste flessen en wat binnenkort op moet. |
| **Wijnen** | Alle wijnen in een tabel, met zoeken, filteren op kleur, sorteren en de optie "ook op (0 flessen)". Klik op een wijn voor de details. |
| **Rekken** | Meerdere rekken als raster. Klik op een leeg vak om er een fles neer te leggen, of op een fles voor de details. Rekken kun je toevoegen, bewerken en verwijderen. |
| **Kaart** | Een wereldkaart (Leaflet) met een bolletje per herkomstregio, met de grootte naar het aantal flessen en de kleur naar de wijnkleur. Met een vinkje toon je ook wijnen die op zijn (lichte bolletjes). |
| **Wensenlijst** | Wijnen die je nog wilt kopen, met prioriteit, richtprijs en winkel. Met **Gekocht!** wordt een wens een wijn in je kelder. |
| **Gegevens** | Een back-up downloaden of terugzetten (inclusief foto's), voorbeelddata laden, alles wissen en **Je account** (wachtwoord wijzigen). Een admin ziet hier ook het blok **Gebruikers**. |

### Per wijn
- Naam, producent, jaargang, kleur, druif, land, regio, aantal flessen, aankoopprijs,
  huidige waarde, score met bron, drinkvenster, notities, de Vivino-pagina en een link naar een flesfoto.
- **Eigen foto** van het etiket, en een **flesafbeelding** van Vivino. Is er geen afbeelding,
  dan tekent de app zelf een fles in de juiste kleur.
- Het detailvenster sluit je met **Esc** of door ernaast te klikken.

### Automatisch aanvullen via Claude
Je hoeft geen API-sleutel of tegoed te hebben: het werkt met je gewone Claude-abonnement.
1. Vul de naam (en jaargang) in, of kies een foto van het etiket.
2. Klik op **✨ Automatisch aanvullen**. De app maakt een kant-en-klare vraag.
3. Kopieer eerst eventueel de foto en daarna de vraag, en plak ze in een chat op claude.ai.
4. Plak het antwoord (een JSON-blok) terug in de app en klik op **Invullen**.

Velden die nieuw zijn ingevuld, worden **geel**. Velden waarvan een bestaande waarde is vervangen,
worden **oranje**; houd de muis erop om de oude waarde te zien.

### Inloggen en gebruikers (alleen via de server)
- Bij het eerste bezoek maak je een **admin-account** aan.
- **Iedere gebruiker heeft een eigen kelder** en ziet alleen de eigen wijnen.
- De admin beheert gebruikers onder **Gegevens → Gebruikers**: toevoegen, rol wijzigen
  (admin of gebruiker), een nieuw wachtwoord instellen en verwijderen.
  De kelder van een verwijderde gebruiker wordt niet gewist maar apart gezet.
- Wachtwoorden worden alleen als hash opgeslagen (PBKDF2). Je blijft 30 dagen ingelogd.
  Na 10 foute pogingen binnen een kwartier volgt een blokkade.

## Twee manieren om de app te gebruiken

| | Via de server (`http://…`) | Als los bestand (`index.html` openen) |
|---|---|---|
| Gegevens staan | Op de server, per gebruiker | In de browser (localStorage en IndexedDB) |
| Zelfde kelder op elk apparaat | Ja | Nee |
| Inloggen | Ja | Nee |
| Handig voor | Dagelijks gebruik | Snel een wijziging bekijken |

De app kiest dit zelf op basis van hoe hij geopend is.

## Opbouw

```
index.html          De pagina met alle tabs en vensters
css/style.css       Opmaak (kleuren als variabelen bovenaan)
img/chianti.jpg     Achtergrond: Chianti-wijngaarden bij Castellina in Chianti
                    (foto Rowan Heuvel, CC0, via Wikimedia Commons)
js/storage.js       Opslag: via de server of in de browser, en de foto's
js/auth.js          Inloggen, eigen wachtwoord en gebruikersbeheer
js/ai.js            De vraag voor Claude maken en het antwoord inlezen
js/regions.js       Wijnlanden en -regio's met coördinaten voor de kaart
js/sample.js        Voorbeelddata
js/app.js           De rest van de app: schermen, formulieren, rekken, kaart
server.py           Webserver (alleen standaard Python): app, API, login, back-ups
Dockerfile          Container-image op basis van python:3.12-alpine
.github/workflows/  Bouwt bij elke push naar main de container op ghcr.io
UNRAID.md           Installeren en bijwerken op Unraid
```

Er is geen build-stap en er zijn geen pakketten nodig: gewone HTML, CSS en JavaScript,
plus Leaflet via een CDN voor de kaart.

### Gegevens op de server
In de gegevensmap (in de container `/data`, op Unraid `/mnt/user/appdata/wijnkelder`):

```
users.json              gebruikers (wachtwoorden alleen als hash)
secret.key              sleutel die de inlogcookies ondertekent
users/<id>/             de kelder van één gebruiker:
  wijnkelder.json         wijnen, rekken en wensenlijst
  photos/                 eigen foto's
  backups/                elke dag een kopie, de laatste 30 dagen
verwijderd/             kelders van verwijderde gebruikers
```

Deze map staat nooit in git: je wijnen en accounts komen niet op GitHub.

## Ontwikkelen en live zetten

- **`dev`** is de werk-branch. Wijzigingen komen eerst hier.
- **`main`** is wat er op de server draait. Bij elke push naar `main` bouwt GitHub Actions
  automatisch een nieuwe container (`ghcr.io/blomruben/wijnkelder:latest`).
- Op Unraid: **Docker → Check for Updates → apply update**. Zie [UNRAID.md](UNRAID.md).

Lokaal testen met de server:

```
python server.py        # standaard op poort 8080, gegevens in ./data
```

## Veiligheid

De app heeft een login, maar is bedoeld voor je thuisnetwerk. Zet de poort niet open in je
router. Voor toegang van buitenaf gebruik je Tailscale, of een Cloudflare Tunnel **met
Cloudflare Access** ervoor.
