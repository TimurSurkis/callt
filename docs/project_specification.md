# Specyfikacja Projektu: Inteligentny Asystent Głosowy dla Warsztatów Samochodowych

---

## 1. Wprowadzenie i Cel Projektu (Executive Summary)

### 1.1. Kontekst Rynkowy

Warsztaty samochodowe, wulkanizacje oraz niezależne serwisy mechaniczne w Polsce borykają się z chronicznym problemem utraconych połączeń telefonicznych. W godzinach szczytu mechanicy mają zajęte ręce, pracują przy podnośnikach w hałasie lub obsługują klientów stacjonarnych. Każdy nieodebrany telefon od kierowcy to potencjalna strata od 150 do 1500+ PLN (wymiana klocków, serwis olejowy, diagnostyka, rozrząd).

### 1.2. Cel Projektu

Stworzenie dedykowanego asystenta głosowego opartego na zaawansowanym AI (ElevenLabs Conversational AI + dedykowany backend Node.js), który:

- Przejmuje połączenia przychodzące (szczególnie w trybie warunkowym: gdy linia jest zajęta, po 15 sekundach braku odpowiedzi lub po godzinach pracy).
- Prowadzi w 100% naturalny, płynny dialog w języku polskim.
- Błyskawicznie weryfikuje wolne sloty i zapisuje wizyty w Kalendarzu Google warsztatu.
- Obsługuje podstawowe pytania oraz weryfikację/odwołanie wizyty na podstawie numeru dzwoniącego (Caller ID).
- Zapewnia natychmiastowe powiadomienia dla załogi warsztatu za pośrednictwem bota na Telegramie.

---

## 2. Architektura Techniczna i Przepływ Danych

```
[Klient dzwoni]
       │
       ▼
[Operator Telco / SIP Trunk (Twilio / Zadarma)]
       │ (Przekierowanie warunkowe z telefonu warsztatu)
       ▼
[ElevenLabs Conversational AI]
   ├── STT (Transkrypcja mowy na tekst + słownik motoryzacyjny)
   ├── LLM (Orkiestracja rozmowy, system prompt, tool calling)
   └── TTS (Naturalny polski głos, niski latency)
       │
       ▼ (Webhook HTTPS / JSON POST)
[Backend Express.js (Node.js hosted on Render / Railway)]
   ├── Walidacja i normalizacja dat (resolveDate: "jutro", "w piątek" -> YYYY-MM-DD)
   ├── Obsługa Caller ID (autentykacja klienta po numerze telefonu)
   └── Integracja API
       ├── Google Calendar API (Service Account: odczyt wolnych slotów / rezerwacja)
       └── Telegram / WhatsApp / SMS notification
```

### 2.1. Komponenty Systemu

#### A. Warstwa Konwersacyjna (ElevenLabs Conversational AI)

- **Model językowy i głosowy:** Wykorzystanie silnika o skrajnie niskim opóźnieniu (Eleven Multilingual / Flash v2.5).
- **Konfiguracja audio:**
    - _Interruption Sensitivity (Barge-in):_ 0.65 – 0.70 (pozwala klientowi przerwać wypowiedź bota, ignorując drobny szum otoczenia).
    - _Silence Timeout:_ 7–8 sekund (zapobiega zrywaniu rozmowy przy naturalnym namyśle klienta).
    - _Max Call Duration:_ 180–240 sekund (twardy limit chroniący przed drenażem budżetu przez głuche telefony).
- **Custom Vocabulary (STT):** Wprowadzenie branżowego słownika (_rozrząd, klocki hamulcowe, zbieżność, półoś, wahacz, dwumasa, bezpiecznik, diagnostyka komputerowa_).

#### B. Warstwa Logiki Biznesowej (Node.js / Express API)

- **Moduł `resolveDate`:** Bezpieczny parser konwertujący zwroty potoczne na twarde znaczniki czasu ISO w strefie `Europe/Warsaw`.
- **Zarządzanie błędami:** Globalny `try/catch` na wszystkich webhookach narzędzi (Tools). W przypadku awarii zewnętrznego API backend zawsze zwraca kod HTTP 200 z czytelnym komunikatem zastępczym dla modelu, eliminując zrywanie połączenia WebRTC.
- **Autoryzacja Google:** Zastosowanie **Google Service Account** z kluczem w zmiennych środowiskowych, co eliminuje problem wygasania tokenów OAuth2.

---

## 3. Scenariusze Użycia Asystenta (Use Cases)

### UC-1: Rezerwacja nowego terminu

1. Klient dzwoni z zapytaniem o wymianę części/oleju.
2. Asystent pyta o dogodny dzień i porę.
3. Asystent wywołuje narzędzie `check_availability(date, time_range)`.
4. Backend analizuje kalendarz i zwraca wolne sloty (domyślny bufor: 60 minut na auto).
5. Klient akceptuje godzinę, podaje markę pojazdu i usterkę.
6. Asystent wywołuje `book_visit(date, time, client_name, car_info, problem)`.
7. Wpis pojawia się w Kalendarzu Google; Telegram wysyła powiadomienie do majstra.

### UC-2: Odwołanie lub zmiana terminu

1. Klient dzwoni z tego samego numeru.
2. Asystent przekazuje `caller_id` do backendu przy zapytaniu o status.
3. Backend odnajduje istniejący wpis powiązany z numerem telefonu.
4. Asystent potwierdza: _„Widzę Pana rezerwację na czwartek na 10:00. Chce Pan ją przesunąć czy odwołać?”_.
5. Wpis w kalendarzu zostaje zaktualizowany lub usunięty.

### UC-3: Odsiew pytań niestandardowych (Ochrona przed halucynacjami)

- W przypadku pytań o precyzyjną wycenę skomplikowanych napraw (np. remont silnika) asystent informuje, że ostateczny kosztorys ustala mechanik po wjechaniu na podnośnik i proponuje rezerwację terminu diagnostycznego.

---

## 4. Aspekty Prawne, Podatkowe i Bezpieczeństwo (Polska)

### 4.1. Forma Działalności: Działalność Nierejestrowana (NDG)

- **Ramy prawne:** Zgodnie z Prawem Przedsiębiorców działalność prowadzona bez rejestracji w CEIDG do limitu przychodu **75% minimalnego wynagrodzenia za pracę** miesięcznie (~3300–3500 PLN).
- **ZUS i Podatki:**
    - Brak comiesięcznych składek ZUS (społecznych i zdrowotnych).
    - Brak podatku VAT (zwolnienie podmiotowe na mocy art. 113 ust. 1 ustawy o VAT).
    - Rozliczenie roczne w deklaracji PIT-36 (zastosowanie kwoty wolnej od podatku 30 000 PLN).
- **Fakturowanie:** Wystawianie **Faktur bez VAT** z numerem PESEL i adresem zamieszkania (zgodnie z art. 106e ust. 5 ustawy o VAT).
- **Charakter umowy (Ochrona przed ZUS zleceniodawcy):** Umowa definiowana wyłącznie jako _„Dostęp do oprogramowania asystenta głosowego AI / Licencja SaaS”_, co wyklucza kwalifikację jako _Umowa zlecenia_ (brak ryzyka ozusowania warsztatu).

### 4.2. Wiek Twórcy (17 Lat) i Ważność Umów

- Osoba w wieku 17 lat posiada ograniczoną zdolność do czynności prawnych (art. 15 Kodeksu cywilnego).
- Rozwiązanie operacyjne: Do każdej umowy dołączana jest jednostronicowa **Zgoda przedstawiciela ustawowego (rodzica/opiekuna prawnego)** na zawarcie umowy handlowej. Zapewnia to pełną ważność prawną dokumentów bez konieczności angażowania sądu opiekuńczego.

### 4.3. Zgodność z RODO / GDPR

- **Role stron:**
    - Warsztat samochodowy = **Administrator Danych Osobowych (ADO)**.
    - Wykonawca (system AI) = **Podmiot Przetwarzający (Procesor)**.
- **Umowa Powierzenia Przetwarzania Danych (DPA):** Podpisywana jako załącznik do umowy głównej, regulujący przetwarzanie imion, numerów telefonów i numerów rejestracyjnych.
- **Konfiguracja ElevenLabs:**
    - Aktywacja trybu **Zero Data Retention** (wyłączenie trenowania modeli na rozmowach klientów).
    - Podpisanie elektronicznego DPA z ElevenLabs Inc.
- **Infolinia / Dyskrecja:** Krótki komunikat powitalny informujący o zautomatyzowanej obsłudze rezerwacji wizyty.

---

## 5. Model Biznesowy i Strategia Wdrożenia

### 5.1. Pakiety i Cennik

- **Okres pilotażowy:** 14 dni roboczych po konfiguracji agenta w 100% za darmo.
- **Model abonamentowy:** 350 – 490 PLN netto / miesiąc za punkt warsztatowy.
    - Obejmuje nielimitowane odbieranie połączeń w trybie przekierowania, integrację z kalendarzem i powiadomienia Telegram.
    - Koszty minutowe ElevenLabs / Twilio wliczane w ryczałt do określonego limitu (np. 150 minut miesięcznie).

### 5.2. Proces Onboardingu Warsztatu

1. **Wdrożenie kalendarza:** Przeniesienie papierowego zeszytu na dedykowany Kalendarz Google na telefonie właściciela i majstrów (instalacja widżetów na ekranie głównym). - W przypadku sukcesu projektu.
2. **Konfiguracja przekierowań:** Uruchomienie przekierowania warunkowego na karcie SIM telefonu warsztatowego:
    - Kod sieciowy: `*61*NUMER_BOTA**15#` (przekierowanie po 15 sekundach braku odbioru).
    - Kod sieciowy: `*67*NUMER_BOTA#` (przekierowanie gdy linia jest zajęta).
3. **Weryfikacja pilotażu:** Prezentacja raportu po 5 dniach (liczba uratowanych telefonów, lista zapisanych aut, wyliczona wartość zachowanych zleceń).
4. **Finalizacja:** Podpisanie papierowej umowy abonamentowej ze zgodą opiekuna.

---

## 6. Harmonogram i Kamienie Milowe

| Faza       | Zakres                     | Cel wyjściowy                                                                                    |
| :--------- | :------------------------- | :----------------------------------------------------------------------------------------------- |
| **Faza 1** | Backend + ElevenLabs Tools | Błyskawiczny zapis w kalendarzu bez błędów dat i zrywania połączeń.                              |
| **Faza 2** | Landing Page + Hosting     | Wdrożenie domeny, stabilnego serwera produkcyjnego, wgranie nagrań demo na www.                  |
| **Faza 3** | Telefonia + RODO           | Zakup polskiego numeru SIP (+48), wdrożenie polityki prywatności i zgód prawnych.                |
| **Faza 4** | Pilot projektu             | 5-dniowy test bojowy na warsztacie, zbieranie metryk, przejście na płatną subskrypcję.           |
| **Faza 5** | Skalowanie                 | Przejście do inkubatora (Twój StartUp) po osiągnięciu limitu NDG i ekspansja na kolejne serwisy. |
