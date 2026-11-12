# Oxide: da "review app" a control plane degli agenti

Proposta di direzione, novembre 2026. **Bozza da discutere, non una decisione.** Nessun codice di
produzione è stato modificato. Il prototipo che la accompagna è
[`PROTOTYPE-mission-control.html`](PROTOTYPE-mission-control.html) (doppio clic, nessuna
installazione). Le decisioni che ne usciranno diventeranno ADR in inglese.

---

## 0. In una frase

Oxide smette di essere il posto dove **leggi** quello che ha fatto l'agente e diventa il posto dove
**dai una missione, fissi le regole e decidi solo le eccezioni**. Gli agenti fanno il lavoro
creativo, Oxide fa tutto il lavoro meccanico, senza token e senza dimenticarsene, e la tua
attenzione viene spesa solo dove il codice non riesce a decidere da solo.

---

## 1. Cosa ho trovato nel codice (fatti, non opinioni)

| # | Fatto | Dove | Perché conta |
|---|---|---|---|
| F1 | **Il Dossier non consuma token.** È calcolato da Transcript, Checkpoint, Git e `gh`: "never persisted, never run, no LLM". | `crates/oxide-core/src/dossier.rs:1-5` | La tua paura ("mi brucia token per dirmi che ho cambiato colore a un pulsante") non si applica: il costo vero è **rumore visivo** e **ricalcolo** (git diff + chiamata `gh` in Branch scope a ogni refresh, `dossier.rs:352-371`), non i token. |
| F2 | **Il workflow del repo è spento di default.** Claude parte con `--safe-mode`: niente `CLAUDE.md`, skill, hook né MCP, a meno che l'utente non li riattivi. | `crates/oxide-provider/src/claude.rs:136-176`, default in `settings.rs:252` | Il motivo per cui "l'agente si dimentica di aprire la PR/issue" può essere proprio questo: le istruzioni del progetto (`AGENTS.md` → `/ask`, issue tracker, git workflow) non arrivano all'agente dentro Oxide. E le Rule suggestion scrivono in `AGENTS.md` (`rule_suggestions.rs:26`), che di default non viene caricato. |
| F3 | **I subagent di Claude non vengono annidati.** `Task`/`Agent` diventano un Item "Delegate", ma `parent_item_index` è sempre `None` nell'adapter Claude (per Codex invece c'è). | `claude.rs:450-807`, `claude.rs:841` | È il "casino" che vedi con i subagent: Oxide oggi non sa ricostruire chi ha fatto cosa. |
| F4 | **Nessuna contabilità dei token.** Si leggono solo i Usage limit (5h/settimanale), non i token o i costi per Turn/Thread. | `claude.rs` (solo `rate_limit_event`) | Non si può ottimizzare quello che non si misura. Lo stream-json di Claude riporta già usage e costo nell'evento `result`. |
| F5 | **La validazione del Dossier non è mai stata fatta**, ma Blind review e pubblicazione nella PR sono stati costruiti lo stesso. | `docs/validation/dossier-validation.md` ("ready for the maintainers to run"), #320 23/23 chiuse | L'ADR-0010 stesso diceva: "se non lo aprono spontaneamente, rivedere questo ADR". La tua sensazione di oggi *è* quel segnale. |
| F6 | **Oxide parla già il control protocol di Claude** (`control_request`/`control_response` su stdio, `--permission-prompt-tool oxide_approval`). | `claude.rs:182-260`, `claude.rs:296-303` | È la leva tecnica dell'orchestratore: lo stesso canale permette di dare all'agente **tool forniti da Oxide** e di ricevere callback sugli hook (da confermare con uno spike, vedi §9). |
| F7 | **PR, Issue e merge sono azioni pensate per essere cliccate**, non API che un agente può chiamare. Se l'agente fa `gh pr create` da solo, Oxide lo vede solo come un comando Bash. | `github.rs`, `PullRequestBrowser.tsx`, `IssueCreate.tsx` | Due strade per la stessa azione, e quella usata davvero (l'agente) è la meno tracciata. |
| F8 | **File enormi** che renderanno doloroso aggiungere un orchestratore: `oxide-app/src/lib.rs` 4.677 righe, `oxide-core/src/lib.rs` 2.800, `App.tsx` 1.707, `ThreadView.tsx` 1.443. | — | L'orchestratore va costruito come modulo nuovo e profondo, non dentro questi file. |
| F9 | **La dettatura pesa ~6.700 righe di Rust** (~17% del backend) più due worker GPU. | `crates/oxide-core/src/dictation/`, `oxide-*-worker` | Costo di manutenzione alto rispetto alla tesi. La voce però ha senso nel futuro "dici agli agenti cosa fare" (§3). |

Mercato (fine 2026): "N agenti in parallelo su worktree" è ormai una commodity: Conductor, l'app
Codex di OpenAI, Superset, Orca, Emdash e altri fanno quello. Claude Code ha subagent e Agent Teams
(sperimentali, e da quanto riportato non partono in modalità `-p`/SDK, cioè proprio come li usa
Oxide). Su quell'asse l'ADR-0010 aveva ragione a non combattere. Ma il motivo per cui la gente usa
quei tool è reale, e Oxide oggi non lo serve.

---

## 2. Come sarà lo sviluppo software da qui a 10 anni

Le previsioni sono mie e incerte; le scrivo comunque perché la direzione dipende da queste.

**2026-2027: l'agente implementa, l'umano pianifica e controlla.**
Già oggi chi lavora bene con gli agenti scrive piani, non codice, e lascia all'agente anche issue, PR,
fix dei check e prima passata di review. La review umana riga per riga sta già calando: c'è un
preprint di giugno 2026 ("The End of Code Review") che sostiene che non serva più come gate, ma la
posizione prevalente è "gli agenti fanno la prima passata, gli umani decidono le eccezioni e
l'intento". Il collo di bottiglia si sposta su: **contesto** (l'agente sa cosa vuoi?),
**coordinamento** (chi fa cosa, senza pestarsi i piedi) e **fiducia** (posso fare merge senza
leggere?).

**2028-2030: l'umano scrive intenti, vincoli e policy; la verifica diventa automatica.**
- L'unità di lavoro non è più il prompt, ma la *missione*: un obiettivo con criteri di
  accettazione verificabili. Il "piano" diventa un artefatto versionato, e la PR una sua conseguenza.
- Il merge dei cambi a basso rischio diventa automatico secondo policy (come oggi Dependabot con
  auto-merge, ma per tutto il codice ordinario). L'umano vede le eccezioni: rischio alto, check
  mancanti, agenti in disaccordo, budget sforato.
- I token diventano una voce di bilancio come il cloud: chi orchestra meglio (contesti piccoli,
  modello giusto per compito, nessun lavoro meccanico fatto da un LLM) spende 3-10 volte meno a
  parità di output. Il routing dei modelli diventa una competenza.
- La responsabilità **non** si delega. Legalmente, per sicurezza e per compliance qualcuno firma il
  merge. Quindi vince chi registra *perché* un cambio era affidabile (evidenze e provenienza), non
  chi mostra la diff più bella.

**2031-2036: il software viene mantenuto da flotte di agenti, sotto contratti scritti da umani.**
- Il "codice sorgente" che gli umani curano davvero sono specifiche, test/eval, invarianti e
  policy; il codice implementativo diventa in larga parte un artefatto derivato.
- L'ingegnere senior somiglia a un responsabile tecnico che gestisce un budget, un portafoglio di
  missioni e un registro di rischi. Lavora più per voce e testo che per tastiera (qui la dettatura
  locale torna utile).
- Gli strumenti che sopravvivono sono quelli che stanno **tra l'intenzione umana e l'esecuzione
  degli agenti**: control plane, policy, evidenze, audit. Gli IDE classici diventano una vista di
  dettaglio.

**Cosa implica per Oxide:** la scommessa giusta non è "un IDE migliore" né "più agenti in
parallelo", ma **il control plane locale e indipendente dal Provider** che trasforma un'intenzione in
lavoro mergiato, con il minimo di token e il minimo di attenzione umana, lasciando prove di tutto.
Il motore di evidenze deterministico che Oxide ha già (Dossier, Checkpoint, Command record,
freschezza dei check) è esattamente il pezzo raro. Va solo spostato: da "pagina che leggi" a
"**motore che decide cosa ti arriva**".

---

## 3. La tesi: tre principi

1. **Il lavoro meccanico lo fa Oxide, non l'agente.** Creare l'issue, fare push del branch, aprire la
   PR con il body giusto, collegare l'issue, pubblicare il Dossier, rilanciare dopo una CI rossa,
   ripulire la worktree: sono operazioni deterministiche. Farle fare a un LLM costa token, e l'LLM
   ogni tanto se le dimentica. Farle fare a Oxide costa zero e non si dimentica mai. *(Risponde
   direttamente a "la gente non apre la PR, si dimentica le cose".)*
2. **L'attenzione umana è la risorsa più scarsa.** Niente ti arriva se il codice può decidere da
   solo. Ogni cosa che ti arriva dice il motivo, e ti porta già sui file giusti. Un pulsante da rosso
   a blu non deve chiederti nulla.
3. **Ogni token speso deve comprare informazione che il codice non può calcolare.** Niente riassunti
   LLM di cose che si contano; Blind review solo quando i segnali di rischio la giustificano; il
   modello scelto in base al compito; contesti piccoli, report compatti.

**Rapporto con l'ADR-0010.** Il "confident merge" resta l'obiettivo, ma cambia di livello: dalla
Turn alla **Mission**, e da "ho letto la diff" a "le regole che ho fissato sono state rispettate, e
ho deciso io le eccezioni". La frase "running more agents is not the goal" va riscritta: l'obiettivo
non è *più* agenti, è **agenti coordinati che finiscono il lavoro**. Proposta: un nuovo ADR che
sostituisce in parte lo 0010 (§8).

---

## 4. Nuovo modello di dominio

Termini nuovi (da portare in `GLOSSARY.md` se approvati):

- **Mission**: un obiettivo con un piano approvato, diviso in Work unit, con una Policy e un
  budget. È il nuovo livello sopra i Thread. Una Mission finisce quando tutte le sue unità sono
  mergiate o chiuse.
- **Lead Thread**: il Thread che pianifica e coordina. Non implementa. Vede i Report delle unità,
  non i loro Transcript.
- **Work unit**: un pezzo di Mission = un **Worker Thread** in una worktree sua = un branch = una
  PR. (Riusa i Board Thread di oggi.)
- **Brief**: il prompt che Oxide compone per un Worker: obiettivo dell'unità, criteri di
  accettazione, file rilevanti (come percorsi, non contenuti), regole del progetto. Corto per
  costruzione (~1k token).
- **Report**: quello che un Worker restituisce al Lead: esito, file toccati, check eseguiti, dubbi.
  Strutturato e con un tetto di lunghezza (~300-500 token). Ciò che serve davvero (diff, comandi,
  esiti) lo calcola Oxide, non lo racconta l'agente.
- **Definition of Done (DoD)**: la lista di gate che un'unità deve superare, per progetto: issue
  collegata, branch pushato, Verification command freschi, PR aperta, CI verde, Dossier pubblicato,
  review proporzionata al rischio. Valutata **da Oxide, deterministicamente**, a ogni fine Turn.
- **Gate**: un elemento della DoD. Un gate è *meccanico* (lo soddisfa Oxide da solo: push, PR, issue,
  Dossier) oppure *di evidenza* (lo può soddisfare solo l'agente: eseguire i test, sistemare la CI).
- **Policy**: le regole della Mission: auto-merge del rischio basso sì/no, quanti promemoria e
  quanti Fix automatici prima di chiamarti, budget token, modelli permessi per livello di rischio.
- **Risk tier**: basso / medio / alto, calcolato **solo** dai Risk signal del Dossier che esistono già
  (percorsi sensibili, linguaggio senza check, sorgente senza test, diff grande). Nessun LLM, nessun
  punteggio opaco: il tier è il segnale peggiore, e ne mostra il motivo.
- **Inbox**: evoluzione dell'Attention Center. Contiene solo eccezioni: Approval, gate di evidenza
  falliti dopo i tentativi permessi, rischio alto, rilievi di Blind review, budget sforato, domande
  del Lead.
- **Token ledger**: token e costo per Turn, Thread, Mission e Provider/Model. Locale, come il
  Review ledger.

### Il ciclo di vita di una Work unit (provato nel prototipo)

```
queued ─▶ working ─▶ [fine Turn] ─▶ Oxide valuta la DoD (0 token)
                                     │
      gate meccanico mancante ───────┼──▶ Oxide lo esegue (push, issue, PR, Dossier)
      check mai eseguiti ────────────┼──▶ 1 promemoria mirato all'agente ─▶ working
      check falliti / CI rossa ──────┼──▶ 1 Fix automatico ─▶ working
      ...di nuovo ───────────────────┼──▶ Inbox
      rischio alto ──────────────────┼──▶ Inbox (diff già filtrata ai file sensibili)
      rischio medio ─────────────────┼──▶ Blind review (modello economico) ─▶ rilievi? Inbox : avanti
      rischio basso + tutto verde ───┴──▶ auto-merge (se la Policy lo permette)
```

Il merge manuale con un gate rosso viene **rifiutato con il motivo**: nel prototipo, scenario
"Migrazione", passo 5.

---

## 5. Orchestrazione: perché farla in Oxide e non nei subagent della CLI

Oggi, quando un Lead in Claude Code lancia dei subagent, succede questo:
- il loro lavoro rientra in buona parte nel contesto del Lead (il Lead si gonfia e diventa più caro
  a ogni Turn);
- girano tutti con lo stesso modello e nella stessa checkout, quindi si pestano i piedi;
- non li puoi vedere, mettere in pausa, correggere o riprendere uno per uno;
- quando la sessione muore, il lavoro dei subagent non è recuperabile come Thread;
- Oxide non ne ricostruisce nemmeno la gerarchia (F3).

**Proposta: i worker sono Thread veri, creati da Oxide su richiesta del Lead.** Oxide espone al
Lead un piccolo set di tool (**Oxide Orchestration tools**):

| Tool | Cosa fa | Token |
|---|---|---|
| `oxide_plan_units(units[])` | Propone le Work unit (titolo, criteri di accettazione, dimensione, file). Diventano una Mission in bozza che **approvi tu**. | Quelli del Lead |
| `oxide_spawn(unit, provider?, model?, effort?)` | Crea il Worker Thread in una worktree sua, con un Brief compilato da Oxide. Il modello lo sceglie la Policy se il Lead non lo indica (es. Haiku per le unità piccole). | 0 per Oxide |
| `oxide_status()` | Stato di tutte le unità: DoD, rischio, token spesi. Una tabella compatta, non Transcript. | ~200 |
| `oxide_await(units[])` | Blocca il Lead finché le unità non finiscono. Il Lead non spende token in polling. | 0 |
| `oxide_message(unit, text)` | Corregge un Worker in corsa (stessa semantica di un prompt). | Quelli del Worker |
| `oxide_report(...)` | Usato **dal Worker** per chiudere: esito strutturato con un tetto di lunghezza. | ~400 |
| `oxide_ask_human(question, options)` | Mette una domanda nella tua Inbox invece di indovinare. | 0 |

E per i Thread singoli, anche senza Mission: `oxide_open_pr`, `oxide_link_issue`, `oxide_dossier`.
Così, quando dici all'agente "apri la PR", la PR passa da Oxide (body con Dossier, issue collegata,
tracciata) invece che da un `gh pr create` opaco (F7).

**Come si collega ai Provider** (da validare con uno spike prima di scrivere l'ADR):
- **Claude Code**: Oxide usa già il control protocol (F6). Il canale dell'SDK supporta server MCP
  in-process e callback sugli hook: Oxide registra i suoi tool lì, senza processi in più. Un hook
  `Stop` permette a Oxide di valutare la DoD *prima* che l'agente chiuda il Turn e di rimandarlo al
  lavoro con una riga ("i test non sono stati eseguiti").
- **Codex e Antigravity**: un piccolo binario sidecar `oxide-mcp` (stdio) passato come server MCP
  nella configurazione della sessione. Funziona con qualunque Provider che parli MCP, quindi è anche
  il fallback per Claude.
- Il canale per gli Approval resta quello di oggi.

**Perché questo è diverso da Conductor & co.:** quelli lanciano N agenti e ti lasciano N diff da
leggere. Oxide lancia N agenti **e chiude il ciclo**: DoD, faccende meccaniche, review proporzionata,
merge per policy, Inbox di eccezioni. E resta locale, multi-Provider e usa i tuoi abbonamenti.

---

## 6. Economia dei token

Dove vanno i token oggi in un flusso tipico, e cosa cambia:

| Voce | Oggi (Lead + subagent in CLI, l'agente fa tutto) | Proposta |
|---|---|---|
| Piano | Lead | Lead (uguale) |
| Implementazione | Subagent, stesso modello del Lead | Worker, **modello scelto per dimensione e rischio** |
| Ritorno del lavoro al Lead | Gran parte del lavoro del subagent rientra nel contesto del Lead, e lo ripaga a ogni Turn successivo | **Report da ~400 token**; il resto Oxide lo calcola |
| Faccende (push, PR, body, issue) | L'agente: migliaia di token per PR, e a volte se le scorda | **Oxide: 0** |
| Riassunto / "cosa è successo" | Riassunto LLM, o il messaggio finale dell'agente | **Dossier deterministico: 0** (esiste già) |
| Review | O niente, o LLM su tutto | **Blind review solo con rischio medio/alto**, con un modello economico; quelli alti vanno a te |
| "Hai fatto i test?" | Lo scopri tu, e riprompti a mano | **1 promemoria mirato e automatico (~2k token)** |
| Polling dello stato | Il Lead chiede e rilegge | `oxide_await`: **0** |

Nel prototipo, con numeri illustrativi, la stessa Mission costa circa il **25-35% in meno**. Il
risparmio vero, per me più grande, sta nel **contesto del Lead che non si gonfia** su Mission lunghe.
Quello va misurato con il Token ledger, non stimato.

Regole operative:
1. **Il Token ledger prima di tutto** (F4): senza misura queste sono solo opinioni. Usage e costo
   arrivano già nello stream-json di Claude; per Codex dagli eventi di token count.
2. **Brief piccoli e con prefisso stabile**: le regole del progetto stanno all'inizio e non cambiano
   tra un Worker e l'altro, così la cache dei prompt del Provider lavora; i file si passano come
   percorsi, non incollati.
3. **Scheduling sui Usage limit**: Oxide legge già il limite di 5 ore e quello settimanale. La Policy
   può dire "sopra l'80% del limite di 5 ore, accoda le unità Opus e manda avanti quelle Haiku".
4. **Budget per Mission** con pausa, non con taglio: al superamento i Turn in corso finiscono, i
   nuovi aspettano te (scenario "Diff grande + budget").
5. **Mai un LLM per qualcosa che si conta.** Vale anche per le idee future (riassunti di PR, titoli,
   changelog): prima si prova il deterministico.

---

## 7. Cosa cambia nell'interfaccia

- **Home = Mission control.** Inbox a sinistra (solo eccezioni, con il motivo), Mission attive con la
  griglia unità × gate al centro, token e budget in alto. È il prototipo.
- **Il Thread resta**, ma diventa la vista di dettaglio (drill-down) di un'unità o di un Lead.
  L'ADR-0009 (Thread al centro) va emendato: al centro c'è la Mission, il Thread ci sta dentro.
- **Dossier proporzionato.** Una riga sempre visibile ("✓ 1 file · 2 righe · check freschi · nessun
  segnale di rischio"); si espande da solo solo quando c'è un segnale. Oggi è una sezione intera in
  cima alla Diff, senza un collapse suo (dal kit di validazione). Va calcolato una volta a fine Turn
  e messo in cache per (HEAD, albero, ultima sequenza del Transcript), non ricalcolato a ogni apertura.
- **Diff "evidence-first".** Per il rischio alto, la Diff si apre già filtrata sui file che hanno
  causato l'escalation. Il resto è a un clic.
- **Superfici PR e Issue: lettura e fallback.** Mostrano cosa ha fatto Oxide o l'agente ("PR #412
  aperta da Oxide per l'unità 2"). La creazione manuale resta raggiungibile dalla palette dei comandi,
  ma smette di essere il percorso principale.
- **Pannello Mission nel composer del Lead**: "Pianifica come Mission" trasforma la risposta del Lead
  in unità approvabili, invece di un muro di testo.

---

## 8. Cosa togliere o mettere in pausa

- **Editor e language server**: congelare. Monaco serve come visualizzatore e per piccoli ritocchi;
  l'installazione dei language server è manutenzione che non sposta la tesi.
- **Dettatura** (F9): congelare le funzionalità, tenerla funzionante. Nel futuro "dici agli agenti
  cosa fare" ha senso, ma non merita altro investimento ora.
- **Rule suggestion**: riallinearle perché scrivano dove il Provider legge davvero (F2), e farle
  confluire nei Brief.
- **Creazione manuale di issue e PR come flusso principale**: diventa fallback (vedi §7).
- Il Review ledger resta: diventa la base per il routing dei modelli ("su questo repo Haiku chiude
  le unità CSS al primo colpo il 95% delle volte").

---

## 9. Roadmap, a fasi usabili da sole

Ogni fase si chiude con una misura, non con "feature fatte".

**F0: correzioni che valgono da sole (piccole, subito).**
1. Default delle personalizzazioni: **istruzioni di progetto attive di default** (`CLAUDE.md` e
   `AGENTS.md` del repo); plugin e MCP globali dell'utente restano off. Da decidere con un ADR (F2).
2. **Token ledger** per Turn, Thread e Model (F4).
3. **Annidamento dei subagent di Claude** tramite `parent_tool_use_id` (F3).
4. **Dossier in una riga + cache + espansione guidata dal rischio** (F1).
5. **Fare la validazione del Dossier** (F5), ma sulla domanda nuova: "la riga del Dossier ti basta
   per decidere se aprire la diff?"

**F1: "Finish". Oxide chiude il lavoro di un singolo Thread.**
DoD per progetto (in Settings, con default sensati). A fine Turn Oxide valuta i gate e, se la Policy
lo permette, fa push, apre la PR con il Dossier, collega l'issue; per un gate di evidenza mancante
manda un promemoria. *Misura: % di Thread che arrivano a PR senza un intervento manuale.*

**F2: tool di Oxide per l'agente** (spike sul canale MCP/control protocol, poi `oxide_open_pr`,
`oxide_link_issue`, `oxide_dossier`, `oxide_ask_human`). *Misura: le PR aperte "dall'agente" passano
da Oxide nel 100% dei casi.*

**F3: Mission + Lead/Worker.** Modulo nuovo in core (`mission`), sidecar `oxide-mcp`, vista Mission
control. *Misura: token per PR mergiata e minuti umani per PR mergiata, rispetto a F1.*

**F4: Policy e auto-merge del rischio basso.** Risk tier dai Risk signal, auto-merge opt-in per
progetto, Inbox come home. *Misura: % di unità mergiate senza intervento umano e tasso di revert
entro 7 giorni (deve restare piatto).*

**F5: il ciclo che impara.** Routing dei modelli e Brief migliorati a partire da Review ledger e
Token ledger.

ADR da scrivere (in inglese): (a) supersede parziale dell'ADR-0010 ("Missions to a confident
merge"); (b) orchestrazione tramite tool di Oxide e Thread veri invece dei subagent della CLI;
(c) default delle personalizzazioni di Claude; (d) emendamento dell'ADR-0009 (Mission control come
home); (e) Policy e auto-merge.

---

## 10. Rischi e domande aperte

- **Auto-merge e responsabilità.** È opt-in, solo per il rischio basso, e lascia sempre il Dossier
  nella PR. Ma il primo incidente passato da un auto-merge sarà un tema. Il tasso di revert va
  misurato dal giorno uno.
- **I Provider stanno costruendo la stessa cosa** (Agent Teams di Claude Code, app Codex). Il
  vantaggio di Oxide: locale, multi-Provider, DoD e Policy deterministiche, abbonamenti tuoi. Se
  Anthropic e OpenAI chiudono i loro protocolli, l'adapter diventa più fragile (era già un rischio).
- **La qualità del Lead** decide tutto: un piano diviso male produce unità che si pestano i piedi.
  Per questo il piano si approva sempre a mano, ed è l'unico punto in cui l'umano interviene sempre.
- **Conflitti tra unità parallele** sugli stessi file: la Mission deve sapere ordinare le unità o
  dichiararne le dipendenze (non è nel prototipo).
- **Cloud.** Il trend porta gli agenti nel cloud. Una Mission locale che vive mentre il Mac dorme è un
  limite. Per ora fuori scope, ma il modello Mission non deve presupporre il locale.
- **Termini d'uso dei Provider** sull'esecuzione automatica di più sessioni con un abbonamento
  personale: da verificare prima di F3.

---

## 11. Note UX (dal codice; l'app non l'ho usata a mano)

Non ho potuto pilotare la GUI da questa sessione, quindi queste note vengono dalla lettura del codice
e dei documenti di UI review, non da un uso reale. Vanno confermate.
- Il Dossier è una sezione intera sopra la Diff anche per un cambio di 2 righe: è il rumore di cui
  parli.
- Il default `--safe-mode` è invisibile: un utente con un `CLAUDE.md` curato vede l'agente "più
  stupido" dentro Oxide che nel terminale, senza capire perché.
- I subagent compaiono come un'unica riga "Delegate" senza dettaglio (Claude).
- Cinque Surface nel dock più Code workspace più terminale: tante superfici per un utente che sempre
  più spesso non legge codice. Con Mission control come home, la maggior parte resta lì per il
  drill-down.
