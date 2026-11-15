#!/bin/sh
# Локальный стенд: страница из src/Index.html с фейковым бэкендом dev/mock.js.
# Запуск: ./dev/serve.sh  →  http://localhost:8765/
cd "$(dirname "$0")/.." || exit 1
sed 's#<base target="_top">#<script src="mock.js"></script>#' src/Index.html > dev/index.html
cp docs/manifest.webmanifest docs/*.png docs/admin.html dev/ 2>/dev/null
exec python3 -m http.server "${PORT:-8765}" --directory dev
