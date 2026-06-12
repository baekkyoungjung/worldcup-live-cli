import { execFile } from 'node:child_process';
import type { Config, MatchEvent, Skin } from './types.js';

/**
 * 각색 전략 (실측 근거 — README [내부] 메모 ②):
 * claude -p 1회 지연 중앙값 10.95s, 최단 6.8s — 3s 폴링 주기 초과 확정.
 * 따라서 동기 각색은 하지 않는다.
 * - tier-1: tick에 쌓인 이벤트를 배치 1회 호출로 각색 (기동 고정비 상각), timeout 시 템플릿
 * - tier-2: 템플릿 즉시 출력이 우선 — 각색은 비동기 replay 보강 라인으로만 합류
 */
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
      // watchdog: 자식이 SIGTERM을 무시하거나 손자가 stdout 파이프를 물고 있으면
      // execFile 콜백이 영원히 안 올 수 있다 — 데몬을 동결시키지 않는다
      const watchdog = setTimeout(() => resolve(false), 12_000);
      execFile('claude', ['--version'], { timeout: 10_000, killSignal: 'SIGKILL' }, (err) => {
        clearTimeout(watchdog);
        resolve(!err);
      });
    });
    return this.available;
  }

  /**
   * 이벤트 묶음을 1회 호출로 각색. 실패·timeout·개수 불일치 시 null — 호출부가 템플릿 폴백.
   * 반환: 이벤트 순서와 같은 desc 문자열 배열.
   */
  async narrateBatch(events: MatchEvent[], skin: Skin): Promise<(string | null)[] | null> {
    if (events.length === 0) return [];
    if (!(await this.isAvailable())) return null;

    const list = events
      .map((e, i) => `${i + 1}. [${e.minute}] (${e.category}) ${e.rawText}`)
      .join('\n');
    const prompt = [
      skin.guide,
      '',
      '아래 축구 이벤트 각각에 대해 위 가이드를 따르는 묘사 텍스트를 생성하라.',
      '- 묘사 본문만. 타임스탬프·상태 태그·접두사는 시스템이 붙인다.',
      '- 스코어·시간·선수명은 입력에 있는 것만 사용하고 절대 바꾸지 않는다.',
      '- 입력에 없는 사실(어시스트, 부상, 관중 수 등)을 지어내지 않는다.',
      `- 출력은 JSON 문자열 배열 하나만. 길이 ${events.length}, 이벤트 순서 그대로.`,
      '',
      '이벤트:',
      list,
    ].join('\n');

    const out = await this.run(prompt, this.config.narrator.timeoutSec * 1000);
    if (out === null) return null;
    const parsed = extractJsonArray(out);
    if (!parsed || parsed.length !== events.length) return null;
    return parsed.map((s) => sanitizeDesc(s));
  }

  /** tier-2 사후 보강용 단건 각색 */
  async narrateOne(event: MatchEvent, skin: Skin): Promise<string | null> {
    const batch = await this.narrateBatch([event], skin);
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

/** 각색 출력 위생 처리 — 형식이 서사를 이긴다: 한 줄, 길이 제한, 마크다운 잔재 제거 */
export function sanitizeDesc(s: string): string {
  let d = s.replace(/```[\s\S]*?```/g, ' ').replace(/[`*_>#]/g, '');
  d = d.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  d = d.replace(/\s+/g, ' ').trim();
  if (d.length > 140) d = d.slice(0, 139) + '…';
  return d;
}
