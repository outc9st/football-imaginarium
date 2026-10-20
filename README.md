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
- `GEMINI_MODEL` — необязательно; по умолчанию `gemini-3.8-flash`.

Команда запуска остаётся `npm start`.

Официальная документация Google: https://ai.google.dev/gemini-api/docs/models
