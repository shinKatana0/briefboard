# briefboard (agentboard)

[English](README.md) | Русский | [日本語](README.ja.md)

[![npm version](https://img.shields.io/npm/v/briefboard.svg)](https://www.npmjs.com/package/briefboard)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >=21](https://img.shields.io/badge/node-%3E%3D21-brightgreen.svg)](#требования)

Лёгкая канбан-доска + CLI для того, чтобы AI-агенты вели работу над задачами
через строгий воркфлоу `backlog → open → ready → in_progress → review → done`,
с обязательными брифами перед стартом реализации и ревью перед мержем.

> Пакет опубликован в npm под именем `briefboard` — `npx briefboard init`
> разворачивает его в любой проект (см. раздел «Быстрый старт» ниже).
> Клонирование репозитория — альтернатива для контрибьюторов и разработки.

## Зачем это нужно

Агенты, которые работают напрямую по разговору с пользователем, легко теряют
структуру: непонятно, что уже решено, что ещё в работе, кто и почему принял
то или иное решение. `agentboard`/`briefboard` кладёт поверх любого агентного
инструмента (Claude Code, Codex и т.п.) простой формальный процесс —
бэклог задач, обязательный бриф перед реализацией и ревью перед мержем —
и живую доску, на которой это всё видно человеку в реальном времени.

## Быстрый старт

**Полное руководство пользователя:** подробный пошаговый разбор (установка,
первый запуск, жизненный цикл задачи от начала до конца, справочник по CLI,
UI доски и решение проблем) — см.
[руководство пользователя](https://github.com/shinKatana0/briefboard/blob/main/doc/guide/guide.ru.md).

Разверните его в любой проект командой `npx briefboard init` — она скопирует
`server/`, `tools/`, `ui/`, `agents/`, `AGENTS.md`, `CLAUDE.md` в текущую
директорию и создаст пустые `doc/backlog.md` + `doc/brief/`:

```bash
npx briefboard init
node server/server.js
# → доска на http://localhost:4571 (порт настраивается переменной PORT)

node tools/task.mjs add --type feature --priority Major --title "..." --desc "..."
```

Как альтернатива — для контрибьюторов или разработки — клонируйте репозиторий
и работайте прямо в нём:

```bash
git clone <url-этого-репозитория>
cd agentboard

node server/server.js
node tools/task.mjs add --type feature --priority Major --title "..." --desc "..."
```

## Как это работает

Источник правды — файл `doc/backlog.md` (плюс брифы в `doc/brief/`), обычный
markdown. Каждая задача проходит через фиксированные статусы:

```
backlog ──▶ open ──▶ ready ──▶ in_progress ──▶ review ──▶ done
   │          │        │            │             │
   └──────────┴────────┴────────────┴─────────────┴──▶ cancelled
                                        review ──▶ in_progress (если не прошла ревью)
```

- **backlog** — задача только зафиксирована.
- **open** — обсуждена, решение принято.
- **ready** — на задачу написан бриф (без брифа перевести в `ready` нельзя).
- **in_progress** — воркер реализует задачу по брифу в отдельной ветке.
- **review** — воркер сдал задачу, оркестратор проверяет и гоняет тесты.
- **done** / **cancelled** — задача смержена или отменена.

Две роли:

- **Оркестратор** — ведёт бэклог, пишет брифы, распределяет задачи, проводит
  ревью и мержит. Единственный, кто ставит статусы `backlog/open/ready/review/done/cancelled`.
- **Воркер** — берёт задачу в `ready`, реализует ровно то, что описано в
  брифе, переводит `ready → in_progress` и `in_progress → review`.

Точный формат `doc/backlog.md` и `doc/brief/*.md`, правила записи и
разрешённые переходы статусов — в `agents/PROTOCOL.md` (единственный
источник правды по формату, здесь пересказано только своими словами).
Инструкции для ролей — `agents/ORCHESTRATOR.md` и `agents/WORKER.md`.

## UI доски

- Колонки по статусу: В бэклоге → Открыта → Готова → В работе → Ревью;
  Завершённые и Отменённые — сворачиваемые полосы под доской.
- Фильтр по типу задачи (все / feature / bug).
- Поиск по названию и описанию задачи.
- Мультиселект-фильтр по приоритету (Blocker / Critical / Major / Medium / Minor).
- Переключение темы: light / dark.
- Переключение языка интерфейса: EN / RU / JA.
- Drag&drop карточки из «Бэклога»/«Открыта» на полосу «Отменённые» — быстрая
  отмена задачи прямо из UI.
- Экспорт текущей доски в Excel (`.xlsx`) одной кнопкой.
- Live-обновление: доска сама перерисовывается при изменении `doc/backlog.md`
  на диске (SSE + `fs.watch`), без перезагрузки страницы.

## CLI-справка

```bash
node tools/task.mjs add --type feature|bug --priority Blocker|Critical|Major|Medium|Minor --title "..." [--desc "..."]
                                  # завести новую задачу в doc/backlog.md
node tools/task.mjs status T-0007 <backlog|open|ready|in_progress|review|done|cancelled>
                                  # сменить статус задачи (с проверкой допустимости перехода)
node tools/task.mjs brief T-0007 <slug>
                                  # создать doc/brief/T-0007-01-slug.md и связать его с задачей
node tools/task.mjs show T-0007  # вывести задачу целиком (поля + описание)
node tools/task.mjs list [--status ready]
                                  # список задач, опционально отфильтрованный по статусу
node tools/task.mjs validate     # структурная проверка doc/backlog.md (дублирующиеся ID,
                                  # невалидные status/type, битые ссылки на брифы и т.п.)
```

## Требования

- Node.js >= 21 (эмпирически проверено, см. T-0041: `node --test` начинает
  раскрывать glob-паттерн `tests/**/*.test.js` из `npm test` только начиная
  с Node 21.0.0 — на Node 18.x и на всей линии 20.x, вплоть до последнего
  выпуска 20.20.2, тот же паттерн не находит файлы).
- Zero runtime dependencies — ни `npm install`, ни сторонних библиотек.

## Безопасность и сеть

По умолчанию сервер слушает `127.0.0.1` (loopback), поэтому доска доступна
только с локальной машины. Публичный bind — только по явному выбору через
переменные окружения `HOST` / `AGENTBOARD_HOST`. Сетевая модель и как
репортить уязвимости — в [SECURITY.md](SECURITY.md).

## Лицензия

MIT — см. [LICENSE](LICENSE).
