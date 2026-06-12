import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MatchLogger, sleep } from './logger.js';

const ART_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../art/goal');

/**
 * 골 애니메이션: 경기의 정점에서만 10초간 위장을 해제한다 (사용자 결정 사항).
 * tail -f + append-only 제약에서 '움직임'은 새 줄이 쌓이는 리듬으로만 만들 수 있다 —
 * 커서 제어·화면 지우기는 쓰지 않고, 프레임을 순차 append하는 점진 공개로 연출한다.
 * 아트는 art/goal/*.txt 플러그인 — 파일 형식은 skins/README.md 참조.
 */

const MAX_FRAMES = 40; // 폭주 아트팩이 로그를 도배하지 않게
const MIN_DELAY_MS = 50;
const MAX_DELAY_MS = 2000;
const MAX_TOTAL_MS = 15_000; // 초과 시 전체 딜레이를 비례 축소 — 연출이 중계를 점령하지 않는다
const MAX_LINE_WIDTH = 110; // logger.wrap을 우회하므로 여기서 자체 제한
const DEFAULT_DELAY_MS = 600;

const COLOR_TOKENS: Record<string, string> = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

interface Frame {
  text: string;
  delayMs: number;
}

let cachedArts: Frame[][] | null = null;
let inFlight = false;

/**
 * 골 애니메이션 한 사이클 재생. 어떤 실패도 throw하지 않는다 —
 * 연출 실패는 중계 실패가 아니고, 데몬은 죽지 않는다.
 * 이미 재생 중이면 즉시 반환 (10초 내 연속골은 두 번째 연출을 조용히 포기).
 */
export async function celebrateGoal(logger: MatchLogger): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const arts = loadArts();
    if (arts.length === 0) return;
    const frames = arts[Math.floor(Math.random() * arts.length)];
    for (const f of frames) {
      logger.art(f.text);
      await sleep(f.delayMs);
    }
  } catch {
    // 애니메이션이 무슨 짓을 해도 중계는 계속된다
  } finally {
    inFlight = false;
  }
}

function loadArts(): Frame[][] {
  if (cachedArts) return cachedArts;
  const arts: Frame[][] = [];
  try {
    for (const file of fs.readdirSync(ART_DIR).filter((f) => f.endsWith('.txt')).sort()) {
      try {
        const frames = parseArt(fs.readFileSync(path.join(ART_DIR, file), 'utf8'));
        if (frames.length > 0) arts.push(frames);
      } catch {
        // 깨진 아트팩 하나가 나머지를 막지 않는다
      }
    }
  } catch {
    // art 디렉토리 자체가 없어도 내장 폴백으로 동작
  }
  if (arts.length === 0) arts.push(parseArt(BUILTIN_ART));
  cachedArts = arts;
  return arts;
}

/**
 * 아트팩 파서. 프레임 구분은 단독 `---` 줄, 프레임 안의 `#delay <ms>`는
 * 그 프레임 출력 후 다음 프레임까지의 간격 (50~2000ms clamp, 기본 600).
 * `# `로 시작하는 줄은 주석(`####` 아트는 보존). 색은 {yellow} {cyan} {green} {red} {white}
 * {dim} {bold} {reset} 토큰만 치환.
 */
export function parseArt(src: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of src.split(/^---\s*$/m)) {
    if (frames.length >= MAX_FRAMES) break;
    let delayMs = DEFAULT_DELAY_MS;
    const artLines: string[] = [];
    for (const line of block.replace(/^\n+|\n+$/g, '').split('\n')) {
      const d = /^#delay\s+(\d+)\s*$/.exec(line);
      if (d) delayMs = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Number(d[1])));
      if (/^#delay\b/.test(line)) continue; // 오타("#delay abc")도 소비 — 지시문이 아트로 새지 않게
      if (/^#(\s|$)/.test(line)) continue; // 주석 줄 — `# `만 주석, `####` 같은 아트는 보존
      artLines.push(renderLine(line));
    }
    const text = artLines.join('\n');
    if (text.trim().length === 0) continue;
    frames.push({ text, delayMs });
  }
  // 총 길이 상한: 케이던스는 fire-and-forget으로 이미 보호되지만, 로그 점유 시간도 연출의 일부다
  const total = frames.reduce((s, f) => s + f.delayMs, 0);
  if (total > MAX_TOTAL_MS) {
    const scale = MAX_TOTAL_MS / total;
    for (const f of frames) f.delayMs = Math.round(f.delayMs * scale); // MIN 재적용 없음 — 상한이 정확해야 한다
  }
  return frames;
}

function renderLine(line: string): string {
  // 가시 문자와 색 코드를 분리해 두고 clip은 가시 문자에만 적용한다 —
  // raw slice는 escape 시퀀스 한가운데를 자를 수 있다 (맨몸 ESC가 로그에 남는 사고)
  let colored = false;
  let out = '';
  let budget = MAX_LINE_WIDTH;
  let last = 0;
  const emit = (text: string) => {
    const take = text.slice(0, Math.max(0, budget));
    out += take;
    budget -= take.length;
  };
  for (const m of line.matchAll(/\{(\w+)\}/g)) {
    emit(line.slice(last, m.index));
    const code = COLOR_TOKENS[m[1]];
    if (code === undefined) {
      emit(m[0]); // 미지의 토큰은 그대로 — 아트의 일부일 수 있다
    } else {
      out += code; // 색 코드는 폭 예산을 먹지 않는다
      colored = true;
    }
    last = m.index + m[0].length;
  }
  emit(line.slice(last));
  // 색을 쓴 줄은 반드시 reset으로 닫는다 — 다음 위장 라인까지 노랗게 물들지 않게
  return colored && !out.endsWith(COLOR_TOKENS.reset) ? out + COLOR_TOKENS.reset : out;
}

/** art/goal/ 디렉토리가 없거나 전부 깨졌을 때의 내장 폴백 — default.txt의 사본 */
const BUILTIN_ART = `#delay 450
{dim}        ●{reset}
---
#delay 380
{dim}                ●{reset}
---
#delay 300
{dim}                          ●{reset}
---
#delay 240
{cyan}                                    ●{reset}
---
#delay 200
{cyan}                                            ●▸{reset}
---
#delay 600
{bold}{yellow}                                               ⊗ 골망이 찢어진다{reset}
---
#delay 400
{bold}{yellow}      ██████╗  ██████╗  █████╗  ██╗      ██╗{reset}
---
#delay 400
{bold}{yellow}     ██╔════╝ ██╔═══██╗██╔══██╗ ██║      ██║{reset}
---
#delay 400
{bold}{yellow}     ██║  ███╗██║   ██║███████║ ██║      ██║{reset}
---
#delay 400
{bold}{yellow}     ██║   ██║██║   ██║██╔══██║ ██║      ╚═╝{reset}
---
#delay 400
{bold}{yellow}     ╚██████╔╝╚██████╔╝██║  ██║ ███████╗ ██╗{reset}
---
#delay 400
{bold}{yellow}      ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚══════╝ ╚═╝{reset}
---
#delay 900
{yellow}        ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦{reset}
---
#delay 700
{bold}{yellow}     G  O  O  O  O  O  O  O  O  O  A  L  !{reset}
---
#delay 700
{yellow}           G O O O O O A L !{reset}
---
#delay 750
{dim}                 g o o a l …{reset}
---
#delay 900
{dim}                     관중석이 무너진다. 숨을 고르고, 중계로 복귀.{reset}
---
#delay 250
{dim}────────────────────────────────────────────────────{reset}
`;
