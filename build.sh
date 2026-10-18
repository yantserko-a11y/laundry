#!/bin/sh
# Собирает страницу для GitHub Pages из src/Index.html
cd "$(dirname "$0")" && sed 's#<base target="_top">##' src/Index.html > docs/index.html
