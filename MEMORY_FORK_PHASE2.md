Прочитай текущий репозиторий `opencode-custom` и реализуй Phase 2: нативный MemoryStatus UI для уже работающей Memory Gateway integration.

Контекст:
Phase 1 уже завершён и подтверждён живым тестом.

Уже работает:
- OpenCode Desktop → Memory Gateway → Ollama → SQLite;
- session identity;
- project identity;
- project root;
- request kind;
- global memory;
- project memory;
- project_decision;
- existing Phase 1 helper/configuration для Memory Gateway.

Memory Gateway уже предоставляет:
- GET /memory/status
- GET /memory/events

Пример `/memory/status`:

{
  "type": "memory.status",
  "state": "IDLE",
  "phase": "IDLE",
  "jobId": null,
  "startedAt": null,
  "elapsedMs": 0,
  "queuedUserRequests": 0,
  "queueLength": 0,
  "processedItems": 0,
  "degradedReasons": [],
  "error": null
}

Главная задача:
добавить в OpenCode Desktop компактный нативный индикатор состояния памяти рядом с composer / prompt input.

Пример состояний:

Memory: Ready
Memory: Analyzing · 12s
Memory: Analyzing · 8 events · 12s
Memory: Taxonomy
Memory: Consolidating
Memory: Queued · 2
Memory: Degraded
Memory: Error
Memory: Offline
Memory: Working

Это НЕ сообщение в чате.
MemoryStatus никогда не должен попадать в conversation history.

Сначала проведи аудит реальной архитектуры OpenCode Desktop:
- где находится composer / prompt input;
- какие status-компоненты уже существуют;
- какой state management используется;
- какие networking/SSE abstractions уже есть;
- как Desktop получает env/config;
- как Phase 1 helper определяет включённую Memory Integration;
- как хранится configured Gateway URL;
- где лучше разместить общий memory status client/store/hook;
- как устроен lifecycle при переключении session/project/window.

Не создавай параллельную архитектуру, если необходимые механизмы уже существуют.

Требования к UI:

1. MemoryStatus показывать только если Memory Integration включена.
Если integration disabled:
- компонент не отображается;
- запросы к `/memory/status` не выполняются;
- SSE к `/memory/events` не открывается.

2. Разместить индикатор рядом с нижней частью composer.
Он должен:
- быть компактным;
- соответствовать стилю OpenCode;
- использовать существующие UI primitives, icons и design tokens;
- корректно работать в light/dark theme;
- не занимать большую отдельную строку;
- не быть floating overlay.

3. Не делать пока:
- Memory Panel;
- Memory Manager;
- список memories;
- редактирование memories;
- удаление memories;
- taxonomy browser;
- source viewer;
- memory search;
- memory injection.

4. Сетевой flow предпочтительно такой:

Desktop
→ initial GET /memory/status
→ connect SSE /memory/events
→ обновление локального state

Не делай aggressive polling, если SSE работает.

Допустимо:
- initial GET;
- SSE;
- reconnect;
- refresh `/memory/status` после reconnect.

5. Сначала исследуй фактический формат `/memory/events`.
Не придумывай event schema.
Если backend contract уже описан в коде или документации, используй его.

6. Mapping backend state → UI:

IDLE
→ Memory: Ready

memory worker active
→ Memory: Analyzing

taxonomy active
→ Memory: Taxonomy

consolidation active
→ Memory: Consolidating

error != null
→ Memory: Error

degradedReasons.length > 0
→ Memory: Degraded

queueLength > 0 или queuedUserRequests > 0
→ отображать очередь, например:
Memory: Queued · 2

Если backend присылает неизвестное активное состояние:
→ Memory: Working

Не придумывай backend enum values.
Сначала найди реальные значения state/phase в существующем backend contract / документации / коде, который уже доступен проекту.

7. Elapsed:
во время активной операции отображать реальное прошедшее время.

Примеры:
8s
34s
1m 12s

Используй `startedAt` или `elapsedMs`.

После получения status можно локально увеличивать elapsed таймером.
Не дергай Gateway каждую секунду.
Для IDLE elapsed не показывать.

8. processedItems:
если значение реально означает обработанные элементы, можно показывать:

Memory: Analyzing · 8 events · 12s

Не показывай его, если семантика не подтверждена.

9. Критически запрещено:
- fake percentage;
- progress bar с выдуманным прогрессом;
- guessed ETA;
- guessed remaining time;
- фиктивные “3/10”, если backend этого не сообщает.

10. Offline:
если Gateway недоступен:

Memory: Offline

При этом:
- OpenCode продолжает работать;
- отправка обычных запросов не блокируется;
- никаких modal dialogs;
- никакого toast spam;
- никаких crashes.

После восстановления Gateway статус должен автоматически вернуться в актуальное состояние.

11. SSE reconnect:
сделай bounded backoff.

Пример:
1s
2s
5s
10s
max 15–30s

Если в OpenCode уже есть retry/backoff utility — используй её.

При reconnect:
- переподключить stream;
- получить fresh `/memory/status`;
- обновить UI.

Не создавай сложный networking framework ради одного SSE.

12. Error:
если backend status содержит `error != null`:
- показать Memory: Error;
- короткие детали можно показать через tooltip/popover;
- не выводить длинный stack trace возле composer;
- не добавлять ошибку в chat.

13. Degraded:
если `degradedReasons.length > 0`:
- показывать Memory: Degraded;
- если одновременно идёт операция, допустимо `Memory: Analyzing · Degraded`;
- детали только в tooltip/popover.

14. Tooltip:
при hover показывать компактную фактическую информацию.

Например:

State: IDLE
Queue: 0
Processed: 0
Gateway: Connected

или:

State: MEMORY_RUNNING
Phase: EXTRACTING
Elapsed: 14s
Queue: 1
Processed: 8

При ошибке:
Error: <короткое сообщение>

Не показывай:
- секреты;
- auth headers;
- полный project path.

15. Click behavior:
Phase 3 будет делать полноценную правую Memory Panel.

Сейчас:
- либо status не clickable;
- либо click открывает только маленький существующий popover.

Не реализовывай sidebar/panel architecture на Phase 2.

16. Архитектура:
не пихай networking/state логику прямо в PromptInput.

Желательная схема:

memory status client/store/hook
↓
MemoryStatus component
↓
composer integration

Названия и расположение выбери по conventions репозитория.

17. State management:
используй существующий подход OpenCode.
Не добавляй новую библиотеку состояния.
Не добавляй Redux/Zustand/etc., если проект их не использует.

18. Gateway URL:
используй тот же configured Gateway URL, что уже существует в Phase 1.

Например:

OPENCODE_MEMORY_GATEWAY_URL=http://127.0.0.1:11435/v1

Для status API нужен origin/base:

http://127.0.0.1:11435/v1
→
http://127.0.0.1:11435

Не делай хрупкий string replace.
Сделай нормальный shared helper.

Учти:
- 127.0.0.1;
- localhost;
- [::1];
- trailing slash;
- terminal /v1.

Сохрани security guarantees Phase 1:
- только loopback HTTP Gateway;
- никакого arbitrary remote Gateway;
- никакого трафика memory status к cloud providers.

19. Не менять Phase 1 request path без необходимости.
Не ломать:
- session identity;
- project identity;
- request headers;
- provider routing;
- Gateway matching.

20. Работай только внутри `opencode-custom`.

Не изменяй:
- `opencode-memory-system`;
- Ollama;
- пользовательскую production-конфигурацию OpenCode;
- установленный production OpenCode.

Не делай push.
Не делай destructive git operations.

21. Performance:
MemoryStatus не должен:
- замедлять composer;
- вызывать rerender всего chat;
- открывать отдельный SSE на каждую session;
- создавать несколько дублирующихся соединений.

Нужно одно логически контролируемое соединение на Desktop runtime/workspace, если архитектура это позволяет.

Проверь cleanup:
- EventSource / stream;
- timers;
- reconnect timers;
- listeners.

22. Lifecycle:
проверь:
- Desktop startup;
- switching sessions;
- switching projects;
- window reload;
- Gateway restart;
- integration disabled.

Не оставляй orphan connections/timers.

23. Accessibility:
добавь корректный accessible label.
Tooltip должен быть доступен с клавиатуры, если компонент interactive.
Не используй aggressive `aria-live` для таймера, чтобы screen reader не озвучивал elapsed каждую секунду.

24. i18n:
сначала исследуй существующую систему локализации OpenCode.
Если строки централизованы — добавь их туда.

Нужны эквиваленты:

Memory: Ready
Memory: Analyzing
Memory: Working
Memory: Taxonomy
Memory: Consolidating
Memory: Queued
Memory: Degraded
Memory: Error
Memory: Offline

Не создавай отдельную translation систему.

25. Tests.

Добавь тесты как минимум для:

A. Disabled
integration disabled
→ MemoryStatus hidden
→ no status fetch
→ no SSE

B. IDLE
state=IDLE
→ Memory: Ready

C. Running
active backend state
→ Memory: Analyzing или Working
→ elapsed отображается

D. Queue
queueLength=2
→ UI отражает очередь

E. Error
error != null
→ Memory: Error

F. Degraded
degradedReasons не пуст
→ Memory: Degraded

G. Offline
Gateway недоступен
→ Memory: Offline
→ OpenCode остаётся usable

H. Recovery
Offline
→ Gateway снова доступен
→ reconnect
→ status становится Ready/актуальным

I. No fake progress
не отображать проценты, если backend не прислал реальный percentage field

J. Cleanup
unmount/reload
→ stream закрыт
→ timers очищены

K. Cloud isolation
status/events клиент никогда не обращается к внешнему provider endpoint

26. Live test после реализации.

Gateway:

cd "C:\Users\shmeh\Desktop\PET PROJECT\opencode-memory-system"
pnpm dev

Fork:

$env:OPENCODE_MEMORY_INTEGRATION="true"
$env:OPENCODE_MEMORY_GATEWAY_URL="http://127.0.0.1:11435/v1"
bun run dev:desktop

Проверить реально:

1. Gateway работает
→ Memory: Ready

2. Отправить обычный запрос
→ OpenCode отвечает нормально

3. Когда Memory Worker запускается
→ status меняется на активный

4. Worker закончил
→ Memory: Ready

5. Остановить Gateway
→ Memory: Offline

6. Запустить Gateway снова
→ статус автоматически восстанавливается

7. Запустить Desktop без OPENCODE_MEMORY_INTEGRATION
→ MemoryStatus полностью отсутствует

27. Документация:
обнови `MEMORY_INTEGRATION.md`.

Добавь раздел Phase 2 / MemoryStatus UI:
- когда отображается;
- откуда берётся status;
- как работает SSE;
- reconnect;
- offline behavior;
- state mapping;
- ограничения.

Также исправь существующую битую UTF-8 кодировку в этом файле:
- `в†’`
- `Р”Р»СЏ...`
и любые аналогичные mojibake-фрагменты.

Сохрани файл корректно в UTF-8.

28. Upstream compatibility:
минимизируй diff относительно upstream OpenCode.

Не делай unrelated refactors.
Не форматируй большие файлы без необходимости.
Не переименовывай существующие сущности без причины.

29. Definition of Done:

Phase 2 завершён, если:

1. Desktop запускается.
2. Phase 1 identity integration не сломана.
3. При включённой integration MemoryStatus отображается.
4. При выключенной integration MemoryStatus отсутствует.
5. IDLE → Ready.
6. Active worker → Analyzing/Working.
7. Taxonomy → Taxonomy.
8. Consolidation → Consolidating.
9. Queue отображается по реальным данным.
10. Elapsed отображается без polling каждую секунду.
11. Error отображается.
12. Degraded отображается.
13. Gateway Offline не ломает OpenCode.
14. Reconnect работает автоматически.
15. После восстановления status обновляется.
16. Нет fake percentage.
17. Нет сообщений памяти в chat history.
18. Нет трафика memory status к cloud providers.
19. Нет orphan SSE/timers.
20. Добавлены tests.
21. Релевантные tests проходят.
22. Typecheck проходит.
23. Lint затронутых файлов проходит.
24. Build проходит настолько, насколько позволяет environment.
25. `bun run dev:desktop` проверен, если среда позволяет.
26. `MEMORY_INTEGRATION.md` обновлён.
27. UTF-8 документации исправлен.

30. Финальный отчёт:

В конце дай:

Architecture:
Gateway status/events
→ client/store/hook
→ MemoryStatus
→ composer

Files Changed:
полный список файлов и зачем каждый изменён.

State Mapping:
фактические backend state/phase → UI label.

Networking:
- initial fetch;
- SSE;
- reconnect;
- offline;
- cleanup.

Security:
почему status traffic идёт только в configured local Gateway и не может уйти cloud providers.

Tests:
что добавлено и результаты.

Validation:
- tests;
- typecheck;
- lint;
- build;
- dev startup.

Live Test:
что реально проверено с запущенным Gateway.

Limitations:
что остаётся на Phase 3.

Сначала проведи аудит существующей архитектуры, затем самостоятельно реализуй весь Phase 2 до Definition of Done.

Не останавливайся после анализа, если нет реального blocker.