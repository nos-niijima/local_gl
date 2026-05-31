#!/usr/bin/env node
/*
 * apply-rename.js — main(正式名称版) の内容を rename_ghost(名称変更版) へ変換する純粋置換。
 *
 * 使い方: node scripts/apply-rename.js <file> [<file> ...]
 *   指定ファイルを「その場で」置換する。
 *
 * 置換は順序が重要（長い名前=「室」付きを先に処理し、短縮形と衝突させない）。
 * main 側は常に正式名称なので冪等：二重適用しても新名称しか残らず無害。
 */
const fs = require('fs');

// [from, to] 上から順に適用する
const REPLACEMENTS = [
  ['図書室', '占い部屋'],   // 室付きの正式名を先に
  ['図書', '占い'],
  ['談話室', 'ラウンジ'],
  ['談話', 'ラウンジ'],
  ['操舵室', '運転室'],
  ['操舵', '運転'],
  ['ハデス', '狂人'],
  ['カロン', 'ゴースト'],
];

function applyToString(s) {
  for (const [a, b] of REPLACEMENTS) s = s.split(a).join(b);
  return s;
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node scripts/apply-rename.js <file> [<file> ...]');
    process.exit(2);
  }
  let changed = 0;
  for (const f of files) {
    const before = fs.readFileSync(f, 'utf8');
    const after = applyToString(before);
    if (after !== before) {
      fs.writeFileSync(f, after);
      changed++;
      console.log(`[rename] updated ${f}`);
    } else {
      console.log(`[rename] no change ${f}`);
    }
  }
  console.log(`[rename] done (${changed} file(s) changed)`);
}

if (require.main === module) main();
module.exports = { applyToString, REPLACEMENTS };
