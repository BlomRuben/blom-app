# Blom App op Unraid

De app draait op je Unraid-server in een Docker-container. Je gegevens, foto's en
back-ups staan op de server, dus je ziet op elk apparaat hetzelfde.

> De repo en de image heten sinds 25 november 2026 `blom-app` (eerst `wijnkelder`). De
> appdata-map heet nog `wijnkelder`; dat werkt gewoon, de app let niet op die naam.

## Overstappen naar de nieuwe image-naam (eenmalig)
De oude image `ghcr.io/blomruben/wijnkelder` krijgt geen updates meer. Zo zet je je container over:
1. Unraid → **Docker** → klik op het icoon van de container → **Edit**.
2. Zet **Repository** op `ghcr.io/blomruben/blom-app:latest`.
3. Wil je de container ook anders noemen, zet **Name** dan op `blom-app`.
4. Laat het **Path** naar `/mnt/user/appdata/wijnkelder` en de **Port** staan zoals ze zijn.
5. Klik op **Apply**. Unraid haalt de nieuwe image op en start de container opnieuw; je gegevens blijven staan.

## Hoe het in elkaar zit

```
pc (Claude past de app aan)
  → git push naar GitHub
    → GitHub bouwt automatisch een container-image (ghcr.io)
      → Unraid haalt de nieuwe image op ("Update")
```

| Onderdeel | Waar |
|---|---|
| De code | [github.com/BlomRuben/blom-app](https://github.com/BlomRuben/blom-app) (openbaar) |
| De container-image | `ghcr.io/blomruben/blom-app` |
| Je gegevens, foto's, sleutels en dagelijkse kopieën | Unraid: `/mnt/user/appdata/wijnkelder` |

Je gegevens komen **nooit** op GitHub: ze staan alleen op Unraid, en `.gitignore`
houdt een lokale `data/`-map buiten git.

In de appdata-map:

| Bestand of map | Wat |
|---|---|
| `users.json` | accounts (wachtwoorden alleen als hash) |
| `secret.key` | ondertekent de inlogcookies; niet delen |
| `koppelingen.key` | versleutelt de sleutels van koppelingen; niet delen |
| `koppelingen.json` | koppelingen voor iedereen (sleutels versleuteld) |
| `users/<code>/wijnkelder/` | `data.json` (wijnen, rekken, wensenlijst), `photos/`, `backups/` |
| `users/<code>/financien/` | `data.json` (rekeningen, transacties, categorieën, regels), `backups/` |
| `users/<code>/koppelingen.json` | persoonlijke koppelingen van die gebruiker |
| `verwijderd/` | gegevens van verwijderde gebruikers |

De `<code>` van een gebruiker staat in `users.json`.

## Overstap van de losse wijnkelder naar de Blom App

Bij de eerste start van de nieuwe versie verhuist de app je kelder automatisch:
`users/<code>/wijnkelder.json`, `photos/` en `backups/` gaan naar `users/<code>/wijnkelder/`.
Er wordt niets overschreven. In het log staat dan bijvoorbeeld
`Kelder van ruben verhuisd naar de module wijnkelder`.

- Bestaande gebruikers houden hun login en krijgen de app **Wijnkelder**. **Financiën** zet je
  als admin per gebruiker aan onder **Gebruikers** in het portaal (een admin heeft alles).
- Je moet één keer opnieuw inloggen: het inlogcookie heeft een nieuwe naam.
- `http://<server>:8080/` opent nu het portaal; de wijnkelder staat op `/modules/wijnkelder/`.
- Zekerheid vooraf: maak in de oude versie een **Back-up downloaden** onder Gegevens, en/of laat
  **Appdata Backup** draaien.

## Eenmalig: installeren

### 1–3. GitHub (al gedaan)
De repo [BlomRuben/blom-app](https://github.com/BlomRuben/blom-app) bestaat, is
gekoppeld aan deze map (via de GitHub-tool `gh`, ingelogd als BlomRuben), en de
image is openbaar op te halen.

### 4. De container aanmaken
Unraid → **Docker** → **Add Container**:

| Veld | Waarde |
|---|---|
| Name | `blom-app` |
| Repository | `ghcr.io/blomruben/blom-app:latest` |
| Network Type | `Bridge` |
| WebUI | `http://[IP]:[PORT:8080]/` |

Daaronder via **Add another Path, Port, Variable, Label or Device**:

| Type | Name | Container | Host |
|---|---|---|---|
| Port | Web | `8080` | `8080` (of een andere vrije poort) |
| Path | Gegevens | `/data` | `/mnt/user/appdata/wijnkelder` |

Klik op **Apply** en open `http://<ip-van-je-server>:8080`.
Lukt het niet, kijk dan in het Docker-tabblad bij de container naar **Logs**.
Daar hoort te staan: `Blom App draait op poort 8080, gegevens in /data` en
`Modules: wijnkelder, financien`.

## Inloggen, gebruikers en koppelingen
- **Eerste keer** (lege appdata-map): de app vraagt je een admin-account aan te maken. Doe dat
  meteen: wie dit scherm als eerste invult, wordt admin.
- **Gebruikers toevoegen:** portaal → **Gebruikers**. Vink per gebruiker aan welke apps die mag
  gebruiken. Iedere gebruiker heeft eigen gegevens.
- **Eigen wachtwoord wijzigen:** portaal → **Je account**.
- **Wachtwoord vergeten:** een admin kan bij **Gebruikers → Bewerken** een nieuw wachtwoord
  instellen. Na een wachtwoordwijziging worden andere apparaten uitgelogd.
- **Koppelingen:** portaal → **Koppelingen**. Vul de gegevens in, **Opslaan**, en dan
  **Verbinding testen**. Voor Claude heb je een API-sleutel van platform.claude.com nodig.
- **Gebruiker verwijderd:** de gegevens worden niet gewist maar apart gezet in `verwijderd/`.
- **Alle accounts kwijt?** Stop de container, verwijder `users.json` uit de appdata-map en start
  opnieuw: dan verschijnt het instelscherm weer. De gegevens in `users/` blijven staan, maar horen
  bij de oude codes; zet ze zo nodig zelf in de map van het nieuwe account.
- **`koppelingen.key` kwijt?** Dan kan de app de opgeslagen sleutels niet meer lezen. Stel de
  koppelingen opnieuw in.
- Na 10 foute pogingen binnen een kwartier weigert de app verdere pogingen vanaf dat apparaat.

## Een nieuwe versie zetten (na wijzigingen met Claude)
1. Claude legt de wijziging vast in git op `dev`. GitHub controleert dan of de container bouwt
   (zonder iets te publiceren).
2. Als je tevreden bent: `dev` samenvoegen in `main` en pushen.
3. Wacht op het groene vinkje bij **Actions** op GitHub.
4. Unraid → **Docker** → **Check for Updates** → bij de container op **apply update** klikken.
   Automatisch kan ook: installeer de plugin **CA Auto Update Applications**.

Je gegevens blijven staan: die zitten in appdata, niet in de container.

### Terug naar een eerdere versie
Elke versie heeft ook een eigen code (de commit-code, te zien bij **Actions**).
Zet in Unraid bij Repository `ghcr.io/blomruben/blom-app:<commit-code>` in
plaats van `:latest`. Zet het later terug op `:latest` om weer mee te gaan met updates.
Versies van vóór 25 november 2026 staan onder de oude naam `ghcr.io/blomruben/wijnkelder:<commit-code>`.
Let op: een versie van vóór de Blom App kent de nieuwe indeling van de appdata-map niet.
Ga je zo ver terug, zet dan ook een back-up van de appdata-map terug.

## Onderweg gebruiken
Zet poort 8080 **niet** open in je router: via gewoon `http://` gaat je wachtwoord
onversleuteld over het internet, en er staan nu ook financiële gegevens in de app.
Gebruik in plaats daarvan **Tailscale**: installeer de Tailscale-plugin op Unraid en
de Tailscale-app op je telefoon. Dan bereik je de app overal via het Tailscale-adres
van je server, alleen jij (Tailscale versleutelt de verbinding).

Tip: via gewoon `http://` mag de browser niet bij je klembord voor foto's, dus
"Kopieer de foto" in de wijnkelder werkt dan niet (de vraag kopiëren wel). Sleep de foto dan
zelf in de chat, gebruik "Direct aanvullen" via de Claude-koppeling, of zet in Tailscale HTTPS
aan (`tailscale serve`) om een `https://`-adres te krijgen.

## Back-ups
- De server bewaart per gebruiker per app elke dag een kopie in
  `users/<code>/<app>/backups/` (de laatste 30 dagen).
  Terugzetten: stop de container, kopieer de gewenste kopie (via de Unraid-terminal) naar
  `/mnt/user/appdata/wijnkelder/users/<code>/<app>/data.json` en start de container.
- De Unraid-plugin **Appdata Backup** neemt de hele gegevensmap automatisch mee.
- Extra zekerheid: af en toe **Back-up downloaden** in de app (wijnkelder: onder Gegevens,
  inclusief foto's; financiën: onder Instellingen).
