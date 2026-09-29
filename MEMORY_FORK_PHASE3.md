Реализуй Phase 3 в текущем репозитории `opencode-custom`: нативную правую Memory Panel, которая открывается по клику на уже работающий MemoryStatus.

Контекст:
Phase 1 завершён и подтверждён live:
- OpenCode Desktop → Memory Gateway → Ollama → SQLite;
- session identity;
- project identity;
- project root;
- request kind;
- global memory;
- project memory.

Phase 2 завершён и подтверждён live:
- MemoryStatus встроен возле composer;
- Ready работает;
- Analyzing работает;
- Offline работает;
- автоматический Recovery работает;
- при выключенной integration MemoryStatus отсутствует;
- GET `/memory/status`;
- SSE `/memory/events`;
- reconnect/backoff;
- elapsed;
- queue;
- Error/Degraded;
- cloud isolation;
- cleanup.

Git:
- текущая ветка `memory-integration`;
- рабочее дерево перед началом должно быть чистым;
- origin — пользовательский fork;
- upstream — официальный OpenCode;
- push не выполнять.

Главная задача Phase 3:
по клику на MemoryStatus открывать нативную правую Memory Panel с подробным состоянием Memory System.

Это НЕ Memory Manager.
На этом этапе не делать полноценный просмотр/редактирование всех memories.

--------------------------------------------------
1. СНАЧАЛА АУДИТ
--------------------------------------------------

Перед изменением кода изучи существующую архитектуру OpenCode Desktop:

- как реализованы правые sidebar/panel/drawer области;
- есть ли существующий split panel pattern;
- как открываются/закрываются вспомогательные панели;
- как сохраняется ширина панелей;
- как устроен responsive layout;
- какие primitives используются для tabs, tooltip, buttons, sections;
- где сейчас находится MemoryStatus;
- где находится Phase 2 memory status store/client;
- как устроен Desktop IPC;
- какие данные уже приходят от Gateway;
- есть ли уже reusable right-panel infrastructure.

Не создавай отдельную архитектуру, если OpenCode уже имеет подходящий sidebar/panel pattern.

Минимизируй upstream diff.

--------------------------------------------------
2. ОСНОВНОЙ UX
--------------------------------------------------

При клике на:

Memory: Ready

должна открываться правая Memory Panel.

Повторный клик может:
- закрывать панель;
или
- оставлять открытой, если это лучше соответствует существующему UI pattern.

Выбери поведение по conventions OpenCode.

Панель должна открываться без:
- перехода на другую страницу;
- сообщения в chat;
- modal dialog;
- перезагрузки session.

Пример структуры:

Memory

Connected
Ready

Current project
<project name/root-safe label>

Current session
<session id shortened>

Status
Ready

Phase
IDLE

Queue
0

Processed
0

Last update
12:41:08

Gateway
Connected

[Refresh]

Не копируй этот layout буквально, если OpenCode уже использует другой визуальный pattern.

--------------------------------------------------
3. ПАНЕЛЬ ДОЛЖНА ПОКАЗЫВАТЬ РЕАЛЬНЫЕ ДАННЫЕ
--------------------------------------------------

Используй уже существующий Phase 2 status state.

Минимум отображать:

- connection state;
- Memory state;
- phase;
- elapsed при активной задаче;
- current job id, если есть;
- queueLength;
- queuedUserRequests;
- processedItems;
- degradedReasons;
- error;
- last received update time;
- reconnect/offline state.

Не создавай второй SSE client специально для панели.

MemoryStatus и Memory Panel должны использовать один и тот же общий state.

Запрещено:

MemoryStatus → свой SSE
MemoryPanel → второй SSE

Должен быть один shared memory status source.

--------------------------------------------------
4. CURRENT PROJECT / SESSION
--------------------------------------------------

Phase 1 уже знает:

- sessionID;
- projectID;
- project root.

Покажи в панели текущую identity, если эти данные доступны безопасно из существующего Desktop state.

Нужно отображать:

Project
Session

Project ID можно сокращать визуально.

Session ID можно сокращать визуально.

Не показывай полный локальный absolute path по умолчанию, если он содержит имя пользователя Windows.

Например вместо:

C:\Users\shmeh\Desktop\PET PROJECT\project

лучше UI label:

PET PROJECT\project

или project/workspace name, если OpenCode уже знает display name.

Полный root допускается только в tooltip/copy action, если это соответствует security/privacy модели.

Не отправляй эти данные никуда дополнительно.

--------------------------------------------------
5. MEMORY COUNTS
--------------------------------------------------

Нужно выяснить, предоставляет ли текущий Memory Gateway уже API для получения:

- total active global memories;
- active memories текущего project;
- возможно total memories.

Сначала исследуй существующий API contract/documentation, доступный интеграции.

НЕ придумывай endpoint.

Если подходящий endpoint уже существует:
используй его.

Тогда в панели показать:

Global memories: N
Project memories: N

Если API такого endpoint НЕ существует:
не делай fake counts;
не читай SQLite напрямую из OpenCode;
не создавай backend endpoint в этом Phase;
не меняй `opencode-memory-system`.

В таком случае:
- UI section можно не показывать;
или
- показать `Not available in Phase 3`, только если это действительно уместно для dev build.

В финальном отчёте явно укажи, доступны ли counts через существующий Gateway API.

--------------------------------------------------
6. LAST UPDATE
--------------------------------------------------

Показывай реальное время последнего полученного status/event.

Например:

Last update
12:41:08

Это локальное UI-время получения события.

Не надо писать это в backend.

При Offline сохраняй время последнего успешного update:

Last update
12:40:53

Gateway
Offline

--------------------------------------------------
7. ACTIVE JOB
--------------------------------------------------

Если job активен:

Memory
Analyzing

Job
<short job id>

Elapsed
14s

Processed
8

Queue
1

Если job отсутствует:
не показывай пустой Job section без необходимости.

--------------------------------------------------
8. ERROR / DEGRADED
--------------------------------------------------

Если:

error != null

показывать отдельный компактный блок ошибки.

Пример:

Error
Worker request failed

Без stack trace по умолчанию.

Если:

degradedReasons.length > 0

показывать:

Degraded

и список коротких фактических причин.

Не превращай панель в debug console.

--------------------------------------------------
9. OFFLINE
--------------------------------------------------

Если Gateway недоступен:

Memory
Offline

Last connected
<time>

OpenCode при этом продолжает работать.

Panel должна оставаться открываемой даже Offline.

Не показывать modal.
Не спамить toast.

Когда Gateway восстановится:
данные в уже открытой панели должны автоматически обновиться.

--------------------------------------------------
10. REFRESH
--------------------------------------------------

Добавь компактное действие:

Refresh

Оно должно:

- выполнить один fresh GET `/memory/status`;
- обновить общий shared state;
- не создавать новый SSE;
- не перезапускать Gateway;
- не запускать Memory Worker.

Используй существующий Phase 2 client.

Если в архитектуре уже есть метод refresh/status fetch — переиспользуй его.

--------------------------------------------------
11. RECONNECT
--------------------------------------------------

Если клиент Offline, допустимо показать:

Reconnect

Но только если это естественно вписывается в UI.

Reconnect должен:
- сбросить текущий reconnect delay;
- попытаться выполнить GET + SSE reconnect;
- не создавать параллельные соединения.

Если автоматический reconnect уже идёт, кнопка не должна ломать его.

--------------------------------------------------
12. НЕ ДЕЛАТЬ BACKEND MUTATIONS
--------------------------------------------------

Phase 3 не должна:

- запускать memory update;
- запускать taxonomy;
- удалять memories;
- редактировать memories;
- merge memories;
- менять importance/confidence;
- очищать базу;
- менять project scope.

Пока только observability/control UI уровня refresh/reconnect.

Полное управление будет в Phase 4.

--------------------------------------------------
13. PANEL LAYOUT
--------------------------------------------------

Используй нативную правую панель OpenCode.

Предпочтительно:

Chat | Memory Panel

Panel должна иметь разумную ширину.

Если существующая система поддерживает resize:
используй её.

Если нет:
не пиши сложный resize system только ради Memory.

Панель не должна перекрывать composer.

Она должна корректно работать при:
- resize окна;
- переключении sessions;
- переключении projects;
- reload;
- light/dark themes.

--------------------------------------------------
14. OPEN/CLOSE STATE
--------------------------------------------------

Реши по существующей архитектуре, нужно ли сохранять состояние открытой панели.

Минимально допустимо:

- открылась;
- переключили session;
- panel остаётся открытой;
- данные обновились под текущую session/project.

Не хранить open state в backend.

Не создавать новую глобальную persistence систему.

--------------------------------------------------
15. CURRENT SESSION / PROJECT UPDATE
--------------------------------------------------

При переключении session/project панель должна обновлять:

- Session;
- Project;
- доступные project-specific данные.

При этом Gateway SSE connection не должен дублироваться.

Если status глобален для всего Memory Worker — он остаётся shared.

Identity UI должна браться из текущего OpenCode context.

--------------------------------------------------
16. MEMORY STATUS CLICK
--------------------------------------------------

MemoryStatus теперь становится interactive.

Нужно:

- button semantics;
- keyboard support;
- focus state;
- accessible label;
- tooltip при необходимости.

Enter/Space должны работать.

Не делать `div onClick`, если существующий Button primitive подходит.

--------------------------------------------------
17. ACCESSIBILITY
--------------------------------------------------

Panel:
- корректный landmark/dialog/sidebar semantic по conventions;
- keyboard accessible close action;
- Escape закрывает panel, если это соответствует существующим панелям OpenCode;
- focus не должен ломать composer;
- status elapsed не должен использовать агрессивный aria-live.

--------------------------------------------------
18. I18N
--------------------------------------------------

Используй существующую i18n систему.

Добавь русские и английские строки.

Минимум:

Memory
Status
Phase
Project
Session
Gateway
Connected
Offline
Queue
Queued requests
Processed
Elapsed
Last update
Last connected
Error
Degraded
Refresh
Reconnect
Close

Не создавай отдельную translation систему.

--------------------------------------------------
19. SECURITY
--------------------------------------------------

Сохрани все гарантии Phase 1/2.

Никакие Memory Panel requests не должны идти:

- OpenAI;
- Anthropic;
- Google;
- OpenRouter;
- GitHub;
- другим cloud providers.

Только configured local loopback Memory Gateway.

Не разрешай arbitrary remote endpoint.

Не логируй:
- auth headers;
- secrets;
- полный prompt;
- полный project root без необходимости.

--------------------------------------------------
20. НИКАКОГО DIRECT SQLITE
--------------------------------------------------

Критично:

OpenCode fork не должен открывать:

memory.db

напрямую.

Любые данные Memory System должны идти только через Gateway API.

Если backend не предоставляет какой-то показатель:
не обходи API через SQLite.

--------------------------------------------------
21. PERFORMANCE
--------------------------------------------------

Panel не должна:

- открывать второй SSE;
- опрашивать Gateway каждую секунду;
- rerender всего chat каждую секунду;
- создавать timer на каждый компонент;
- создавать reconnect loop на каждую session.

Elapsed timer должен оставаться централизованным или максимально локальным и дешёвым.

--------------------------------------------------
22. CLEANUP
--------------------------------------------------

Проверь:

- panel open/close;
- session switch;
- project switch;
- renderer reload;
- Desktop close;
- Gateway restart;
- integration disabled.

Не оставлять:
- EventSource;
- fetch stream;
- timers;
- IPC listeners;
- subscriptions.

--------------------------------------------------
23. DISABLED INTEGRATION
--------------------------------------------------

Если:

OPENCODE_MEMORY_INTEGRATION != true

то:

- MemoryStatus скрыт;
- Memory Panel невозможно открыть;
- никаких memory status network calls;
- никаких memory IPC subscriptions.

Поведение upstream OpenCode должно оставаться обычным.

--------------------------------------------------
24. TESTS
--------------------------------------------------

Добавь tests минимум для:

A. Open panel
click MemoryStatus
→ panel visible.

B. Close panel
→ panel hidden.

C. Shared state
MemoryStatus и panel используют один status source.
Не создаётся второй network subscription.

D. IDLE
→ Ready.

E. Active job
→ phase/job/elapsed/processed отображаются.

F. Queue
→ queueLength и queuedUserRequests отображаются корректно.

G. Error
→ error block visible.

H. Degraded
→ degraded reasons visible.

I. Offline
→ panel показывает Offline.

J. Recovery
Offline → Connected
→ открытая panel автоматически обновляется.

K. Refresh
→ один status GET;
→ SSE не дублируется.

L. Session switch
→ identity в panel обновляется.

M. Project switch
→ project identity обновляется.

N. Disabled integration
→ panel недоступна;
→ network отсутствует.

O. Cleanup
→ listeners/subscriptions очищаются.

P. No direct SQLite
архитектура не использует memory.db.

--------------------------------------------------
25. LIVE TEST
--------------------------------------------------

После реализации проведи live проверку.

Запуск Gateway:

cd "C:\Users\shmeh\Desktop\PET PROJECT\opencode-memory-system"
pnpm dev

Запуск fork:

$env:OPENCODE_MEMORY_INTEGRATION="true"
$env:OPENCODE_MEMORY_GATEWAY_URL="http://127.0.0.1:11435/v1"
bun run dev:desktop

Проверить:

1. MemoryStatus показывает Ready.

2. Клик по нему:
→ открывается правая Memory Panel.

3. Panel показывает:
→ Connected;
→ Ready;
→ текущий state;
→ phase;
→ queue;
→ processed;
→ last update.

4. Отправить запрос.

5. Worker начинает работу:
→ MemoryStatus меняется;
→ открытая Panel обновляется без reopen.

6. Worker заканчивает:
→ Ready.

7. Остановить Gateway:
→ Status Offline;
→ Panel Offline.

8. Запустить Gateway:
→ Status и Panel автоматически восстанавливаются.

9. Переключить session:
→ Session identity в Panel меняется.

10. Переключить project:
→ Project identity меняется.

11. Запустить без integration env:
→ ни MemoryStatus, ни Panel нет.

--------------------------------------------------
26. ДОКУМЕНТАЦИЯ
--------------------------------------------------

Обнови `MEMORY_INTEGRATION.md`.

Добавь Phase 3:

- Memory Panel;
- open/close behavior;
- shared state architecture;
- status fields;
- refresh/reconnect;
- offline behavior;
- project/session identity display;
- counts availability;
- security;
- ограничения.

Не добавляй Memory Manager functionality в документацию как уже реализованную.

--------------------------------------------------
27. НЕ ДЕЛАТЬ PHASE 4
--------------------------------------------------

Phase 3 НЕ включает:

- список всех memories;
- tree taxonomy;
- memory search;
- memory editor;
- delete;
- merge;
- move;
- source viewer;
- history;
- manual memory creation.

Это Phase 4.

--------------------------------------------------
28. НЕ ДЕЛАТЬ PHASE 5
--------------------------------------------------

Не включать:

- embeddings;
- semantic retrieval;
- memory injection;
- retrieval ranking;
- automatic context injection.

Это будет позже.

--------------------------------------------------
29. UPSTREAM COMPATIBILITY
--------------------------------------------------

Форк должен оставаться обновляемым от upstream.

Поэтому:

- минимальный diff;
- reuse existing panel primitives;
- reuse existing state;
- никаких unrelated refactors;
- не форматировать большие файлы;
- не менять provider/session request path без необходимости.

--------------------------------------------------
30. WINDOWS / TYPECHECK NOTE
--------------------------------------------------

В Windows checkout уже известна upstream symlink-проблема:

packages/enterprise/src/custom-elements.d.ts

может содержать просто:

../../ui/src/custom-elements.d.ts

и ломать полный monorepo pre-push typecheck.

Не исправляй этот unrelated upstream Windows issue в рамках Phase 3.

Проверяй релевантные packages отдельно:
- core;
- app;
- desktop;
- opencode/Phase 1 regressions.

Если полный monorepo typecheck падает только на известном symlink issue:
зафиксируй это в отчёте отдельно.

--------------------------------------------------
31. VALIDATION
--------------------------------------------------

Обязательно выполнить релевантные:

- tests;
- component tests;
- core tests;
- app tests;
- desktop tests;
- Phase 1 regression tests;
- typecheck core;
- typecheck app;
- typecheck desktop;
- lint затронутых файлов;
- prettier/check;
- git diff --check;
- build app;
- build desktop;
- `bun run dev:desktop`, если environment позволяет.

Не утверждай, что live UI проверен, если реально окно не проверялось.

--------------------------------------------------
32. DEFINITION OF DONE
--------------------------------------------------

Phase 3 завершён, если:

1. MemoryStatus стал interactive.
2. Клик открывает нативную правую Memory Panel.
3. Panel закрывается корректно.
4. Используется existing OpenCode panel architecture.
5. MemoryStatus и Panel используют один shared memory state.
6. Второй SSE не создаётся.
7. Ready отображается.
8. Active worker отображается.
9. Phase отображается.
10. Queue отображается.
11. Processed отображается.
12. Elapsed отображается.
13. Job ID отображается при наличии.
14. Last update отображается.
15. Offline отображается.
16. Error отображается.
17. Degraded отображается.
18. Recovery обновляет открытую Panel.
19. Refresh работает.
20. Reconnect не создаёт duplicate streams.
21. Current Session отображается.
22. Current Project отображается.
23. Session switch обновляет identity.
24. Project switch обновляет identity.
25. Integration disabled скрывает Status и Panel.
26. Нет direct SQLite access.
27. Нет cloud traffic.
28. Нет chat pollution.
29. Нет orphan listeners/timers/streams.
30. Tests добавлены.
31. Relevant typecheck проходит.
32. Relevant builds проходят.
33. Desktop запускается.
34. `MEMORY_INTEGRATION.md` обновлён.
35. Phase 1 и Phase 2 regressions не сломаны.

--------------------------------------------------
33. ФИНАЛЬНЫЙ ОТЧЁТ
--------------------------------------------------

В конце дай структурированный отчёт:

Architecture
- Panel architecture;
- shared state;
- UI integration point.

Existing OpenCode primitives
- какие sidebar/panel primitives переиспользованы.

Files Changed
- полный список;
- зачем изменён каждый файл.

Panel Data
- какие поля реально отображаются;
- откуда они берутся.

Memory Counts
- существует ли backend API;
- если да — как используется;
- если нет — явно написать, что counts не реализованы и почему.

Networking
- shared SSE;
- GET status;
- refresh;
- reconnect;
- cleanup.

Identity
- session;
- project;
- как обновляются при navigation.

Security
- loopback only;
- no cloud;
- no SQLite;
- no sensitive path leakage.

Tests
- добавленные tests;
- результаты.

Validation
- tests;
- typecheck;
- lint;
- formatting;
- build;
- dev startup.

Live Test
- что реально проверено руками.

Known Issues
- включая Windows symlink issue, если он снова мешает full monorepo validation.

Phase 4
- кратко перечисли, что сознательно осталось для Memory Manager.

Работай только внутри `opencode-custom`.

Не изменяй:
- `opencode-memory-system`;
- Ollama;
- пользовательскую production-конфигурацию;
- установленный production OpenCode.

Не делай push.
Не делай destructive git operations.
Не создавай PR.

Сначала проведи аудит, затем самостоятельно реализуй Phase 3 полностью до Definition of Done.
Не останавливайся после анализа, если нет реального blocker.