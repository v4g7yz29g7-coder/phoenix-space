#!/bin/bash
docker cp ~/phoenix_app/lib/phoenix_app_web/live phoenix_app:/app/lib/phoenix_app_web/
docker restart phoenix_app
