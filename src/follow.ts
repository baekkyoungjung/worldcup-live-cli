import fs from 'node:fs';
import { loadConfig } from './config.js';
import { matchDonePath, matchLogPath, sleep, writerPidPath } from './logger.js';

/**
 * follow: 위장 로그의 새 라인만 떼어 오는 long-poll 1회분.
 *
 * Claude Code 세션이 중계를 직접 표시하려면 "tool 호출 한 번 = 새 라인 한 배치"
 * 모양이 필요하다 — tail -f는 turn을 영구 블록하고, 백그라운드 출력은 사용자에게
 * 실시간 표시되지 않는다. 그래서 byte cursor 기반으로:
 *   1) cursor 이후 새 데이터가 생길 때까지 대기 (wait 한도)
 *   2) 생기면 잠깐 묶어서(디바운스) 한 배치로 수집
 *   3) 마지막 완성 라인까지만 출력하고 새 cursor를 마커로 반환
 *
 * 같은 바이트는 두 번 읽히지 않는다 — 중복 출력의 구조적 차단.
 * 출력 마지막 줄은 항상 `[follow] cursor=<n> <status>` 마커다.
 *   live    새 라인을 출력했다 — 즉시 다음 follow
 *   idle    wait 한도까지 새 데이터 없음 (writer는 살아 있음)
 *   done    writer가 최종 보고까지 마침 + cursor가 EOF — 중계 끝
 *   stalled writer 프로세스가 죽었는데 done이 없다 — 비정상 종료
 */

const POLL_MS = 300;
// 골 애니메이션 프레임 최대 간격(2000ms)보다 길게 — 연출이 한 배치로 묶인다
const QUIET_MS = 2500;
const MAX_COLLECT_MS = 20_000;
// wait + 수집(20s) + tsx 부팅이 Bash 기본 timeout(120s)을 넘지 않게 상한을 둔다
const MAX_WAIT_SEC = 75;
const DEFAULT_WAIT_SEC = 60;
// 방금 백그라운드로 띄운 daemon/replay가 이전 회차의 done을 아직 못 지운 레이스 흡수
const STALE_DONE_GRACE_MS = 8_000;

export interface FollowOptions {
  configPath?: string;
  /** 마지막으로 읽은 byte 위치. 0이면 처음부터 */
  cursor?: number;
  /** 새 데이터 대기 한도(초). 5~75로 clamp */
  waitSec?: number;
}

export async function runFollow(eventId: string, opts: FollowOptions = {}): Promise<void> {
  const config = loadConfig(opts.configPath);
  const logPath = matchLogPath(config.logDir, eventId);
  const donePath = matchDonePath(config.logDir, eventId);
  const pidPath = writerPidPath(config.logDir, eventId);

  let cursor = Math.max(0, Math.trunc(Number(opts.cursor) || 0));
  const waitSec = Math.min(MAX_WAIT_SEC, Math.max(5, Math.trunc(Number(opts.waitSec) || DEFAULT_WAIT_SEC)));
  const deadline = Date.now() + waitSec * 1000;

  const sizeOf = (): number => {
    try {
      return fs.statSync(logPath).size;
    } catch {
      return -1; // 파일 없음
    }
  };
  const doneExists = () => fs.existsSync(donePath);

  // 첫 호출(cursor=0)에서 stale done이 보이면 잠깐 기다린다 — 새 writer가 지우면 진행,
  // 유예 후에도 그대로면 진짜 끝난 로그다. 이때 과거 전체를 덤프하지 않고 종결만 알린다.
  if (cursor === 0 && doneExists()) {
    const size0 = sizeOf();
    const graceUntil = Date.now() + Math.min(STALE_DONE_GRACE_MS, waitSec * 1000);
    while (Date.now() < graceUntil && doneExists() && sizeOf() === size0) {
      await sleep(POLL_MS);
    }
    if (doneExists() && sizeOf() === size0) {
      emitMarker(Math.max(0, size0), 'done');
      return;
    }
  }

  // 새 데이터 대기
  for (;;) {
    const size = sizeOf();
    if (size >= 0 && size < cursor) cursor = 0; // truncation = replay가 새로 쓰기 시작 — 처음부터
    if (size > cursor) break;
    if (size >= 0 && cursor >= size && doneExists()) {
      emitMarker(cursor, 'done');
      return;
    }
    if (Date.now() > deadline) {
      emitMarker(cursor, writerAlive(pidPath) ? 'idle' : 'stalled');
      return;
    }
    await sleep(POLL_MS);
  }

  // 디바운스 수집 — tier-2 스트리밍·골 애니메이션 프레임들이 한 배치로 묶인다
  const collectStart = Date.now();
  let lastGrow = Date.now();
  let size = sizeOf();
  for (;;) {
    if (Date.now() - lastGrow >= QUIET_MS) break;
    if (Date.now() - collectStart >= MAX_COLLECT_MS) break;
    await sleep(POLL_MS);
    const s = sizeOf();
    if (s > size) {
      size = s;
      lastGrow = Date.now();
    }
  }

  // cursor → 마지막 완성 라인(개행)까지만. 쓰다 만 꼬리는 다음 호출 몫
  const chunk = readRange(logPath, cursor, size);
  const lastNl = chunk.lastIndexOf(0x0a);
  if (lastNl < 0) {
    emitMarker(cursor, writerAlive(pidPath) ? 'idle' : 'stalled');
    return;
  }
  const newCursor = cursor + lastNl + 1;
  const text = stripAnsi(chunk.subarray(0, lastNl + 1).toString('utf8'));
  process.stdout.write(text);
  emitMarker(newCursor, doneExists() && newCursor >= sizeOf() ? 'done' : 'live');
}

function emitMarker(cursor: number, status: 'live' | 'idle' | 'done' | 'stalled'): void {
  process.stdout.write(`[follow] cursor=${cursor} ${status}\n`);
}

function readRange(logPath: string, from: number, to: number): Buffer {
  if (to <= from) return Buffer.alloc(0);
  let fd: number | null = null;
  try {
    fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(to - from);
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    return buf.subarray(0, Math.max(0, n));
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 닫기 실패는 무시
      }
    }
  }
}

function writerAlive(pidPath: string): boolean {
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 세션 표시는 ANSI를 렌더하지 못한다 — 색만 벗기고 정렬(아트 모양)은 보존 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}
