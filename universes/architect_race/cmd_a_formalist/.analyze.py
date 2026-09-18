#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Formal corpus analysis for Architect DNA."""
import os, re, glob, json, collections

CORE = "/home/ishidin/phoenix/corpus/architect/core"
files = sorted(glob.glob(os.path.join(CORE, "*.md")))

text_all = []
msg_total = 0
msg_user = 0
per_file = []
code_marks = 0
task_open = 0
task_done = 0
dates = []

for f in files:
    raw = open(f, encoding="utf-8", errors="replace").read()
    text_all.append(raw)
    msgs = re.split(r'(?m)^---\s*$', raw)
    msgs = [m.strip() for m in msgs if m.strip()]
    m = re.search(r'Сообщений пользователя:\s*(\d+)', raw)
    n_user = int(m.group(1)) if m else 0
    d = re.search(r'Дата:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})', raw)
    if d:
        dates.append(d.group(1))
    per_file.append((os.path.basename(f), n_user, len(raw), len(msgs)))
    msg_user += n_user
    msg_total += len(msgs)
    code_marks += raw.count("[CODE]")
    task_open += len(re.findall(r'\[\s\]', raw))
    task_done += len(re.findall(r'\[x\]', raw, re.I))

blob = "\n".join(text_all)
low = blob.lower()
words = re.findall(r'[A-Za-zА-Яа-яЁё0-9_\.\-\+/]+', blob)
total_words = len(words)

def count(sub):
    return low.count(sub.lower())

lexemes = ["phoenix","феникс","atoqu","брат","docker","api","log","лог","pm2","тест",
           "nginx","сознани","безопасн","ирпс","архитектур","контекст","node","python",
           "git","отчёт","отчет","i18n","adb","порт"]
lex = {k: count(k) for k in lexemes}

imps = ["нужно","запусти","проверь","дай","должен","надо","важно","сделай","восстанови",
        "перезапусти","прочитай","обязательно","объясни","прошу","покажи","помоги",
        "исправь","напиши","открой","выполни"]
imp = {k: count(k) for k in imps}

cmds = ["python3","curl","docker-compose","docker compose","npm install","pm2 restart",
        "git commit","docker build","systemctl","npm run dev","git push","pm2 logs",
        "cargo build","npm run build","nginx -t","git checkout","npm start","pm2 start",
        "pip install","git add","pm2 list","docker ps"]
cmd = {k: count(k) for k in cmds}

errs = ["not found","npm err","syntaxerror","permission denied","eaddrinuse",
        "cannot find module","exit code","module not found","can't resolve",
        "failed to compile","enoent","type error","referenceerror","traceback",
        "connection refused","timeout","econnrefused"]
err = {k: count(k) for k in errs}

ports = ["8080","3000","80","443","1051","4000","2083","2085","1065","1913","1505",
         "1309","5000","8000","5432","27017","6379","8543"]
port = {}
for p in ports:
    port[p] = len(re.findall(r'(?<![0-9])'+p+r'(?![0-9])', blob))

exts = [".js",".py",".json",".html",".ts",".md",".tsx",".sh",".css",".env",".yml",
        ".yaml",".txt",".go",".sql",".vue",".jsx"]
ext = {}
for e in exts:
    ext[e] = len(re.findall(re.escape(e)+r'(?![A-Za-z0-9])', blob))

stop = set("""и в во не что он на я с со как а то все она так его но да ты к у же вы за бы
по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже
или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут
где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет
ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее
сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот
через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед
иногда лучше чуть том нельзя такой им более всегда конечно всю между это мы вас ваш вы
""".split())
wf = collections.Counter(w.lower() for w in words if len(w) > 2 and w.lower() not in stop)
top = wf.most_common(40)

result = {
  "files": len(files),
  "msg_user": msg_user,
  "msg_total": msg_total,
  "lines": blob.count("\n")+1,
  "bytes": len(blob.encode("utf-8")),
  "words": total_words,
  "date_min": min(dates) if dates else None,
  "date_max": max(dates) if dates else None,
  "code_marks": code_marks,
  "task_open": task_open,
  "task_done": task_done,
  "lexemes": lex,
  "imperatives": imp,
  "commands": cmd,
  "errors": err,
  "ports": port,
  "extensions": ext,
  "top_words": top,
}
print(json.dumps(result, ensure_ascii=False, indent=1))
