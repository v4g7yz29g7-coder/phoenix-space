from pathlib import Path

# Пробуем разные пути
CANDIDATES = [
    'agent_{N}.js',                    # ~/phoenix/agent_1.js
    'boxes/agent_{N}/agent_{N}.js',   # ~/phoenix/boxes/agent_1/agent_1.js
    'boxes/agent_{N}/STRATEGY.js',     # альтернатива
]

for n in [1, 7]:
    found = False
    for tmpl in CANDIDATES:
        f = Path(tmpl.replace('{N}', str(n)))
        if not f.exists():
            continue
        
        src = f.read_text()
        
        if 'ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА AI-1' in src:
            print(f'ℹ️ {f} уже пропатчен')
            found = True
            break
        
        # Вставляем после const STRATEGY = `
        old = 'const STRATEGY = `'
        new = '''const STRATEGY = `
ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА AI-1:
1. ВСЕГДА вызывай инструменты (read, write, edit, exec)
2. Если задача > 2 шагов — начни с read reference файлов
3. НИКОГДА не отвечай текстом без действий
4. Если сложно — сделай минимум: создай файл-заглушку через write
5. Всегда проверяй: exec("cd arena_lab && npx tsc --noEmit")
'''
        
        if old in src:
            src = src.replace(old, new, 1)
            f.write_text(src)
            print(f'✅ Патч применён: {f}')
            found = True
            break
        else:
            print(f'⚠️ {f} — не нашёл `const STRATEGY =`')
    
    if not found:
        print(f'❌ agent_{n}: файл не найден нигде')
