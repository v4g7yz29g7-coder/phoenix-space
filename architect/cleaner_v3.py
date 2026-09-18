#!/usr/bin/env python3
"""cleaner_v3.py — извлекает полные циклы диалога (user + assistant).
Диалог = танец, а не монолог."""
import json, re, sys
from pathlib import Path

RAW = Path('corpus/architect/raw')
OUT = Path('corpus/architect/dialogues')
OUT.mkdir(parents=True, exist_ok=True)

def clean(t):
    if not t: return ''
    t = re.sub(r'```[\s\S]*?```', '[CODE]', t)
    t = re.sub(r'https?://\S+', '[URL]', t)
    t = re.sub(r'\s+', ' ', t).strip()
    return t

def extract_turns(dialog):
    """Из mapping берёт REQUEST + следующий RESPONSE."""
    mapping = dialog.get('mapping', {})
    msgs = []
    for nid, node in mapping.items():
        m = node.get('message')
        if not m: continue
        ts = m.get('inserted_at', '')
        for frag in m.get('fragments') or []:
            t = frag.get('type')
            c = frag.get('content', '')
            if t == 'REQUEST':
                msgs.append({'role': 'user', 'content': c, 'ts': ts})
            elif t == 'RESPONSE':
                msgs.append({'role': 'assistant', 'content': c, 'ts': ts})
    msgs.sort(key=lambda x: x['ts'])

    turns = []
    i = 0
    while i < len(msgs):
        if msgs[i]['role'] == 'user':
            user_t = msgs[i]
            asst = None
            for j in range(i + 1, len(msgs)):
                if msgs[j]['role'] == 'assistant':
                    asst = msgs[j]; break
            turns.append({
                'user': clean(user_t['content']),
                'assistant': clean(asst['content']) if asst else None,
                'ts': user_t['ts'],
            })
        i += 1
    return turns

def main():
    src = RAW / 'conversations.json'
    if not src.exists():
        print(f'❌ {src} не найден'); return 1
    print(f'📖 Читаю {src} ({src.stat().st_size/1e6:.1f} MB)...')
    with open(src, encoding='utf-8') as f:
        dialogs = json.load(f)
    print(f'✅ Загружено {len(dialogs)} диалогов\n')

    total_turns = 0
    with_pairs = 0
    pairs_count = 0

    for i, d in enumerate(dialogs, 1):
        title = d.get('title', 'untitled')[:50]
        turns = extract_turns(d)
        if not turns: continue
        with_pairs += 1
        total_turns += len(turns)
        pairs_count += sum(1 for t in turns if t['assistant'])

        safe = re.sub(r'[^\w]', '_', title)[:40]
        out = OUT / f'{i:03d}_{safe}.json'
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(turns, f, ensure_ascii=False, indent=2)

        if i % 20 == 0 or i == len(dialogs):
            print(f'  ... {i}/{len(dialogs)}')

    stats = {
        'dialogs': len(dialogs),
        'dialogs_with_turns': with_pairs,
        'total_turns': total_turns,
        'complete_pairs': pairs_count,
    }
    with open(OUT / '_stats.json', 'w', encoding='utf-8') as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)

    print(f'\n=== ИТОГ ===')
    for k, v in stats.items():
        print(f'  {k}: {v}')
    return 0

if __name__ == '__main__':
    sys.exit(main())
