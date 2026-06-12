import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, Skin } from './types.js';

const SKINS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skins');

/**
 * skins/*.md 파서. 구조:
 *   --- frontmatter (name/description/detect/wrapIndent) ---
 *   # 각색 가이드  ← claude 프롬프트 주입부
 *   # 라인 템플릿  ← ```ini key = value``` 블록
 */
export function parseSkin(md: string, fallbackName: string): Skin {
  const fm = /^---\n([\s\S]*?)\n---/.exec(md);
  const meta: Record<string, string> = {};
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = /^(\w+):\s*(.*)$/.exec(line.trim());
      if (m) meta[m[1]] = m[2];
    }
  }
  let detect: string[] = [];
  try {
    detect = JSON.parse(meta.detect ?? '[]');
  } catch {
    detect = [];
  }

  // 종료 조건은 다음 헤딩(h1~h6) 또는 문서 끝 — 섹션 순서를 바꿔도 guide가 비지 않는다
  const guideMatch = /#{1,6}\s*각색 가이드\s*\n([\s\S]*?)(?=\n#{1,6}\s|$)/.exec(md);
  const guide = (guideMatch?.[1] ?? '').trim();

  // ```ini 블록 전부 병합 — 컨트리뷰터가 블록을 섹션별로 나눠도 키가 사라지지 않는다
  const templates: Record<string, string> = {};
  for (const ini of md.matchAll(/```ini\n([\s\S]*?)```/g)) {
    for (const line of ini[1].split('\n')) {
      const m = /^([\w.]+)\s*=\s*(.*)$/.exec(line);
      if (m) templates[m[1]] = m[2];
    }
  }

  const name = meta.name ?? fallbackName;
  // 무음 실패 방지 — 깨진 스킨은 데몬이 풀타임 내내 0줄을 쓰게 만든다
  if (Object.keys(templates).length === 0) {
    process.stderr.write(`[e2e-monitor] 스킨 "${name}": 라인 템플릿(\`\`\`ini 블록)이 비어 있음 — 출력이 없을 것\n`);
  } else {
    for (const key of ['kickoff.fact', 'goal.fact', 'generic.flavor']) {
      if (!templates[key]) process.stderr.write(`[e2e-monitor] 스킨 "${name}": 권장 키 ${key} 누락\n`);
    }
  }
  if (!guide) {
    process.stderr.write(`[e2e-monitor] 스킨 "${name}": "# 각색 가이드" 섹션이 비어 있음 — 각색 톤이 빠진다\n`);
  }

  const rawIndent = Number(meta.wrapIndent);
  return {
    name,
    description: meta.description ?? '',
    detect,
    wrapIndent: Number.isFinite(rawIndent) ? Math.min(Math.max(0, Math.trunc(rawIndent)), 60) : 8,
    guide,
    templates,
  };
}

export function listSkins(): string[] {
  if (!fs.existsSync(SKINS_DIR)) return [];
  return fs
    .readdirSync(SKINS_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => f.replace(/\.md$/, ''))
    .sort(); // readdir 순서는 파일시스템 의존 — detect 평가 순서를 결정론적으로
}

export function loadSkinByName(name: string): Skin | null {
  const file = path.join(SKINS_DIR, `${name}.md`);
  if (!fs.existsSync(file)) return null;
  return parseSkin(fs.readFileSync(file, 'utf8'), name);
}

/**
 * 스킨 결정: config.skin 정본 → cwd 마커 추정 → ts-dev (위장 안전 기본값).
 * cwd 추정은 detect 패턴 파일이 cwd에 존재하는 첫 스킨을 고른다.
 */
export function resolveSkin(config: Config, cwd: string): Skin {
  if (config.skin) {
    const s = loadSkinByName(config.skin);
    if (s) return s;
    process.stderr.write(`[e2e-monitor] 스킨 "${config.skin}" 없음 — cwd 추정으로 폴백\n`);
  }
  for (const name of listSkins()) {
    const s = loadSkinByName(name);
    if (!s || s.detect.length === 0) continue;
    const hit = s.detect.some((pattern) => {
      if (pattern.includes('*')) {
        const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        try {
          return fs.readdirSync(cwd).some((f) => re.test(f));
        } catch {
          return false;
        }
      }
      return fs.existsSync(path.join(cwd, pattern));
    });
    if (hit) return s;
  }
  return loadSkinByName('ts-dev') ?? parseSkin('', 'empty');
}

/** {placeholder} 치환. 미정의 키는 빈 문자열 — 형식 줄이 깨지지 않게 */
export function fillTemplate(tpl: string, vars: Record<string, string | number | undefined>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}
