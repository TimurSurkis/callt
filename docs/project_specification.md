# Specyfikacja Projektu: Inteligentny Asystent Głosowy dla Warsztatów Samochodowych (Gloso)

Źródłem prawdy dla warunków świadczenia usługi jest [`regulamin.html`](../regulamin.html) (wersja 1.2 z dnia 19.11.2026 r.). W razie rozbieżności między Regulaminem a indywidualną umową pierwszeństwo ma umowa. Dokument opisuje docelową implementację, ramy prawno-biznesowe oraz zakres Etapu 1 (MVP), a nie potwierdzenie produkcyjnego uruchomienia wszystkich integracji. Szczegółowa architektura techniczna Etapu 1 znajduje się w `Architecture.md`.

---

## 1. Wprowadzenie i Cel Projektu (Executive Summary)

### 1.1. Kontekst Rynkowy

Warsztaty samochodowe, wulkanizacje oraz niezależne serwisy mechaniczne w Polsce borykają się z chronicznym problemem utraconych połączeń telefonicznych. W godzinach szczytu mechanicy mają zajęte ręce, pracują przy podnośnikach w hałasie lub obsługują klientów stacjonarnych. Każdy nieodebrany telefon od kierowcy to potencjalna strata od 150 do 1500+ PLN (wymiana klocków, serwis olejowy, diagnostyka, rozrząd).

### 1.2. Cel Projektu

Stworzenie dedykowanego asystenta głosowego opartego na AI (ElevenLabs Conversational AI + LLM z listy zatwierdzonej w DPA + backend Node.js / TypeScript / Express na Northflank + PostgreSQL / Drizzle ORM na Neon w EOG), który:

- Przejmuje nieodebrane połączenia przychodzące oraz połączenia przy zajętej linii (w godzinach pracy i po zamknięciu) po upływie skonfigurowanego czasu oczekiwania – domyślnie ok. **10 sekund**, z zastrzeżeniem parametrów technicznych przekierowania po stronie operatora telekomunikacyjnego warsztatu. Po zamknięciu proponuje wizyty wyłącznie w dopuszczonych godzinach (Tryb Kalendarza) albo przyjmuje zgłoszenia (Relay).
- Prowadzi naturalny, płynny dialog w języku polskim z zachowaniem wymogów transparentności AI Act (art. 50) i RODO (art. 13).
- W **Trybie Kalendarza** weryfikuje wolne sloty w jednym podłączonym Google Calendar (z uwzględnieniem pełnego czasu trwania wybranej usługi) i zapisuje potwierdzone wizyty. W **Trybie Zgłoszeniowym (Relay)** – także przy chwilowej niedostępności kalendarza – zbiera dane i preferowany termin, a następnie przekazuje zgłoszenie warsztatowi bez wiążącej rezerwacji i bez kalendarza cieniowego.
- Działa w architekturze **minimalizacji danych (Zero-PII w bazie Operatora)**: baza danych nie przechowuje zgłoszeń, rezerwacji, danych dzwoniących ani tekstów SMS – zapisuje wyłącznie konfigurację warsztatów, stan pilotażu/minut, dane techniczne deduplikacji oraz zaszyfrowane, pozbawione danych identyfikujących audyty techniczne (retencja maks. 30 dni).
- Wysyła wszystkie powiadomienia operacyjne do jednego wskazanego pracownika warsztatu **wyłącznie SMS-em z serwisu Gloso przez SMSAPI**. Powiadomienia operacyjne nie są wysyłane e-mailem ani do osób dzwoniących.

### 1.3. Rynek docelowy

- **Etap początkowy:** autoserwisy i warsztaty mechaniczne w Polsce (start: Kielce).
- **Rozszerzenie:** po potwierdzeniu powodzenia projektu – inne nisze lokalnych usług.

---

## 2. Architektura Techniczna i Przepływ Danych (Etap 1)

```
[Klient dzwoni]
       │
       ▼
[Operator Telco / SIP Trunk (Zadarma – dedykowany numer dla warsztatu)]
       │ (Nieodebrane / zajęte, także po zamknięciu: AI po ok. 10 s)
       ▼
[ElevenLabs Conversational AI + LLM (OpenAI / Anthropic / Google – bez trenowania)]
   ├── Komunikat startowy (AI Act art. 50 + RODO art. 13)
   ├── STT (Transkrypcja mowy na tekst + słownik motoryzacyjny)
   ├── LLM (Orkiestracja rozmowy, system prompt, tool calling)
   └── TTS (Naturalny polski głos, niski latency)
       │
       ▼ (Webhook / Tool Calls HTTPS JSON POST)
[Backend Node.js / TypeScript / Express (lokalnie -> Northflank, UK)]
   ├── API Layer: Routing, Auth Middleware, Zod Validation, Controllers
   ├── Business Logic Layer: Tenant Resolver, resolveDate, Slot Calculation Engine,
   │                         Booking Manager, Relay Handler, Pilot & Usage Limit
   ├── Data Access Layer: Drizzle ORM -> PostgreSQL (lokalnie -> Neon, EOG)
   │     (Tenants & Worktime, Services, Pilot & Usage, Encrypted Audit Logs 30d)
   └── Infrastructure Layer:
         ├── Calendar Adapter -> Google Calendar API (Service Account, tylko Tryb Kalendarza)
         ├── SMS Adapter -> SMSAPI (LINK Mobility Poland – 1 wskazany pracownik)
         └── Events Adapter -> Zdarzenia telefonii / ElevenLabs
```

### 2.1. Komponenty Systemu

#### A. Warstwa Konwersacyjna (ElevenLabs Conversational AI)

- **Model językowy i głosowy:** Silnik o niskim opóźnieniu (Eleven Multilingual / Flash v2.5) + LLM wybrany z listy zatwierdzonej w DPA (OpenAI / Anthropic / Google) z wyłączonym trenowaniem na danych klientów. W Etapie 1 każdy warsztat posiada własnego agenta ElevenLabs i własny numer docelowy Zadarma.
- **Konfiguracja audio:**
    - _Interruption Sensitivity (Barge-in):_ 0.65 – 0.70.
    - _Silence Timeout:_ 7–8 sekund.
    - _Max Call Duration:_ 180–240 sekund (ochrona przed drenażem budżetu przez głuche telefony).
- **Custom Vocabulary (STT):** Słownik branżowy (_rozrząd, klocki hamulcowe, zbieżność, półoś, wahacz, dwumasa, bezpiecznik, diagnostyka komputerowa_).

#### B. Warstwa Logiki Biznesowej (Node.js / TypeScript / Express + Drizzle + Zod)

- **Moduł `resolveDate`:** Przed każdym sprawdzeniem dostępności konwertuje zwroty potoczne na zakresy ISO 8601 w strefie `Europe/Warsaw`. Zwraca dostępne sloty z `start_at`, `end_at` i zabezpieczonym `slot_id` (czas trwania równy pełnej długości wybranej usługi z konfiguracji). Przy zapisie używany jest ten sam `slot_id` bez ponownej interpretacji dat względnych.
- **Zaufany kontekst połączenia:** `Tenant Resolver` wyznacza warsztat na podstawie zaufanego numeru docelowego i identyfikatora agenta; `workshop_id` ani numer telefonu nie mogą zostać nadpisane przez model. Przy ukrytym Caller ID dopuszczalna jest wyłącznie obsługa z numerem podanym ustnie, oznaczonym jako **niezweryfikowany**.
- **Stan i Minimalizacja Danych:** PostgreSQL (Neon, EOG) poprzez Drizzle ORM przechowuje konfigurację warsztatów, usługi, harmonogramy, stan pilotażu/minut, klucze idempotencji oraz zaszyfrowane, pozbawione danych identyfikujących audyty techniczne (retencja 30 dni). Zgłoszenia, dane wizyt, teksty SMS, nagrania i transkrypcje **nie są zapisywane w bazie danych**.
- **Autoryzacja Google:** Google Service Account (klucz przechowywany poza repozytorium w zmiennych środowiskowych).

---

## 3. Scenariusze Użycia Asystenta (Use Cases)

### UC-1: Rezerwacja nowego terminu (Tryb Kalendarza – Etap 1)

1. Klient dzwoni; po komunikacie początkowym (AI Act + RODO) podaje potrzebę i preferowany dzień/porę. Dla nieznanej usługi asystent proponuje diagnostykę zgodnie z konfiguracją warsztatu.
2. Asystent wywołuje narzędzie sprawdzania terminów -> backend uruchamia `resolveDate` i sprawdza Google Calendar w `Europe/Warsaw`, uwzględniając godziny pracy i **pełny czas trwania wybranej usługi**, zwracając wolne sloty (`slot_id`, `start_at`, `end_at`).
3. Po wyborze terminu i zebraniu danych obowiązkowych (**imię, telefon, marka/model pojazdu, opis problemu, wybrany termin**; nazwisko i nr rejestracyjny nie są obowiązkowe) asystent wywołuje zapis wizyty z `slot_id`. Backend ponownie weryfikuje dostępność slotu.
4. Dopiero po potwierdzonym zapisaniu w Google Calendar asystent potwierdza wizytę, a jeden wskazany pracownik warsztatu otrzymuje SMS od Gloso przez SMSAPI. Błąd SMS nie anuluje zapisanej wizyty.

### UC-1R: Przyjęcie zgłoszenia (Tryb Relay oraz fallback – Etap 1)

1. Stosowany dla warsztatów bez kalendarza cyfrowego oraz awaryjnie przy niedostępności Google Calendar.
2. Asystent zbiera dane obowiązkowe i preferowany termin (bez sprawdzania kalendarza i bez tworzenia rezerwacji).
3. Wyraźnie informuje rozmówcę, że to zgłoszenie wymagające potwierdzenia przez warsztat.
4. Backend wysyła wskazanemu pracownikowi warsztatu SMS przez SMSAPI bez zapisywania treści zgłoszenia w bazie danych. Dalszy kontakt odbywa się poza systemem Gloso.

### UC-2: Odwołanie lub zmiana terminu (Faza 2 / Odłożone)

- _Funkcjonalność świadomie odłożona poza Etap 1 (MVP)._
- W Etapie 1 asystent przyjmuje wyłącznie nowe rezerwacje i zgłoszenia; zmiany i odwołania wizyt realizowane są bezpośrednio w kontakcie z warsztatem.
- W Fazie 2 planowana jest obsługa modyfikacji wyłącznie wydarzeń utworzonych przez Gloso, po weryfikacji dzwoniącego jednorazowym 6-cyfrowym kodem SMS (ważnym 5 minut, limit prób, bez zapisu jawnego kodu w logach).

### UC-3: Odsiew pytań niestandardowych (Ochrona przed halucynacjami)

- Przy pytaniach o precyzyjną wycenę skomplikowanych napraw asystent informuje, że wiążący kosztorys ustala mechanik i proponuje diagnostykę (Tryb Kalendarza) lub zgłoszenie (Relay).

---

## 4. Aspekty Prawne, Podatkowe i Bezpieczeństwo (Polska – stan prawny 2026/2027)

### 4.1. Forma Działalności: Działalność Nierejestrowana (NDG), VAT, KSeF i ZUS

- **Limit przychodu NDG od 1 stycznia 2026 r.:** Zgodnie ze znowelizowanym art. 5 ust. 1 ustawy – Prawo przedsiębiorców limit liczony jest **kwartalnie** i wynosi **225% minimalnego wynagrodzenia za pracę**. Przy płacy minimalnej w 2026 r. (4 806 zł brutto) limit wynosi **10 813,50 zł brutto przychodu należnego na kwartał** (liczy się przychód należny z wystawionych rachunków/faktur, nie tylko wpływy na konto). Dodatkowy warunek: brak prowadzenia działalności gospodarczej w ostatnich 60 miesiącach. Po przekroczeniu progu należy zarejestrować firmę w CEIDG w ciągu **7 dni**.
- **Podatek dochodowy (PIT):** Rozliczenie roczne w zeznaniu **PIT-36** (rubryka „Działalność nierejestrowana”, art. 20 ust. 1ba ustawy o PIT), bez miesięcznych zaliczek. Obowiązuje kwota wolna od podatku **30 000 zł** (uwaga: _Ulga dla młodych_ do 26. roku życia **nie obejmuje** przychodów z działalności nierejestrowanej).
- **Podatek VAT:** Zwolnienie podmiotowe z VAT na mocy art. 113 ust. 1 ustawy o VAT (od 1 stycznia 2026 r. limit sprzedaży wynosi **240 000 zł** rocznie).
- **Fakturowanie i obowiązkowy KSeF od 1 stycznia 2027 r.:**
    - Do 31 grudnia 2026 r. przy miesięcznej sprzedaży B2B nieprzekraczającej 10 000 zł brutto dopuszczalne jest wystawianie faktur bez VAT / rachunków poza KSeF.
    - **Od 1 stycznia 2027 r.** każda faktura wystawiana w relacji **B2B** (również przez osobę na NDG zwolnioną z VAT) podlega obowiązkowi wystawienia w **Krajowym Systemie e-Faktur (KSeF)**. System KSeF **nie obsługuje numeru PESEL** – wymaga numeru **NIP**. Aby legalnie wystawiać faktury B2B od stycznia 2027 r. bez zakładania firmy w CEIDG, Operator powinien złożyć wcześniej w urzędzie skarbowym zgłoszenie identyfikacyjne **NIP-7** (oraz rejestrację **VAT-R** jako _podatnik zwolniony z VAT_, co jest bezpłatne).
- **Ochrona warsztatu przed ZUS:**
    - Samo nazwanie umowy „Licencją SaaS” nie daje 100% gwarancji w razie kontroli ZUS, jeśli opłata obejmuje też wdrożenie, konfigurację i bieżące wsparcie (ZUS może kwalifikować element usługowy jako umowę o świadczenie usług z art. 750 KC, gdzie płatnikiem składek jest zleceniodawca-warsztat).
    - **Skuteczna ochrona:** Jeśli Operator posiada status **ucznia szkoły ponadpodstawowej lub studenta w wieku do 26 lat**, na podstawie **art. 6 ust. 4 ustawy o systemie ubezpieczeń społecznych** jest całkowicie zwolniony z obowiązkowych składek ZUS (społecznych i zdrowotnych) od umów zlecenia i świadczenia usług. Przekazanie księgowości warsztatu kopii ważnej legitymacji szkolnej / zaświadczenia ze szkoły w pełni zabezpiecza klienta przed ryzykiem ZUS.

### 4.2. Wiek Operatora i Współpraca w Zespole

- **Ograniczona zdolność do czynności prawnych (art. 15–18 KC):** Jeżeli formalny Operator ma ukończone 13, a nie ma ukończonych 18 lat, do każdej umowy zawieranej z warsztatem (oraz do ewentualnych zgłoszeń skarbowych wymagających pełnej zdolności) załącza się jednostronicową **Zgodę przedstawiciela ustawowego (rodzica/opiekuna prawnego)** na zawarcie i wykonanie umowy. Zeznanie PIT osoby małoletniej podpisuje przedstawiciel ustawowy.
- **Zakaz prowadzenia NDG jako spółki:** Działalność nierejestrowaną może prowadzić wyłącznie **jedna osoba fizyczna** (art. 5 ust. 1 Prawa przedsiębiorców wyklucza wykonywanie jej w ramach umowy spółki cywilnej). Jeśli projekt tworzy więcej niż jedna osoba, jedna osoba występuje jako wyłączny Operator (w Regulaminie i Polityce: **Tymur Surkis**), a pozostali współtwórcy powinni zawrzeć z Operatorem pisemną umowę przeniesienia autorskich praw majątkowych lub udzielenia licencji do kodu, architektury i promptów – jest to niezbędne, aby Operator miał pełny tytuł prawny do udzielania licencji z § 6 Regulaminu.

### 4.3. Zgodność z RODO / GDPR i EU AI Act (art. 50)

- **Role stron:** Warsztat = **Administrator Danych Osobowych (ADO)**; Operator = **Podmiot Przetwarzający (Procesor)**.
- **Pełne DPA (art. 28 ust. 3 RODO):** Zintegrowane w **§ 11 Regulaminu**, obejmuje wszystkie obowiązkowe elementy ustawowe: udokumentowane polecenie, poufność personelu (lit. b), środki bezpieczeństwa z art. 32 (lit. c), szczegółową listę 7 subprocesorów (ElevenLabs, dostawca LLM: OpenAI / Anthropic / Google, Google Calendar, Northflank, Neon w EOG, Zadarma, SMSAPI) z 14-dniowym powiadomieniem, 7-dniowym prawem do sprzeciwu i pełną odpowiedzialnością Operatora za subprocesorów (ust. 2 i 4), wsparcie w prawach osób (lit. e), zgłaszanie naruszeń Data Breach w ciągu **maks. 36 godzin** (lit. f), usunięcie lub zwrot danych w ciągu 14 dni po zakończeniu umowy (lit. g) oraz prawo do informacji i audytu (lit. h).
- **Minimalizacja danych i okresy retencji:**
    - **Dostawcy warstwy głosowej AI (ElevenLabs):** automatyczne usuwanie nagrań i transkrypcji najpóźniej po **72 godzinach** od zakończenia rozmowy; backend ich nie pobiera ani nie archiwizuje.
    - **Dostawca LLM (OpenAI / Anthropic / Google API):** wyłączone trenowanie modeli; bez aktywnego planu _Zero Data Retention (ZDR)_ standardowe techniczne logi bezpieczeństwa (_abuse monitoring_) po stronie dostawcy LLM mogą być przechowywane do **30 dni** – zostało to wprost ujawnione w DPA oraz Polityce prywatności.
    - **Baza danych Operatora (PostgreSQL / Neon, EOG):** brak przechowywania zgłoszeń, danych wizyt, tekstów SMS i danych osobowych dzwoniących. Przechowywane są wyłącznie zaszyfrowane, pozbawione danych identyfikujących audyty techniczne przez **maks. 30 dni od zakończenia połączenia** (kopie zapasowe nie mogą ich przywracać po terminie).
    - **Dokumenty księgowe Klienta:** **5 lat** licząc od końca roku kalendarzowego, w którym upłynął termin płatności podatku.
- **Transparentność AI Act (obowiązuje od sierpnia 2026 r.) i RODO:** Obowiązkowy komunikat głosowy na początku każdego połączenia informujący o interakcji z AI, nagrywaniu i transkrypcji, wskazujący nazwę warsztatu jako ADO oraz źródło pełnej klauzuli informacyjnej.

---

## 5. Model Biznesowy i Strategia Wdrożenia

### 5.1. Pakiety i Cennik

- **Pierwszych 5 klientów:** 14-dniowy bezpłatny pilotaż z początkowym limitem **40 minut AI** (bez automatycznych pakietów płatnych i bez automatycznego przejścia na abonament). Po uzgodnieniu kontynuacji: pierwszy okres 30 dni z konfiguracją **549 PLN**, każdy kolejny okres 30 dni **299 PLN**.
- **Pozostali klienci:** pierwszy okres 30 dni z konfiguracją **650 PLN**, każdy kolejny okres 30 dni **400 PLN**.
    - Abonament obejmuje odbieranie przekierowanych połączeń, obsługę w Trybie Kalendarza albo Relay oraz powiadomienia SMS do jednego pracownika przez SMSAPI (bez e-mail).
    - Okres rozliczeniowy: **30 dni kalendarzowych**, płatność z góry przelewem w terminie **7 dni** od wystawienia rachunku/faktury bez VAT (od 2027 r. – faktura KSeF). W Etapie 1 przyszłe płatności potwierdza administrator ręcznie (brak automatycznego bilingu bankowego).
    - Rozpoczęta minuta AI zaokrąglana w górę (`ceil(ai_seconds / 60)`). Po wyczerpaniu limitu nowe sesje AI nie są uruchamiane (trwająca rozmowa nie jest przerywana).
    - Wypowiedzenie e-mailem lub pisemnie min. **7 dni kalendarzowych przed końcem okresu**. Brak zwrotów przy zwykłej rezygnacji; **proporcjonalny zwrot w ciągu 14 dni** przy wypowiedzeniu z powodu braku akceptacji zmian Regulaminu (§ 12 ust. 2) lub sprzeciwu wobec nowego subprocesora (§ 11 ust. 5).

### 5.2. Proces Onboardingu Warsztatu

1. **Formalności przed startem:** Doręczenie `regulamin.html` (z DPA w § 11), podpisanie indywidualnej umowy (wskazującej tryb, cennik, limity, oświadczenie B2B), załączenie zgody opiekuna (jeśli Operator < 18 lat) oraz – dla spokoju księgowości warsztatu – kopii legitymacji szkolnej/studenckiej (zwolnienie z ZUS do 26 lat).
2. **Konfiguracja techniczna i prywatności:** Udostępnienie kalendarza Google dla Service Account (Tryb Kalendarza) albo aktywacja Relay; ustawienie jednego odbiorcy SMS w SMSAPI; weryfikacja ustawień retencji 72h w ElevenLabs i wyłączenia trenowania u dostawcy LLM; konfiguracja usług, godzin pracy i komunikatu początkowego AI Act/RODO z nazwą warsztatu.
3. **Konfiguracja przekierowań u operatora warsztatu:**
    - `*61*NUMER_BOTA**10#` (brak odbioru po 10 s).
    - `*67*NUMER_BOTA#` (zajęta linia – wymaga weryfikacji opóźnienia po stronie SIP/operatora).
    - Testy odbioru: godziny pracy, po zamknięciu, linia zajęta, blokada nowych rozmów AI po wyczerpaniu 40 minut pilotażu, brak zapisu danych osobowych dzwoniących w bazie/logach.
4. **Pilotaż i kontynuacja:** Raport po 5 dniach; po 14 dniach lub 40 minutach automatyczne wstrzymanie i płatna aktywacja wyłącznie po zgodzie klienta.

---

## 6. Harmonogram i Kamienie Milowe

| Faza       | Zakres                   | Cel wyjściowy                                                                                          |
| :--------- | :----------------------- | :----------------------------------------------------------------------------------------------------- |
| **Faza 1** | Backend + Mock Adapters  | Lokalny Express + Drizzle + PostgreSQL, `resolveDate`, Tryb Kalendarza/Relay, limit 40 min, audyt 30d. |
| **Faza 2** | Landing Page + Dokumenty | Domena `gloso.pl`, lokalne fonty/CSS (bez CDN), `regulamin.html` v1.2, `polityka-prywatnosci.html`.    |
| **Faza 3** | Integracje i Chmura      | Google Calendar, SMSAPI, Zadarma SIP (+48), ElevenLabs, deploy Northflank + Neon (EOG), NIP-7/VAT-R.   |
| **Faza 4** | Pilot projektu           | 14-dniowy pilotaż (40 min AI) na warsztacie w Kielcach, weryfikacja retencji 72h i 30d.                |
| **Faza 5** | Rozwój i Skalowanie      | Faza 2 (zmiany/odwołania wizyt z kodem SMS), rejestracja JDG po zbliżeniu do limitu NDG.               |
