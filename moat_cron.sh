#!/bin/bash
cd /home/ishidin/phoenix
node moat_collector.js >> memory/moat/cron.log 2>&1
