'use strict';
// moat_search.js — поиск удачных решений в Рве
// Использование: 
//   const moat = require('./moat_search');
//   const result = moat.find({ file: 'evolution/mutation.js', prompt: 'Сделай ...' });
//   if (result) console.log(result.answer);

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const MOAT_DIR = path.join(ROOT, 'memory', 'moat');
const SOLUTIONS_DIR = path.join(MOAT_DIR, 'solutions');
const INDEX_FILE = path.join(MOAT_DIR, 'index.json');

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return { solutions: [] };
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
  catch (e) { return { solutions: [] }; }
}

function extractFile(prompt) {
  if (!prompt) return null;
  const m = String(prompt).match(/[a-zA-Z0-9_\-/]+\.(js|md|json|ts)/);
  return m ? m[0] : null;
}

// Нормализация промпта: убрать спецсимволы, оставить ключевые слова
function normalizePrompt(prompt) {
  if (!prompt) return '';
  return String(prompt)
    .toLowerCase()
    .replace(/[^a-zа-я0-9_\-/\.\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

// Ключевые слова из промпта (топ-10 по длине)
function keywords(prompt, max = 10) {
  const norm = normalizePrompt(prompt);
  const words = norm.split(' ').filter(w => w.length > 3);
  const unique = [...new Set(words)];
  return unique.sort((a, b) => b.length - a.length).slice(0, max);
}

// Точный поиск по файлу (самый быстрый)
function findByFile(file) {
  const index = loadIndex();
  const matches = index.solutions.filter(s => s.task_file === file);
  if (matches.length === 0) return null;
  // Берём с самым высоким score
  return matches.sort((a, b) => (b.winner_score || 0) - (a.winner_score || 0))[0];
}

// Поиск по ключевым словам (fuzzy)
function findByKeywords(prompt, minMatch = 2) {
  const index = loadIndex();
  const kw = keywords(prompt);
  if (kw.length === 0) return null;

  const scored = index.solutions.map(s => {
    const solKw = keywords(s.task_prompt || '', 20);
    const common = kw.filter(k => solKw.some(sk => sk.includes(k) || k.includes(sk)));
    return { solution: s, common: common.length };
  }).filter(x => x.common >= minMatch);

  if (scored.length === 0) return null;
  return scored.sort((a, b) => b.common - a.common)[0].solution;
}

// Главный API: ищет решение по задаче
// Возвращает { hash, answer, winner, score, match_type } или null
function find(task) {
  const file = task.file || extractFile(task.prompt);
  const prompt = task.prompt || '';

  // 1. Точный поиск по файлу
  if (file) {
    const byFile = findByFile(file);
    if (byFile) {
      const full = loadSolution(byFile.hash);
      if (full) {
        return {
          hash: byFile.hash,
          answer: full.answer,
          winner: byFile.winner,
          score: byFile.winner_score,
          match_type: 'exact_file',
          task_file: byFile.task_file,
        };
      }
    }
  }

  // 2. Fuzzy по ключевым словам
  const byKw = findByKeywords(prompt, 3);
  if (byKw) {
    const full = loadSolution(byKw.hash);
    if (full) {
      return {
        hash: byKw.hash,
        answer: full.answer,
        winner: byKw.winner,
        score: byKw.winner_score,
        match_type: 'keywords',
        task_file: byKw.task_file,
      };
    }
  }

  return null;
}

function loadSolution(hash) {
  const f = path.join(SOLUTIONS_DIR, hash + '.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { return null; }
}

function stats() {
  const index = loadIndex();
  const byFile = {};
  index.solutions.forEach(s => {
    byFile[s.task_file] = (byFile[s.task_file] || 0) + 1;
  });
  return {
    total: index.solutions.length,
    unique_files: Object.keys(byFile).length,
    top_files: Object.entries(byFile).sort((a,b) => b[1]-a[1]).slice(0, 10),
  };
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'stats') {
    console.log(JSON.stringify(stats(), null, 2));
  } else if (cmd === 'find' && process.argv[3]) {
    const r = find({ file: process.argv[3], prompt: process.argv[4] || '' });
    console.log(JSON.stringify(r ? { ...r, answer: r.answer.slice(0, 200) + '...' } : null, null, 2));
  } else {
    console.log('Использование:');
    console.log('  node moat_search.js stats');
    console.log('  node moat_search.js find <file> [prompt]');
  }
}

module.exports = { find, findByFile, findByKeywords, stats, loadIndex };
