#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Refined analysis: word-boundary lexemes and code-fence-excluded metrics."""
import os, re, glob, json, collections

CORE = "/home/ishidin/phoenix/corpus/architect/core"
files = sorted(glob.glob(os.path.join(CORE, "*.md")))

def strip_code(text):
    # remove fenced code blocks
    text = re.sub(r'```.*?```', ' ', text, flags=re.S)
    # remove inline code
    text = re.sub(r'`[^`]*`', ' ', text)
    return text

raw_all = []
prose_all = []
msg_user = 0
per_msg_lens = []
files_meta = []
for f in files:
    raw = open(f, encoding="utf-8", errors="replace").read()
    raw_all.append(raw)
    prose_all.append(strip_code(raw))
    m = re.search(r'Сообщений пользователя:\s*(\d+)', raw)
    n = int(m.group(1)) if m else 0
    msg_user += n
    files_meta.append((os.path.basename(f), n, len(raw)))

raw = "\n".join(raw_all)
prose = "\n".join(prose_all)
low = prose.lower()

def word_count(sub):
    return len(re.findall(r'(?<![а-яёa-z])'+re.escape(sub)+r'(?![а-яёa-z])', low))

def sub_count(sub):
    return low.count(sub.lower())

lexemes = {
 "phoenix": word_count("phoenix"),
 "феникс": word_count("феникс"),
 "atoqu": sub_count("atoqu"),
 "брат": word_count("брат"),
 "docker": sub_count("docker"),
 "api": word_count("api"),
 "лог": word_count("лог"),
 "log": word_count("log"),
 "pm2": sub_count("pm2"),
 "тест": sub_count("тест"),
 "nginx": sub_count("nginx"),
 "сознани": sub_count("сознани"),
 "безопасн": sub_count("безопасн"),
 "ИРПС": sub_count("ирпс"),
 "архитектур": sub_count("архитектур"),
 "контекст": sub_count("контекст"),
 "node": word_count("node"),
 "python": sub_count("python"),
 "git": word_count("git"),
 "отчёт": sub_count("отчёт"),
 "порт": sub_count("порт"),
 "i18n": sub_count("i18n"),
}

imps = ["нужно","запусти","проверь","дай","должен","надо","важно","сделай","восстанови",
        "перезапусти","прочитай","обязательно","объясни","прошу","покажи","помоги",
        "исправь","напиши","выполни","продолжай","создай","сохрани"]
imp = {k: word_count(k) for k in imps}

errs = ["not found","npm err","syntaxerror","permission denied","eaddrinuse",
        "cannot find module","exit code","module not found","failed to compile",
        "enoent","referenceerror","traceback","connection refused","econnrefused"]
err = {k: sub_count(k) for k in errs}

ports = ["8080","3000","80","443","1051","4000","2083","2085","1065","1913","1505",
         "1309","5000","8000","8543"]
port = {p: len(re.findall(r'(?<![0-9])'+p+r'(?![0-9])', prose)) for p in ports}

exts = [".js",".py",".json",".html",".ts",".md",".tsx",".sh",".css",".env",".yml",
        ".yaml",".txt",".jsx"]
ext = {e: len(re.findall(re.escape(e)+r'(?![A-Za-z0-9])', prose)) for e in exts}

# dates
dates = sorted(set(re.findall(r'Дата:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})', raw)))

# questions vs imperatives
qmarks = prose.count("?")
excl = prose.count("!")
code_marks = raw.count("[CODE]")
task_open = len(re.findall(r'\[\s\]', raw))
task_done = len(re.findall(r'\[x\]', raw, re.I))
docker_cmds = sub_count("docker ")
git_cmds = sub_count("git ")
pm2_cmds = sub_count("pm2 ")
npm_cmds = sub_count("npm ")
curl_cmds = sub_count("curl")

out = {
 "files": len(files),
 "msg_user": msg_user,
 "prose_chars": len(prose),
 "raw_chars": len(raw),
 "dates_min": dates[0] if dates else None,
 "dates_max": dates[-1] if dates else None,
 "date_count": len(dates),
 "code_marks": code_marks,
 "task_open": task_open,
 "task_done": task_done,
 "question_marks": qmarks,
 "exclamations": excl,
 "lexemes": dict(sorted(lexemes.items(), key=lambda x:-x[1])),
 "imperatives": dict(sorted(imp.items(), key=lambda x:-x[1])),
 "errors": dict(sorted(err.items(), key=lambda x:-x[1])),
 "ports": dict(sorted(port.items(), key=lambda x:-x[1])),
 "extensions": dict(sorted(ext.items(), key=lambda x:-x[1])),
 "docker_refs": docker_cmds,
 "git_refs": git_cmds,
 "pm2_refs": pm2_cmds,
 "npm_refs": npm_cmds,
 "curl_refs": curl_cmds,
}
print(json.dumps(out, ensure_ascii=False, indent=1))
