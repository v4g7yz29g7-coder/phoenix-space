#!/bin/bash
# Получить актуальный URL туннеля
pm2 logs aeon_tunnel --lines 500 --nostream 2>&1 | \
  grep -oE "https://[a-z-]+\.trycloudflare\.com" | \
  tail -1
