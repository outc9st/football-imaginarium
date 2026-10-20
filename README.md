# Football Imaginarium Online — v31 AI test

Это экспериментальная копия v31. Рабочая v31 не изменяется.

## Что добавлено

- Gemini 3.8 Flash как экспериментальный AI-мозг ботов.
- Старый `ScoreCard` остаётся fallback.
- В режиме теста одновременно фиксируются решение Gemini и решение ScoreCard.
- В интерфейсе появляется панель `AI TEST — Gemini vs ScoreCard`.
- Для каждого решения видно: тренер-бот, ассоциация, выбор Gemini, выбор ScoreCard, фактический источник и краткая причина Gemini.
- Gemini используется для выбора карты-обманки и для голосования ботов.
- API-ключ хранится только на сервере через `GEMINI_API_KEY`.

## Запуск локально

```bash
npm install
GEMINI_API_KEY="твой_ключ" npm start
```

После запуска открой `http://localhost:3000`.

Без `GEMINI_API_KEY` игра всё равно запускается: все решения автоматически идут через старый ScoreCard, а в AI TEST будет видно `Fallback`.

## Render

В Environment Variables добавь:

- `GEMINI_API_KEY` — ключ Google AI Studio.
- `GEMINI_MODEL` — необязательно; по умолчанию `gemini-3.8-flash`. При временной перегрузке сервер автоматически пробует `gemini-3.6-flash`, затем `gemini-3.5-flash-lite`.

Команда запуска остаётся `npm start`.

Официальная документация Google: https://ai.google.dev/gemini-api/docs/models


## Gemini Test v4 — исправления после реального теста
- Исправлена ошибка multiplayer: карта-обманка бота передавалась в AI-слой как объект вместо ID, из-за чего у Gemini иногда был пустой список карт.
- Добавлен таймаут Gemini (7 секунд на попытку).
- Добавлен автоматический переход с `gemini-3.8-flash` на `gemini-3.6-flash`, затем на `gemini-3.5-flash-lite` при 429/5xx/таймауте.
- Ответы с несуществующим `choiceId` безопасно уходят в ScoreCard fallback.
- В AI TEST показывается фактически использованная модель.
- Бэкап v31 не изменяется.

### v3 — speed + thinking UI
- Gemini decoy selection uses `gemini-3.5-flash-lite` with `thinkingLevel: minimal` for fast classification.
- Gemini voting uses the configured Flash model with `thinkingLevel: low`; fallback uses `gemini-3.6-flash`.
- Timeouts reduced to 3.5 s for decoy and 4.5 s for voting; a timeout no longer stacks through every fallback model.
- Responses are minimized to structured IDs/confidence; long explanations are no longer required.
- Added an animated **«Игроки думают…»** overlay during Gemini/bot decisions, including multiplayer synchronization.
- Added AI-test latency in milliseconds to the debug panel.
- The Gemini API key remains server-side in `GEMINI_API_KEY`.

Google's current documentation describes Gemini 3.8 Flash as supporting low/medium/high thinking, while Gemini 3.5 Flash-Lite supports minimal thinking and is intended for fast, high-volume tasks.


## v4
- Removed the 3.5s/4.5s client-side Gemini timeout in the test build so valid requests are allowed to finish and real latency can be measured.
- Added a double animation-frame yield before Gemini requests so the “Игроки думают…” overlay is painted before network work begins.
- Made the thinking overlay more prominent and added “Игра не зависла — боты принимают решение”.
- Gemini fallback on HTTP capacity errors remains; this test build intentionally does not abort successful requests prematurely.
