#!/bin/sh
F=analytics/dashboard.html
echo "lines:        $(wc -l < $F)"
echo "html tags:    $(grep -c '<html' $F)"
echo "close html:   $(grep -c '</html>' $F)"
echo "api fetch:    $(grep -c '/api/analytics' $F)"
echo "chartjs cdn:  $(grep -c 'chart.js' $F)"
echo "new Chart:    $(grep -c 'new Chart' $F)"
echo "top5 header:  $(grep -c 'Топ-5' $F)"
echo "metrics(races/agents/traj/score): $(grep -c 'mRaces' $F) $(grep -c 'mAgents' $F) $(grep -c 'mTraj' $F) $(grep -c 'mScore' $F)"
