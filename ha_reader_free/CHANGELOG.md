# Changelog – Home Assistant Reader free

## 1.1.12

- Behoben: Nach einem Neustart von Home Assistant blieb die Anzeige dauerhaft bei „Keine Verbindung zu Home
  Assistant“. Der Supervisor nimmt während des Neustarts Verbindungen an, ohne je zu antworten; der Reader wartete
  darauf unbegrenzt. Jetzt gilt eine Frist von 20 s für Aufbau und Anmeldung, danach wird neu verbunden.
- Bestehende Verbindungen werden alle 30 s mit einem Lebenszeichen („ping“, kein Datenzugriff) geprüft; bleibt die
  Antwort aus, wird die Verbindung neu aufgebaut.
- Das Protokoll nennt jetzt den Grund einer Trennung.

## 1.1.11

- Das Architekturbild auf der Info-Seite wird jetzt auch auf GitHub angezeigt.

## 1.1.10

- Die Option „Betrieben von“ entfällt wieder. Die Fußzeile richtet sich nach dem eingetragenen Namen des Betreibers im Impressum.

## 1.1.9

- Neue Fußzeile: links Produkt, Version und „Software von Hammerherren GmbH“, rechts Impressum, Datenschutz, Über diese Software und „Fehler melden“.
- Auf schmalen Bildschirmen steht der Herstellerblock über den Links.
- „Über diese Software“ ist direkt unter `#ueber` erreichbar.

## 1.1.8

- Neuer Link „Bugs?“ in der Fußzeile.

## 1.1.7

- Vollständige Lizenzbedingungen, mit der App ausgeliefert und unter „Über diese Software“ verlinkt.

## 1.1.6

- Ist die Hammerherren GmbH selbst als Betreiber eingetragen, entfallen die Hinweise, dass die Herstellerin diese Seite nicht betreibt.

## 1.1.5

- Impressum mit Ihren Angaben als Betreiber: neue Optionen `betreiber_…`. Ohne Angaben erscheint kein Impressum.
- Datenschutzhinweis nennt Sie als Betreiber als Verantwortlichen und beschreibt, wie die unveränderte Software mit Daten umgeht. Optional mit Link auf Ihre eigene Datenschutzerklärung.
- „Nutzungsbedingungen“ heißen jetzt „Über diese Software“: Herstellerin, Version, Lizenz und fremde Bestandteile.

## 1.1.4

- Neutrale Voreinstellungen für Neuinstallationen (Zertifikatsquelle `local`, kein vorbelegter SFTP-Server). Bestehende Einstellungen bleiben unverändert.
- Ein vorhandener Schlüssel für die Zertifikatsabholung wird übernommen; er muss nicht neu auf dem Server eingetragen werden.

## 1.1.3

- Erste Release Version
