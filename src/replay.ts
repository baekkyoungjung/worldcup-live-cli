import fs from 'node:fs';
import { celebrateGoal } from './celebrate.js';
import { loadConfig } from './config.js';
import { fetchSummary } from './espn.js';
import { MatchLogger, sleep } from './logger.js';
import { Narrator } from './narrate.js';
import { renderEvent, renderFinalReport, renderReplay } from './render.js';
import { resolveSkin } from './skin.js';
import { classify } from './tier.js';
import type { MatchEvent, MatchSnapshot } from './types.js';

const STREAM_GAP_MS = 600;
const MIN_GAP_MS = 700; // 같은 분 안의 연속 이벤트도 숨은 쉬고 나온다
const MAX_GAP_MS = 25_000; // HT 등 큰 점프가 리플레이를 정지시키지 않게

export interface ReplayOptions {
  league?: string;
  configPath?: string;
  /** 경기 시간 압축 배율. 15면 90분 경기가 ~6분 (기본 15) */
  speed?: number;
}

/**
 * 가짜 라이브: 끝난 경기의 commentary를 분 단위 페이스로 압축 재생한다.
 * 데몬과 달리 상태 영속화·폴링이 없고, 로그 파일은 새로 쓴다 — 순수 시청용.
 * 사실 불변 원칙은 동일: 스코어·시간·선수명은 원데이터, 페이스만 가짜다.
 */
export async function runReplay(eventId: string, opts: ReplayOptions = {}): Promise<void> {
  const config = loadConfig(opts.configPath);
  if (opts.league) config.league = opts.league;
  const speed = Math.max(1, Number(opts.speed) || 15);
  const skin = resolveSkin(config, process.cwd());
  const logger = new MatchLogger(config.logDir, eventId, skin.wrapIndent);
  const narrator = new Narrator(config);

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

  // 리플레이는 항상 처음부터 — 이전 로그를 비우고 시작
  try {
    fs.writeFileSync(logger.logPath, '');
  } catch {
    // 비우기 실패해도 append로 진행
  }

  const events = snap.items
    .map((i) => classify(i, config))
    .filter((e) => e.tier > 0);

  process.stdout.write(
    `[e2e-monitor] replay — match ${eventId} (${snap.homeAbbr} ${snap.homeScore}:${snap.awayScore} ${snap.awayAbbr}), ` +
      `x${speed}, ~${Math.ceil((95 / speed) * 10) / 10}분 예상\n` +
      `[e2e-monitor] tail -f ${logger.logPath}\n`,
  );

  // 진행 중 스코어를 직접 굴린다 — 스냅샷은 최종 스코어라 골 fact에 그대로 쓰면 스포일러다
  const running: MatchSnapshot = { ...snap, homeScore: 0, awayScore: 0 };
  const highlights: MatchEvent[] = [];
  const pendingReplays: Promise<void>[] = [];
  let prevMinute = 0;

  // commentary에 kickoff type 항목이 없는 경기가 흔하다 — 킥오프는 항상 합성으로 연다
  const kickoff: MatchEvent = {
    id: 'replay:kickoff',
    category: 'kickoff',
    tier: 2,
    minuteNum: 0,
    minute: "0'",
    rawText: 'kickoff',
  };
  await logger.stream(renderEvent(kickoff, running, skin), STREAM_GAP_MS);

  let halftimeDone = false;
  let fulltimeDone = false;
  for (const e of events) {
    if (e.category === 'kickoff') continue; // 합성으로 이미 알렸다
    // 라인업·공지 등 킥오프 전(0') 잡담은 침묵 — 데몬과 동일 원칙
    if (e.minuteNum === 0 && e.category === 'generic') continue;
    // HT/FT 텍스트 변형이 둘 다 오는 경기가 있다 — 한 번만
    if (e.category === 'halftime') {
      if (halftimeDone) continue;
      halftimeDone = true;
    }
    if (e.category === 'fulltime') {
      if (fulltimeDone) continue;
      fulltimeDone = true;
    }

    const gap = Math.max(MIN_GAP_MS, Math.min(MAX_GAP_MS, (e.minuteNum - prevMinute) * (60_000 / speed)));
    await sleep(gap);
    prevMinute = Math.max(prevMinute, e.minuteNum);

    if (e.category === 'goal') {
      // 골 텍스트("Goal! Mexico 1, South Africa 0.")가 당시 스코어의 정본
      bumpScore(running, e);
      highlights.push(e);
    }
    if (e.category === 'red') highlights.push(e);

    if (e.tier === 2) {
      await logger.stream(renderEvent(e, running, skin), STREAM_GAP_MS);
      // 골 애니메이션: replay는 순차 재생이라 await가 정당하다 — 다음 이벤트는 어차피 페이스 대기다.
      // retrace 각색은 애니메이션 뒤에 시작시켜 프레임 사이에 끼어들지 않게 한다 (데몬과 달리 가능한 사치)
      if (e.category === 'goal' && config.goalAnimation) {
        await celebrateGoal(logger).catch(() => {});
      }
      if ((e.category === 'goal' || e.category === 'red') && pendingReplays.length < 2) {
        const snapAt = { ...running };
        pendingReplays.push(
          narrator
            .narrateOne(e, skin)
            .then((desc) => {
              if (!desc) return;
              const line = renderReplay(e, snapAt, skin, desc);
              if (line) logger.line(line);
            })
            .catch(() => {}),
        );
      }
    } else {
      for (const line of renderEvent(e, running, skin)) logger.line(line);
    }
  }

  await Promise.race([Promise.allSettled(pendingReplays), sleep(15_000)]);
  await logger.stream(renderFinalReport(snap, highlights.slice(0, 20), skin), 300);
  process.stdout.write(`[e2e-monitor] replay finished — ${snap.homeAbbr} ${snap.homeScore}:${snap.awayScore} ${snap.awayAbbr}\n`);
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
