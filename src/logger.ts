import fs from 'node:fs';
import path from 'node:path';

const WRAP_COL = 100;

export function matchLogPath(logDir: string, matchId: string): string {
  return path.join(logDir, `match-${matchId}.log`);
}

/** 중계 종료 마커 — writer(daemon/replay)가 최종 보고까지 다 쓴 뒤에만 생성한다 */
export function matchDonePath(logDir: string, matchId: string): string {
  return path.join(logDir, `match-${matchId}.done`);
}

/** 현재 로그를 쓰는 프로세스 pid — follow가 idle/stalled를 구분하는 근거 */
export function writerPidPath(logDir: string, matchId: string): string {
  return path.join(logDir, `match-${matchId}.writer.pid`);
}

export class MatchLogger {
  readonly logPath: string;
  readonly rawPath: string;
  private donePath: string;
  private pidPath: string;
  private wrapIndent: number;

  constructor(logDir: string, matchId: string, wrapIndent: number) {
    fs.mkdirSync(logDir, { recursive: true });
    this.logPath = matchLogPath(logDir, matchId);
    this.rawPath = path.join(logDir, `match-${matchId}.raw.jsonl`);
    this.donePath = matchDonePath(logDir, matchId);
    this.pidPath = writerPidPath(logDir, matchId);
    // 음수면 repeat가 throw, WRAP_COL 이상이면 wrap이 무한 루프 — 스킨 입력은 신뢰하지 않는다
    this.wrapIndent = Number.isFinite(wrapIndent) ? Math.min(Math.max(0, Math.trunc(wrapIndent)), WRAP_COL - 40) : 8;
  }

  /** 위장 로그 한 줄. 길면 wrapIndent 들여쓰기로 줄바꿈 — README 예시의 2행 포맷 */
  line(text: string): void {
    try {
      fs.appendFileSync(this.logPath, this.wrap(text) + '\n');
    } catch {
      // 디스크 풀 등 append 실패에도 데몬은 죽지 않는다 — 다음 tick에 재시도될 뿐
    }
  }

  /**
   * tier-2 스트리밍: 여러 줄을 호흡 끊어 한 줄씩 flush.
   * 줄 사이 지연은 캐스터의 호흡 — 다음 폴링 주기를 침범하지 않는 범위로 clamp.
   */
  async stream(lines: string[], gapMs: number): Promise<void> {
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await sleep(gapMs);
      this.line(lines[i]);
    }
  }

  /**
   * 미리 조판된 텍스트(골 애니메이션 프레임)의 raw append — wrap 없이 그대로.
   * ANSI 색 코드가 길이 계산에 섞이면 wrap이 아트를 찢는다.
   */
  art(text: string): void {
    try {
      fs.appendFileSync(this.logPath, text + '\n');
    } catch {
      // 프레임 하나 유실은 연출 문제일 뿐 — 데몬은 계속 간다
    }
  }

  /**
   * 위장 로그를 오염시키지 않는 사이드카. 스키마 변경·장애 시 raw JSON은 여기 쌓인다.
   * (위장 원칙: 메인 로그에 이벤트가 아닌 것을 흘리지 않는다)
   */
  raw(kind: string, payload: unknown): void {
    const entry = { ts: new Date().toISOString(), kind, payload };
    try {
      fs.appendFileSync(this.rawPath, JSON.stringify(entry) + '\n');
    } catch {
      // 디스크 장애에도 데몬은 죽지 않는다
    }
  }

  /**
   * 중계 종료 마커. 반드시 최종 보고의 마지막 라인 append가 끝난 뒤에 불러야 한다 —
   * follow는 "done 존재 + EOF 도달"을 동시에 봐야 종료로 판정하지만, done이 보고
   * 중간에 먼저 생기면 잔여 라인을 버리고 턴을 끝내는 race가 된다.
   */
  markDone(): void {
    try {
      fs.writeFileSync(this.donePath, new Date().toISOString());
    } catch {
      // 마커 실패 시 follow가 idle/stalled로 버틸 뿐 — 치명 아님
    }
  }

  /** 이전 경기(또는 이전 재생)의 stale done 제거 — writer 기동 직후 호출 */
  clearDone(): void {
    try {
      fs.unlinkSync(this.donePath);
    } catch {
      // 없으면 그만
    }
  }

  markWriter(): void {
    try {
      fs.writeFileSync(this.pidPath, String(process.pid));
    } catch {
      // pid 마커 실패 — follow가 stalled로 오판할 수 있을 뿐, 중계는 계속된다
    }
  }

  clearWriter(): void {
    try {
      fs.unlinkSync(this.pidPath);
    } catch {
      // 이미 없으면 그만
    }
  }

  private wrap(text: string): string {
    if (text.length <= WRAP_COL) return text;
    if (WRAP_COL - this.wrapIndent <= 0) return text; // 이중 방어 — 무한 루프 불가
    const indent = ' '.repeat(this.wrapIndent);
    const out: string[] = [];
    let rest = text;
    let first = true;
    while (rest.length > 0) {
      const width = first ? WRAP_COL : WRAP_COL - this.wrapIndent;
      if (rest.length <= width) {
        out.push(first ? rest : indent + rest);
        break;
      }
      let cut = rest.lastIndexOf(' ', width);
      if (cut < width * 0.6) cut = width; // 공백이 너무 앞이면 강제 절단
      out.push((first ? '' : indent) + rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
      first = false;
    }
    return out.join('\n');
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
