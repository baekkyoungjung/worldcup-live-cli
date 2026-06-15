import { execFile } from 'node:child_process';
import type { Config, Language, MatchEvent, MatchSnapshot } from './types.js';

/**
 * 각색 전략 (실측 근거): claude -p 1회 지연 중앙값 ~11s, 최단 6.8s — 3s 고속 폴링 주기를
 * 못 따라온다. 따라서 위험 상황(error/critical)은 템플릿으로 즉시 출력하고, 흐름 이벤트만
 * 배치 1회 호출로 각색한다(기동 고정비 상각). 실패·timeout이면 호출부가 언어 템플릿 폴백을 쓴다.
 * 톤은 언어별 STYLE_GUIDE가 정한다 — 어느 언어든 직역이 아닌 '로깅 스타일 중계'로 재작성한다.
 */

const STYLE_GUIDE_KO = [
  '당신은 축구 경기를 로그(logger)처럼 중계한다. 각 이벤트를 한 줄짜리 한국어 중계 멘트로 바꿔라.',
  '- severity가 분위기를 정한다: log=담담한 흐름, warn=위험 조짐(세트피스·위험지역 전개), error=박스 안 결정적 위기.',
  '- 위험 상황은 어느 팀 골문/박스 쪽인지 짚어라. 예) "스코틀랜드가 오른쪽에서 코너킥을 얻습니다", "해이티 페널티 박스 안에서 위험한 상황이 오갑니다".',
  '- 스코어·시간·선수명은 입력에 있는 것만 쓰고 절대 바꾸거나 지어내지 않는다. 어시스트·부상·관중 등 입력에 없는 사실 금지.',
  '- 타임스탬프와 [level] 태그는 시스템이 붙인다. 멘트 본문만 출력하라(태그·접두사·따옴표 없이).',
  '- 팀명·선수명 등 고유명사만 원문 표기를 허용하고 나머지는 한국어로 쓴다.',
].join('\n');

const STYLE_GUIDE_EN = [
  'You are narrating a football match like a logger. Rewrite each event as a one-line English commentary.',
  '- Severity sets the mood: log=calm flow, warn=danger signs (set pieces, build-up in dangerous areas), error=clear-cut chance inside the box.',
  '- For danger, name which team\'s goal/box it threatens. e.g. "Scotland win a corner on the right", "A dangerous moment inside the Haiti box".',
  '- Use only the scores, times and player names present in the input; never change or invent them. No assists, injuries or crowd details that are not in the input.',
  '- The timestamp and [level] tag are added by the system. Output only the comment body (no tag, prefix or quotes).',
  '- Keep proper nouns (team/player names) as given; write everything else in natural English.',
].join('\n');

function styleGuide(lang: Language): string {
  return lang === 'ko' ? STYLE_GUIDE_KO : STYLE_GUIDE_EN;
}

/** narrateBatch 프롬프트의 언어별 문구 — 출력 언어와 일치시켜 일관성을 높인다 */
const PROMPT_LABELS: Record<Language, { match: string; score: string; instr: (n: number) => string; events: string }> = {
  ko: {
    match: '경기',
    score: '현재 스코어',
    instr: (n) => `아래 이벤트 각각을 위 규칙대로 한 줄 멘트로 바꿔라.\n출력은 JSON 문자열 배열 하나만. 길이 ${n}, 이벤트 순서 그대로.`,
    events: '이벤트:',
  },
  en: {
    match: 'Match',
    score: 'Current score',
    instr: (n) =>
      `Rewrite each event below into a one-line commentary per the rules above.\nOutput exactly one JSON array of strings. Length ${n}, in the same order as the events.`,
    events: 'Events:',
  },
};

export class Narrator {
  private available: boolean | null = null;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    if (this.config.narrator.mode === 'template') return false;
    if (this.available !== null) return this.available;
    this.available = await new Promise<boolean>((resolve) => {
      const watchdog = setTimeout(() => resolve(false), 12_000);
      execFile('claude', ['--version'], { timeout: 10_000, killSignal: 'SIGKILL' }, (err) => {
        clearTimeout(watchdog);
        resolve(!err);
      });
    });
    return this.available;
  }

  /**
   * 이벤트 묶음을 1회 호출로 각색. 실패·timeout·개수 불일치 시 null — 호출부가 한국어 폴백.
   * 반환: 이벤트 순서와 같은 멘트 문자열 배열.
   */
  async narrateBatch(events: MatchEvent[], snap: MatchSnapshot): Promise<(string | null)[] | null> {
    if (events.length === 0) return [];
    if (!(await this.isAvailable())) return null;

    const list = events
      .map((e, i) => `${i + 1}. [${e.minute}] (${e.category}/${e.severity}) ${e.rawText}`)
      .join('\n');
    const lang = this.config.language;
    const L = PROMPT_LABELS[lang] ?? PROMPT_LABELS.en;
    const prompt = [
      styleGuide(lang),
      '',
      `${L.match}: ${snap.homeTeam}(${snap.homeAbbr}) vs ${snap.awayTeam}(${snap.awayAbbr})`,
      `${L.score}: ${snap.homeAbbr} ${snap.homeScore} : ${snap.awayScore} ${snap.awayAbbr}`,
      '',
      L.instr(events.length),
      '',
      L.events,
      list,
    ].join('\n');

    const out = await this.run(prompt, this.config.narrator.timeoutSec * 1000);
    if (out === null) return null;
    const parsed = extractJsonArray(out);
    if (!parsed || parsed.length !== events.length) return null;
    return parsed.map((s) => sanitizeDesc(s));
  }

  /** 단건 각색 (사후 보강용) */
  async narrateOne(event: MatchEvent, snap: MatchSnapshot): Promise<string | null> {
    const batch = await this.narrateBatch([event], snap);
    return batch?.[0] ?? null;
  }

  private run(prompt: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const watchdog = setTimeout(() => resolve(null), timeoutMs + 5_000);
      execFile(
        'claude',
        ['-p', prompt, '--model', this.config.narrator.model],
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          clearTimeout(watchdog);
          resolve(err ? null : stdout);
        },
      );
    });
  }
}

function extractJsonArray(out: string): string[] | null {
  const m = /\[[\s\S]*\]/.exec(out);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) return arr;
  } catch {
    // fallthrough
  }
  return null;
}

/** 각색 출력 위생 처리 — 한 줄, 길이 제한, 마크다운 잔재 제거 */
export function sanitizeDesc(s: string): string {
  let d = s.replace(/```[\s\S]*?```/g, ' ').replace(/[`*_>#]/g, '');
  d = d.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  d = d.replace(/\s+/g, ' ').trim();
  if (d.length > 140) d = d.slice(0, 139) + '…';
  return d;
}
