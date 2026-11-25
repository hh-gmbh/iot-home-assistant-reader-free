# Home Assistant Reader free – Dokumentation

Der Reader zeigt ausgewählte Dashboards von Home Assistant im Browser an, nur zum Ansehen.
Er läuft als App neben Home Assistant und liefert eine eigene Weboberfläche auf Port 443 aus.
Der Browser spricht dabei nie direkt mit Home Assistant.

## Erste Schritte

1. App installieren und starten.
2. Den Reader im Browser unter `https://<Name des HA-Hosts>` öffnen. Solange noch kein Zertifikat
   vorliegt, ist er unter `http://<Name des HA-Hosts>:443` erreichbar.
3. Zertifikat einrichten (siehe unten). Der Reader schaltet danach von selbst auf HTTPS um.

Port 443 lässt sich unter **Konfiguration → Netzwerk** ändern, falls er auf dem Host schon belegt ist.

## Zertifikat (HTTPS)

Ohne Zertifikat läuft der Reader über HTTP und versucht es alle 10 Minuten erneut. Sobald ein
gültiges Paar aus Zertifikat und Schlüssel vorliegt, wechselt er ohne Neustart auf HTTPS.
Übernommen wird nur ein Paar, bei dem Zertifikat und privater Schlüssel zusammenpassen. Bei einem
Fehler bleibt das zuletzt gültige Zertifikat (Kopie in `/data/cert`) in Betrieb.

Das Zertifikat muss für den Namen ausgestellt sein, unter dem Sie den Reader aufrufen.
Dieser Name muss im DNS auf die IP-Adresse des Home-Assistant-Hosts zeigen.

### Quelle „local“: Dateien aus `/ssl`

Für Zertifikate, die schon auf dem Home-Assistant-Host liegen, zum Beispiel von der
Let's-Encrypt-App:

```yaml
cert_source: local
local_fullchain: /ssl/fullchain.pem
local_privkey: /ssl/privkey.pem
```

### Quelle „sftp“: Abholung von einem Server

Der Reader holt `fullchain.pem` und `privkey.pem` per SFTP. Die Anmeldung erfolgt nur per
SSH-Schlüssel, nie mit Passwort.

1. **App einmal starten.** Beim ersten Start erzeugt der Reader ein eigenes ed25519-Schlüsselpaar
   (in `/data/zertabholung_ed25519`) und schreibt den öffentlichen Schlüssel ins Protokoll:
   `ssh-ed25519 AAAA… home-assistant-reader zertabholung`. Dieselbe Zeile steht auch unter `/api/health`.
2. **Öffentlichen Schlüssel auf dem Server eintragen,** in `~/.ssh/authorized_keys` des
   SFTP-Benutzers. Am besten ist dieser Benutzer auf SFTP beschränkt und hat nur Lesezugriff auf
   die beiden Dateien. Die Zeile bitte aus dem Protokoll kopieren, nicht abtippen.
3. **Hostschlüssel des Servers eintragen** (`sftp_host_key`). Ohne diesen Eintrag verbindet sich
   der Reader nicht. Ermitteln lässt er sich zum Beispiel so:
   ```bash
   ssh-keyscan -t ed25519 <server>
   ```
   Angenommen werden die ganze Zeile (`192.0.2.10 ssh-ed25519 AAAA…`), `ssh-ed25519 AAAA…` oder nur
   der Base64-Teil `AAAA…`. Bei unbrauchbarem Format sagt das Protokoll, was nicht passt.
4. **Server, Benutzer und Pfade eintragen:**
   ```yaml
   cert_source: sftp
   sftp_host: 192.0.2.10
   sftp_port: 22
   sftp_user: reader
   sftp_host_key: "ssh-ed25519 AAAA…"
   sftp_fullchain_path: /fullchain.pem
   sftp_privkey_path: /privkey.pem
   ```

Abgeholt wird beim Start und danach alle `cert_refresh_hours` Stunden (Standard 24). Ein neues
Zertifikat wird ohne Neustart übernommen.

**Hinweis bei einer Neuinstallation:** Die App erzeugt dann ein neues Schlüsselpaar. Den neuen
öffentlichen Schlüssel auf dem Server eintragen, den alten dort entfernen.

## Optionen

| Option | Bedeutung |
|---|---|
| `hostname` | Name, unter dem der Reader aufgerufen wird. Erscheint im Protokoll; das Zertifikat muss dafür gelten. |
| `cert_source` | `sftp` oder `local` (siehe oben) |
| `sftp_host`, `sftp_port`, `sftp_user` | SFTP-Server, Port, Benutzer |
| `sftp_host_key` | Hostschlüssel des SFTP-Servers (Pflicht für `sftp`) |
| `sftp_fullchain_path`, `sftp_privkey_path` | Pfade der Dateien auf dem Server |
| `local_fullchain`, `local_privkey` | Pfade unter `/ssl` für `local` (auch Ausweichquelle bei `sftp`) |
| `cert_refresh_hours` | Abstand der Abholung in Stunden (1–168) |
| `log_level` | vorgesehen für die Ausführlichkeit des Protokolls, derzeit noch ohne Wirkung |
| `betreiber_name`, `betreiber_anschrift`, `betreiber_kontakt`, `betreiber_zusatz` | Ihre Angaben als Betreiber für das Impressum (siehe unten) |
| `betreiber_datenschutz_url` | optionaler Link (https://…) auf Ihre eigene Datenschutzerklärung |

## Was dargestellt wird

Siehe Reiter **Info**: dort stehen die unterstützten Karten. Nicht unterstützte Karten erscheinen
als Platzhalter mit ihrem Typnamen. Dashboards ohne darstellbaren Inhalt werden ausgeblendet; ein
Rufzeichen rechts oben in der Kopfzeile zeigt, welche das sind.

## Datenschutz und Sicherheit

- Nur lesend: Der Reader schickt nur lesende Anfragen an Home Assistant, Befehle wie `call_service`
  sind gesperrt.
- An den Browser gehen nur die Werte der Karten des gewählten Dashboards. Markdown-Karten rendert
  Home Assistant, der Browser erhält nur den fertigen Text.
- Keine Cookies, kein Browserspeicher, keine Zugriffsprotokolle, keine Inhalte von fremden Servern.
- In der free-Version gibt es keine Anmeldung: Zugriff hat, wer den Reader im Netz erreicht.

## Impressum und Datenschutz

Die Seite des Readers ist Ihr Angebot: Sie als Betreiber sind für Impressum und Datenschutz
verantwortlich, nicht die Hammerherren GmbH als Herstellerin der Software.

- **Impressum:** Tragen Sie Ihre Angaben unter `betreiber_…` ein. Ohne Namen zeigt der Reader
  keinen Impressum-Link an. Ob Sie ein Impressum brauchen, hängt davon ab, wem Sie die Seite
  zugänglich machen.
- **Datenschutz:** Der Hinweis nennt Sie als Verantwortlichen und beschreibt, wie die unveränderte
  Software mit Daten umgeht. Mit `betreiber_datenschutz_url` verlinken Sie zusätzlich Ihre eigene
  Datenschutzerklärung.
- **Über diese Software:** Herstellerin, Version, Lizenz und fremde Bestandteile.
- **Fehler melden:** Link auf den Bugtracker der Hammerherren GmbH (neuer Tab).

Alle Punkte stehen in der Fußzeile des Readers, direkt aufrufbar unter `#impressum`, `#datenschutz` und `#ueber`. Ihre Angaben werden nur als Text angezeigt.
