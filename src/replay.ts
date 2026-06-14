import fs from 'node:fs';
import { loadConfig } from './config.js';
import { fetchSummary } from './espn.js';
import { MatchLogger, sleep } from './logger.js';
import { renderAmbient, renderEventLines, renderFinalReport } from './render.js';
import { classify } from './tier.js';
import type { Config, MatchEvent, MatchSnapshot } from './types.js';

const STREAM_GAP_MS = 600;
const MIN_GAP_MS = 700; // 같은 분 안의 연속 이벤트도 숨은 쉬고 나온다
const MAX_GAP_MS = 25_000; // HT 등 큰 점프가 리플레이를 정지시키지 않게
const AMBIENT_CHUNK_MS = 3000; // 이벤트 사이 긴 공백을 앰비언트 멘트로 메운다

export interface ReplayOptions {
  league?: string;
  configPath?: string;
  /** 경기 시간 압축 배율. 15면 90분 경기가 ~6분 (기본 15) */
  speed?: number;
}

/**
 * 가짜 라이브: 끝난 경기의 commentary를 분 단위 페이스로 압축 재생한다.
 * 데몬과 동일한 로거형 출력. 사실 불변: 스코어·시간·선수명은 원데이터, 페이스만 가짜다.
 */
export async function runReplay(eventId: string, opts: ReplayOptions = {}): Promise<void> {
  const config = loadConfig(opts.configPath);
  if (opts.league) config.league = opts.league;
  const speed = Math.max(1, Number(opts.speed) || 15);
  const logger = new MatchLogger(config.logDir, eventId);

  logger.clearDone();
  logger.markWriter();
  try {
    await runReplayBody(eventId, config, speed, logger);
  } finally {
    logger.clearWriter();
  }
}

async function runReplayBody(eventId: string, config: Config, speed: number, logger: MatchLogger): Promise<void> {
  const res = await fetchSummary(config.league, eventId);
  if (!res.ok) {
    process.stderr.write(`[e2e-monitor] summary 실패: ${res.error}\n`);
    process.exitCode = 1;
    return;
  }
  const snap = res.data;
  if (snap.state !== 'post') {
    process.stderr.write(
      `[e2e-monitor] match ${eventId}는 아직 ${snap.state} — replay는 끝난 경기 전용, 라이브는 daemon을 쓰자\n`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    fs.writeFileSync(logger.logPath, ''); // 리플레이는 항상 처음부터
  } catch {
    // 비우기 실패해도 append로 진행
  }

  const events = snap.items.map((i) => classify(i, config)).filter((e) => e.tier > 0);

  process.stdout.write(
    `[e2e-monitor] 리플레이 시작 — match ${eventId} (${snap.homeAbbr} ${snap.homeScore}:${snap.awayScore} ${snap.awayAbbr}), ` +
      `x${speed}, ~${Math.ceil((95 / speed) * 10) / 10}분 예상\n` +
      `[e2e-monitor] 터미널 시청: tail -f ${logger.logPath}\n`,
  );

  // 진행 스코어를 직접 굴린다 — 스냅샷은 최종 스코어라 골 fact에 그대로 쓰면 스포일러다
  const running: MatchSnapshot = { ...snap, homeScore: 0, awayScore: 0 };
  const highlights: MatchEvent[] = [];
  let prevMinute = 0;

  const kickoff: MatchEvent = {
    id: 'replay:kickoff',
    category: 'kickoff',
    tier: 2,
    severity: 'log',
    minuteNum: 0,
    minute: "0'",
    rawText: 'kickoff',
  };
  await logger.stream(renderEventLines(kickoff, running), STREAM_GAP_MS);

  let halftimeDone = false;
  let fulltimeDone = false;
  for (const e of events) {
    if (e.category === 'kickoff') continue;
    if (e.minuteNum === 0 && e.category === 'generic') continue; // 킥오프 전 잡담 침묵
    if (e.category === 'halftime') {
      if (halftimeDone) continue;
      halftimeDone = true;
    }
    if (e.category === 'fulltime') {
      if (fulltimeDone) continue;
      fulltimeDone = true;
    }

    const gap = Math.max(MIN_GAP_MS, Math.min(MAX_GAP_MS, (e.minuteNum - prevMinute) * (60_000 / speed)));
    await pacedGap(gap, logger);
    prevMinute = Math.max(prevMinute, e.minuteNum);

    if (e.category === 'goal') {
      bumpScore(running, e); // 골 텍스트의 당시 스코어가 정본
      highlights.push(e);
    }
    if (e.category === 'red') highlights.push(e);

    await logger.stream(renderEventLines(e, running), STREAM_GAP_MS);
  }

  await logger.stream(renderFinalReport(snap, highlights.slice(0, 20)), 300);
  logger.markDone();
  process.stdout.write(`[e2e-monitor] 리플레이 종료 — ${snap.homeAbbr} ${snap.homeScore}:${snap.awayScore} ${snap.awayAbbr}\n`);
}

/** 이벤트 사이의 긴 공백을 앰비언트 멘트로 메우며 대기한다 — 정적을 없앤다 */
async function pacedGap(gapMs: number, logger: MatchLogger): Promise<void> {
  let remaining = gapMs;
  let first = true;
  while (remaining > 0) {
    const chunk = Math.min(remaining, AMBIENT_CHUNK_MS);
    await sleep(chunk);
    remaining -= chunk;
    if (!first && remaining > 0) logger.line(renderAmbient());
    first = false;
  }
}

/** "Goal! Mexico 2, South Africa 0." → 진행 스코어 갱신. 파싱 실패 시 득점 팀 +1 폴백 */
function bumpScore(running: MatchSnapshot, e: MatchEvent): void {
  const m = /Goal!\s+(.+?)\s+(\d+)[,:]\s+(.+?)\s+(\d+)\./.exec(e.rawText);
  if (m) {
    const assign = (name: string, score: number) => {
      if (overlaps(name, running.homeTeam)) running.homeScore = score;
      else if (overlaps(name, running.awayTeam)) running.awayScore = score;
    };
    assign(m[1], Number(m[2]));
    assign(m[3], Number(m[4]));
    return;
  }
  if (e.teamAbbr === running.homeAbbr) running.homeScore++;
  else if (e.teamAbbr === running.awayAbbr) running.awayScore++;
}

function overlaps(a: string, b: string): boolean {
  const tokens = (s: string) => new Set(s.toLowerCase().split(/\s+/).filter((t) => t.length > 3));
  const ta = tokens(a);
  for (const t of tokens(b)) if (ta.has(t)) return true;
  return false;
}
