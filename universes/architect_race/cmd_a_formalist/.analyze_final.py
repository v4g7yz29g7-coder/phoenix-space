#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Команда A (формалисты). Единый воспроизводимый анализ корпуса Архитектора.

Методология (фиксированная, детерминированная):
  - источник: corpus/architect/core/*.md (127 файлов);
  - lexemes   : подсчёт подстрок по всему сырому тексту (RAW);
  - imperatives: подсчёт по границам слова (RAW, регистронезависимо);
  - commands  : подсчёт подстрок по RAW;
  - errors    : подсчёт подстрок по RAW (нижний регистр);
  - ports     : подсчёт по границам цифр (?<![0-9])(?![0-9]) по RAW;
  - extensions: подсчёт расширений с запретом следующего [A-Za-z0-9] по RAW.

Вывод: JSON в stdout.
"""
import os
import re
import glob
import json
import collections

BASE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.normpath(os.path.join(BASE, "..", "..", "..", "corpus", "architect", "core"))

files = sorted(glob.glob(os.path.join(CORE, "*.md")))
raw_all = []
msg_user = 0
dates = []
meta_per_file = []

for f in files:
    raw = open(f, encoding="utf-8", errors="replace").read()
    raw_all.append(raw)
    m = re.search(r"Сообщений пользователя:\s*(\d+)", raw)
    n = int(m.group(1)) if m else 0
    msg_user += n
    d = re.search(r"Дата:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})", raw)
    if d:
        dates.append(d.group(1))
    meta_per_file.append({
        "file": os.path.basename(f),
        "user_msgs": n,
        "bytes": len(raw.encode("utf-8")),
    })

raw = "\n".join(raw_all)
low = raw.lower()
dates_sorted = sorted(set(dates))


def sub(s):
    return low.count(s.lower())


def wb(s):
    return len(re.findall(r"(?<![а-яёa-z])" + re.escape(s.lower()) + r"(?![а-яёa-z])", low))


def port_count(p):
    return len(re.findall(r"(?<![0-9])" + p + r"(?![0-9])", raw))


def ext_count(e):
    return len(re.findall(re.escape(e) + r"(?![A-Za-z0-9])", raw))


lexemes = ["phoenix", "atoqu", "брат", "docker", "api", "феникс", "лог", "pm2",
           "тест", "nginx", "сознани", "безопасн", "ирпс", "архитектур", "контекст",
           "node", "python", "git", "порт", "отчёт", "i18n", "adr", "zod",
           "constitutionguard", "ci/cd"]
lex = {k: sub(k) for k in lexemes}

imperatives = ["нужно", "запусти", "проверь", "дай", "должен", "надо", "важно", "сделай",
               "восстанови", "перезапусти", "прочитай", "обязательно", "объясни", "прошу",
               "покажи", "помоги", "исправь", "напиши", "выполни"]
imp = {k: wb(k) for k in imperatives}

commands = ["python3", "curl", "docker-compose", "docker compose", "npm install",
            "pm2 restart", "git commit", "docker build", "systemctl", "npm run dev",
            "git push", "pm2 logs", "cargo build", "npm run build", "nginx -t",
            "git checkout", "npm start", "pm2 start", "pip install", "git add",
            "pm2 list", "docker ps"]
cmd = {k: sub(k) for k in commands}

errors = ["not found", "npm err", "syntaxerror", "permission denied", "eaddrinuse",
          "cannot find module", "exit code", "module not found", "can't resolve",
          "failed to compile", "enoent", "type error", "referenceerror", "traceback",
          "connection refused", "econnrefused", "timeout"]
err = {k: sub(k) for k in errors}

ports = ["80", "1051", "8080", "4000", "2083", "2085", "1065", "443", "1913",
         "1505", "1309", "3000", "8543", "8000"]
port = {p: port_count(p) for p in ports}

exts = [".js", ".py", ".json", ".html", ".ts", ".md", ".tsx", ".sh", ".css",
        ".env", ".yml", ".yaml", ".txt", ".jsx"]
ext = {e: ext_count(e) for e in exts}

code_marks = raw.count("[CODE]")
task_open = len(re.findall(r"\[\s\]", raw))
task_done = len(re.findall(r"\[x\]", raw, re.I))
question_marks = raw.count("?")

# топ-слова без служебных (для контроля)
stop = set("""и в во не что он на я с со как а то все она так его но да ты к у же вы за бы
по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже
или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут
где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет
ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее
сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот
через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед
иногда лучше чуть том нельзя такой им более всегда конечно всю между это мы вас ваш вы
the and for not you are with this that from have will can all but""".split())
words = re.findall(r"[A-Za-zА-Яа-яЁё0-9_\.\-\+/]+", raw)
wf = collections.Counter(w.lower() for w in words if len(w) > 2 and w.lower() not in stop)
top_words = wf.most_common(25)

out = {
    "method": {
        "lexemes": "substring on raw",
        "imperatives": "word-boundary on raw",
        "commands": "substring on raw",
        "errors": "substring on raw (lower)",
        "ports": "digit-boundary on raw",
        "extensions": "regex ext not followed by [A-Za-z0-9] on raw",
    },
    "corpus": {
        "files": len(files),
        "msg_user": msg_user,
        "lines": raw.count("\n") + 1,
        "bytes": len(raw.encode("utf-8")),
        "words": len(words),
        "date_min": dates_sorted[0] if dates_sorted else None,
        "date_max": dates_sorted[-1] if dates_sorted else None,
        "date_points": len(dates_sorted),
        "code_marks": code_marks,
        "task_open": task_open,
        "task_done": task_done,
        "question_marks": question_marks,
    },
    "lexemes": dict(sorted(lex.items(), key=lambda x: -x[1])),
    "imperatives": dict(sorted(imp.items(), key=lambda x: -x[1])),
    "commands": dict(sorted(cmd.items(), key=lambda x: -x[1])),
    "errors": dict(sorted(err.items(), key=lambda x: -x[1])),
    "ports": dict(sorted(port.items(), key=lambda x: -x[1])),
    "extensions": dict(sorted(ext.items(), key=lambda x: -x[1])),
    "top_words": top_words,
    "largest_files": sorted(meta_per_file, key=lambda x: -x["bytes"])[:8],
    "most_msgs_files": sorted(meta_per_file, key=lambda x: -x["user_msgs"])[:8],
}

print(json.dumps(out, ensure_ascii=False, indent=1))
