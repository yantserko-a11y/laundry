# Запись на стирку

- Страница: https://yantserko-a11y.github.io/laundry/
- Apps Script (API и запасная страница): https://script.google.com/macros/s/AKfycbx0ZgqzJRiuFUDiF7XprkQcve19oIhvDXlNq8Top7QLdTUy67wMFeqOhRVYzm-RmeTsdw/exec

Страница записи на стирку: сетка «день × слот × машинка», имя и комната запоминаются, можно взять несколько ячеек за раз, отменить свою запись можно с того же телефона.

- `src/Code.gs` — бэкенд на Google Apps Script, данные в листе «Записи» привязанной Google-таблицы, квитанции в папке Drive «Стирка — квитанции». В ночь на понедельник триггер `weeklyReset` удаляет записи прошлой недели.
- `src/Index.html` — страница. Внутри Apps Script ходит в бэкенд через `google.script.run`, на GitHub Pages — через `fetch` без cookies Google (иначе при нескольких Google-аккаунтах в браузере Apps Script отдаёт «Не удалось открыть файл»).
- `docs/index.html` — копия страницы для GitHub Pages, собирается `./build.sh`.

Язык RU/EN переключается на странице и запоминается.

Правила (константы в начале `src/Code.gs`): 6 машинок, слоты по 2 часа с 10:00 до 00:00, 50 ₽ за стирку, запись с сегодняшнего дня до ближайшего воскресенья, прошедшие слоты сегодняшнего дня закрыты.

## Деплой через clasp

```bash
export PATH=~/.local/node/bin:$PATH
clasp push -f && clasp update-deployment AKfycbx0ZgqzJRiuFUDiF7XprkQcve19oIhvDXlNq8Top7QLdTUy67wMFeqOhRVYzm-RmeTsdw
./build.sh && git commit -am "…" && git push   # обновить GitHub Pages
```

## Установка вручную (5 минут)

1. Создать новую Google-таблицу, например «Стирка — записи».
2. В ней: **Расширения → Apps Script**.
3. Заменить содержимое `Code.gs` на файл `Code.gs` отсюда.
4. **＋ → HTML**, имя `Index`, вставить содержимое `Index.html`.
5. **Начать развертывание → Новое развертывание → тип «Веб-приложение»**:
   - Запуск от имени: **меня**
   - У кого есть доступ: **все** (Anyone)
6. Разрешить доступ к таблице и Drive (Google покажет «приложение не проверено» → «Дополнительно» → «Перейти»).
7. Ссылка вида `https://script.google.com/macros/s/…/exec` — это и есть страница записи.

После правок кода: **Развертывание → Управление развертываниями → ✏️ → Версия: новая → Развернуть**. Ссылка остаётся прежней.
