#!/bin/bash
TIMESTAMP=$(date +%Y%m%d_%H%M)
cp ~/phoenix/public/js/app.js ~/phoenix/backups/app_$TIMESTAMP.js
cp ~/phoenix/public/css/style.css ~/phoenix/backups/style_$TIMESTAMP.css
cp ~/phoenix/public/index.html ~/phoenix/backups/index_$TIMESTAMP.html
find ~/phoenix/backups -type f -mtime +7 -delete
