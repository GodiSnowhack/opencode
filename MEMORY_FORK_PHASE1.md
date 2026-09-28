# OpenCode Fork — Phase 1
# Session / Project Identity Integration

## Контекст

Это форк OpenCode Desktop.

Отдельно существует локальный проект долговременной памяти:

`opencode-memory-system`

Memory Gateway работает как OpenAI-compatible proxy:

```text
OpenCode
→ Memory Gateway http://127.0.0.1:11435/v1
→ Ollama http://127.0.0.1:11434
```

Gateway уже умеет принимать HTTP headers:

```text
X-Memory-Session-Id
X-Memory-Project-Id
X-Memory-Project-Root
```

Сейчас обычный OpenCode их не отправляет, поэтому Gateway часто получает:

```text
project_id = NULL
```

Из-за этого project-specific durable memory не может надёжно работать.

---

## 1. Главная задача

Изучи реальный request path OpenCode и добавь передачу стабильной session/project identity в запросы к Memory Gateway.

На этом этапе НЕ делать Memory UI.

Нужно получить цепочку:

```text
OpenCode Desktop
       ↓
Current Session
Current Project
Workspace Root
       ↓
LLM request
       ↓
Memory Gateway
```

Gateway должен получать:

```text
X-Memory-Session-Id
X-Memory-Project-Id
X-Memory-Project-Root
```

---

## 2. Сначала провести аудит

До изменения кода найди реальный путь:

```text
Desktop UI
→ OpenCode session
→ session runner
→ provider/model request
→ OpenAI-compatible provider
→ HTTP request
```

Учитывай, что в проекте могут существовать несколько путей выполнения запросов.

Предварительный аудит уже показал наличие:

```text
sessionID
projectID
workspaceID
directory
```

Также известно, что Legacy Session и V2 Session Runner могут формировать LLM requests разными путями.

Не предполагай, что изменение только одного пути достаточно.

Определи:

- где создаётся текущий session ID;
- где определяется project ID;
- где определяется workspace;
- где хранится абсолютный project root;
- где формируются Legacy LLM requests;
- где формируются V2 LLM requests;
- где создаётся OpenAI-compatible HTTP request;
- где безопаснее всего добавить metadata;
- какие внутренние auxiliary requests существуют.

Не делай предположений по именам файлов.

Сначала изучи реальный код.

---

## 3. Session ID

Для каждого обычного пользовательского model request Gateway должен получать:

```text
X-Memory-Session-Id
```

Значение должно быть реальным стабильным ID текущей OpenCode session.

Требования:

- один session ID сохраняется на протяжении всей сессии;
- новая OpenCode session получает другой ID;
- продолжения после tool calls используют тот же ID;
- повторный model request того же user turn использует ту же session identity;
- не генерировать новый ID для каждого HTTP request.

Если OpenCode уже имеет стабильный `sessionID`, используй его.

Не создавать второй независимый session identity mechanism.

---

## 4. Project ID

Gateway должен получать:

```text
X-Memory-Project-Id
```

Project ID должен быть:

- стабильным;
- существующим OpenCode ID, если он уже имеется;
- одинаковым для одного проекта;
- различным для разных проектов.

Предварительный аудит уже обнаружил `projectID`.

Используй существующую project identity, если она действительно соответствует текущему проекту.

Не создавать собственный hash пути или UUID, если OpenCode уже предоставляет корректный ID.

---

## 5. Project Root

Gateway должен получать:

```text
X-Memory-Project-Root
```

Значение — абсолютный root текущего workspace/project.

Пример:

```text
C:\yes\OpenCode_Sessions
```

или:

```text
C:\Projects\my-app
```

Не использовать:

```text
.
..
relative/path
```

если доступен canonical absolute directory.

Предварительный аудит обнаружил `directory`.

Проверь, соответствует ли он требуемому root.

Если есть различие между:

```text
directory
workspace root
project root
```

разберись в семантике и выбери наиболее корректное значение для долговременной project memory.

Зафиксируй решение в документации.

---

## 6. Workspace ID

Предварительный аудит обнаружил опциональный:

```text
workspaceID
```

Не обязательно добавлять отдельный HTTP header на Phase 1.

Но:

- изучи его назначение;
- документируй связь project/workspace;
- не путай workspace identity с project identity.

Если workspace необходим для корректного определения project root, используй его внутри integration layer.

---

## 7. Не отправлять metadata внешним providers

Критическое требование.

Headers содержат локальную информацию:

```text
session identity
project identity
filesystem path
```

Они НЕ должны автоматически отправляться:

```text
OpenAI
Anthropic
Google
OpenRouter
GitHub Copilot
или другим cloud providers
```

Memory headers разрешены только для configured local Memory Gateway.

---

## 8. Memory Gateway detection

Не hardcode headers для всех OpenAI-compatible providers.

Создай небольшой memory integration layer.

Интеграция должна быть явно включаемой.

Предпочтительно использовать существующий OpenCode config mechanism.

Допустимая концепция:

```text
memoryIntegration.enabled
memoryIntegration.gatewayURL
```

либо эквивалент, естественно вписывающийся в существующую конфигурацию.

Если проще и соответствует архитектуре проекта, допустимо использовать env:

```text
OPENCODE_MEMORY_INTEGRATION=true
OPENCODE_MEMORY_GATEWAY_URL=http://127.0.0.1:11435
```

Но сначала проверь существующую config architecture.

Не добавляй новый configuration framework.

---

## 9. Default behaviour

По умолчанию upstream-поведение должно сохраняться.

Если Memory integration выключена:

```text
никакие memory headers не добавляются
```

и request path должен вести себя как оригинальный OpenCode.

---

## 10. URL matching

Headers должны добавляться только когда фактический provider endpoint соответствует configured Memory Gateway.

Не достаточно проверить только имя provider:

```text
ollama
```

потому что Ollama может использоваться напрямую:

```text
http://127.0.0.1:11434/v1
```

или через Gateway:

```text
http://127.0.0.1:11435/v1
```

Memory metadata должна уходить только во второй вариант.

Нормализуй URL корректно:

```text
localhost
127.0.0.1
trailing slash
/v1
```

без чрезмерно широкой эвристики.

---

## 11. Legacy Session path

Предварительный аудит показал, что Legacy Session имеет отдельный LLM request path.

Проверь его полностью.

Если он всё ещё используется Desktop/OpenCode:

добавь identity propagation и туда.

Не оставлять ситуацию:

```text
V2 memory работает
Legacy memory теряет project_id
```

---

## 12. V2 Session Runner

Отдельно исследуй V2 Session Runner.

Добавь identity propagation в минимальной общей точке, если такая существует.

Предпочтение:

```text
один общий integration point
```

вместо копирования одинаковой логики в Legacy + V2.

Но если общая точка отсутствует и её создание потребует серьёзного upstream refactor:

используй маленький shared helper и минимальные вызовы в обоих путях.

Не перестраивай архитектуру OpenCode ради Phase 1.

---

## 13. Tool continuations

Сценарий:

```text
User
↓
Qwen
↓
tool call
↓
tool result
↓
Qwen continuation
```

Все model calls внутри этого процесса должны иметь:

```text
тот же X-Memory-Session-Id
тот же X-Memory-Project-Id
тот же X-Memory-Project-Root
```

Не создавать новую memory session на каждый tool continuation.

---

## 14. Auxiliary requests

OpenCode выполняет внутренние model requests, например:

```text
title generation
summary
compaction
другие helper tasks
```

Из живого тестирования уже известно, что title-generator request может попадать через тот же Gateway.

Изучи существующий код и найди надёжный signal типа запроса.

Если возможно, добавь:

```text
X-Memory-Request-Kind
```

Значения только если их можно определить надёжно:

```text
user
title
compaction
summary
auxiliary
```

Не классифицируй запрос по текстовым эвристикам, если OpenCode уже знает его назначение.

Если единой надёжной классификации нет:

- реализуй только те виды, которые можно определить точно;
- документируй ограничение.

Memory Gateway уже умеет фильтровать auxiliary evidence, но fork должен передавать максимально точную provenance.

---

## 15. Request provenance

Если архитектура позволяет без крупных изменений, Gateway полезно знать не только session/project identity, но и provenance request.

Допустимый header:

```text
X-Memory-Request-Kind
```

Приоритет:

```text
явная internal metadata OpenCode
>
контекст runner
>
никакого значения
```

Не использовать анализ текста prompt для определения kind.

---

## 16. Security

Не логировать полный:

```text
X-Memory-Project-Root
```

в production logs без необходимости.

Не добавлять memory metadata:

- telemetry;
- crash reports;
- unrelated HTTP requests;
- cloud provider calls.

Memory identity должна попадать только в model request к локальному Gateway.

---

## 17. Privacy

Project root может содержать username и локальные пути.

Поэтому:

```text
C:\Users\username\Projects\...
```

никогда не должен случайно уходить во внешний provider.

Добавь тест, который явно подтверждает отсутствие этих headers для cloud endpoint.

---

## 18. Никаких изменений соседнего Memory System

Работай только внутри:

```text
opencode-custom
```

Не изменяй:

```text
opencode-memory-system
Ollama
модели Ollama
~/.config/opencode
production OpenCode
```

---

## 19. Никакого UI на Phase 1

Пока НЕ добавлять:

```text
MemoryStatus
MemoryPanel
MemoryManager
иконки памяти
toast
status bar
memory settings UI
```

UI — следующая фаза.

---

## 20. Минимальность изменений upstream

Это форк живого upstream OpenCode.

Будущие обновления оригинального OpenCode должны оставаться возможными.

Поэтому:

- не размазывать memory-specific code по проекту;
- создать компактный shared helper/module;
- использовать существующие abstractions;
- менять минимальное количество upstream файлов;
- не проводить unrelated refactors;
- не форматировать большие файлы без необходимости;
- не переименовывать существующие сущности без причины.

---

## 21. Suggested abstraction

Не обязательно использовать именно это API, но архитектурно ожидается нечто компактное:

```ts
type MemoryRequestIdentity = {
  sessionId: string
  projectId?: string
  projectRoot?: string
  requestKind?: string
}
```

И helper уровня:

```ts
getMemoryHeaders(...)
```

или:

```ts
applyMemoryGatewayHeaders(...)
```

Helper должен возвращать пустой набор headers, если integration неактивна или endpoint не является Memory Gateway.

---

## 22. Existing headers

Не перезаписывай бездумно существующие provider headers.

Memory headers должны merge'иться с существующими headers корректно.

Не ломать:

```text
Authorization
Content-Type
custom provider headers
OpenAI-compatible SDK headers
```

---

## 23. Configuration tests

Добавить tests:

### Memory disabled

```text
integration disabled
→ {}
```

### Gateway match

```text
integration enabled
request URL = configured gateway
→ memory headers present
```

### URL mismatch

```text
integration enabled
request URL = cloud provider
→ memory headers absent
```

---

## 24. Identity tests

### Same session

Несколько requests одной session:

```text
X-Memory-Session-Id одинаковый
```

### New session

```text
X-Memory-Session-Id другой
```

### Same project

Новая session того же проекта:

```text
Project ID тот же
Project Root тот же
```

### Different project

```text
Project ID другой
Project Root другой
```

---

## 25. Tool-call test

Проверить:

```text
initial assistant generation
tool continuation
```

оба запроса имеют одинаковую session/project identity.

---

## 26. Auxiliary test

Если реализован `X-Memory-Request-Kind`:

title generation должен быть:

```text
title
```

обычный запрос:

```text
user
```

Не строить этот тест на анализе текста prompt.

---

## 27. Cloud-provider isolation test

Обязательный тест.

Например mock external endpoint.

Убедиться, что headers:

```text
X-Memory-Session-Id
X-Memory-Project-Id
X-Memory-Project-Root
X-Memory-Request-Kind
```

не присутствуют.

---

## 28. Desktop startup

После изменений запустить:

```text
bun run dev:desktop
```

Если среда позволяет.

Убедиться, что Desktop запускается без runtime exception.

Не утверждать, что проверено, если запуск фактически не выполнялся.

---

## 29. Typecheck / tests

Найди релевантные команды самого upstream проекта.

Не придумывай команды.

Запусти минимум:

- релевантные unit tests;
- typecheck для затронутых packages;
- build, если он разумен;
- Desktop dev startup.

Если полный monorepo test suite слишком большой или требует внешних сервисов — явно это укажи.

---

## 30. Documentation

Создай документ в логичном существующем месте, например:

```text
docs/memory-integration.md
```

Если структура документации OpenCode использует другое место — используй существующий convention.

Документ должен описывать:

- цель integration;
- как включить;
- configured Gateway;
- какие headers передаются;
- session ID source;
- project ID source;
- project root source;
- workspace semantics;
- Legacy path;
- V2 path;
- auxiliary request handling;
- cloud-provider isolation;
- ограничения.

---

## 31. Manual live test documentation

Добавь инструкции для будущего живого теста:

```text
OpenCode Fork
→ Memory Gateway
→ SQLite
```

Шаги должны включать:

1. Запустить Memory Gateway.
2. Запустить OpenCode Desktop fork.
3. Открыть конкретный проект.
4. Создать новую session.
5. Отправить обычный запрос.
6. Проверить Gateway Raw History.
7. Проверить `session_id`.
8. Проверить `project_id`.
9. Проверить `project_root`.
10. Сделать tool call.
11. Убедиться, что identity не изменилась.
12. Создать новую session того же проекта.
13. Проверить новый session ID и прежний project ID.
14. Открыть другой проект.
15. Проверить другой project ID/root.

---

## 32. Live acceptance target

После Phase 1 мы хотим иметь возможность отправить:

```text
Для этого проекта принято решение:
конфигурацию приложения будем хранить в SQLite.
```

И получить в Memory System:

```text
scope = project
project_id != NULL
type = project_decision
```

Это будет проверяться вручную после завершения Codex implementation.

---

## 33. Не включать пока

Phase 1 НЕ включает:

```text
embeddings
memory injection
MemoryStatus UI
MemoryPanel
MemoryManager
Desktop memory settings
```

Даже если соответствующий backend уже существует.

---

## 34. Definition of Done

Phase 1 считается завершённой, если:

1. Чистый Desktop продолжает запускаться.
2. Legacy Session path исследован.
3. V2 Session Runner исследован.
4. Обычные providers не сломаны.
5. Memory Gateway получает стабильный session ID.
6. Memory Gateway получает стабильный project ID.
7. Memory Gateway получает абсолютный project root.
8. Tool continuations используют ту же identity.
9. Новая OpenCode session получает новый session ID.
10. Тот же project сохраняет project identity между sessions.
11. Другой project получает другую project identity.
12. Memory headers не отправляются cloud providers.
13. Disabled integration сохраняет upstream behaviour.
14. Auxiliary request provenance реализована настолько, насколько это возможно без эвристик.
15. Добавлены tests.
16. Добавлена документация.
17. Релевантные tests/typecheck/build проходят.
18. Desktop dev startup проверен, если позволяет environment.

---

## 35. Перед реализацией

Сначала проведи аудит и зафиксируй для себя:

```text
Где формируется Legacy provider request
Где формируется V2 provider request
Где находится session ID
Где находится project ID
Где находится workspace ID
Где находится project/workspace directory
Как определяется auxiliary request
Какой минимальный integration point выбран
```

Не останавливайся после аудита, если нет реального blocker.

После анализа самостоятельно реализуй Phase 1.

---

## 36. Финальный отчёт

В конце дай отчёт:

### Request Path

Как реально проходит:

```text
Desktop
→ Session
→ Runner
→ Provider
→ HTTP
```

Для Legacy и V2.

### Identity

Откуда берутся:

```text
session ID
project ID
workspace ID
project root
```

### Integration Point

Где и почему добавляются memory headers.

### Auxiliary Requests

Что удалось классифицировать и как.

### Cloud Isolation

Почему metadata не уходит внешним providers.

### Files Changed

Полный список изменённых файлов с краткой причиной.

### Tests

Какие тесты добавлены.

### Validation

Результаты:

```text
tests
typecheck
build
Desktop dev startup
```

### Limitations

Что невозможно проверить автоматически.

### Manual Live Test

Что пользователь должен проверить через:

```text
OpenCode Fork
→ Memory Gateway
→ SQLite
```

---

## 37. Ограничения агента

Работай автономно внутри текущего repository.

Не спрашивай пользователя о мелочах, которые можно определить из существующего кода.

Не делай destructive Git operations.

Не выполняй push.

Не изменяй соседние проекты.

Не изменяй системную конфигурацию.

Не устанавливай внешнее ПО без необходимости.

Не меняй пользовательский production OpenCode.

Не меняй Ollama.

---

## 38. Главный принцип Phase 1

Цель не в том, чтобы просто добавить три headers.

Цель — создать минимальную и безопасную интеграцию между OpenCode fork и Memory Gateway, которая:

```text
точно знает session
точно знает project
точно знает project root
не раскрывает эти данные cloud providers
не ломает upstream architecture
и пригодна для будущего Memory UI.
```