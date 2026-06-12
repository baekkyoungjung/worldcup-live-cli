import fs from 'node:fs';
import path from 'node:path';
import type { MatchEvent, MatchState, RawItem } from './types.js';

type ItemSource = 'seq' | 'ke' | null;

interface PersistedState {
  seenIds: string[];
  lastState: MatchState;
  lastHomeScore: number;
  lastAwayScore: number;
  /** 마지막으로 '중계까지 마친' 스코어 — 헤더/commentary 갱신 시차로 인한 골 이중 중계 방지 */
  announcedHome: number;
  announcedAway: number;
  kickoffAnnounced: boolean;
  halftimeAnnounced: boolean;
  fulltimeAnnounced: boolean;
  lastSource: ItemSource;
  highlights: MatchEvent[];
}

/**
 * diff/상태 관리. 폴링 응답에서 "아직 중계 안 한 항목"만 골라내고,
 * 데몬 재시작 시 경기 전체를 재방송하지 않도록 디스크에 영속화한다.
 * ([내부] 메모 ④: v0 poll.ts 재사용 예정이었으나 v0 코드 부재 확인 — 신규 구현)
 */
export class MatchStateStore {
  private seen = new Set<string>();
  private statePath: string;
  lastState: MatchState = 'unknown';
  lastHomeScore = 0;
  lastAwayScore = 0;
  announcedHome = 0;
  announcedAway = 0;
  kickoffAnnounced = false;
  halftimeAnnounced = false;
  fulltimeAnnounced = false;
  lastSource: ItemSource = null;
  /** 최종 보고용 골/퇴장 — 재시작에도 살아남도록 영속화 */
  highlights: MatchEvent[] = [];

  constructor(logDir: string, matchId: string) {
    fs.mkdirSync(logDir, { recursive: true });
    this.statePath = path.join(logDir, `state-${matchId}.json`);
    this.load();
  }

  /**
   * 미방송 항목 반환 + seen 등록. commentary는 sequence 오름차순이 원본 순서다
   * (clock 없는 항목의 minuteNum=0이 맨 앞으로 점프하는 정렬 버그 방지 — 760415 실측).
   * commentary↔keyEvents 소스가 플립되면 id 체계(seq:/ke:)가 달라 전체가 fresh로 보이므로,
   * 그 배치는 통째로 흡수(absorb)해 경기 전체 재방송을 막는다.
   */
  takeNew(items: RawItem[], source: ItemSource): RawItem[] {
    const flipped = this.lastSource !== null && source !== null && this.lastSource !== source;
    this.lastSource = source ?? this.lastSource;

    const fresh = items.filter((it) => !this.seen.has(it.id));
    for (const it of fresh) this.seen.add(it.id);
    if (flipped) return []; // 한 tick 분량 유실 가능 — 골은 스코어 변화 합성이 보강한다

    fresh.sort((a, b) => {
      const sa = seqOf(a.id);
      const sb = seqOf(b.id);
      if (sa !== null && sb !== null) return sa - sb;
      // keyEvents는 분 기준, 분 미상(0)은 뒤로 — FT 항목이 골보다 먼저 나가지 않게
      return (a.minuteNum || 9999) - (b.minuteNum || 9999);
    });
    return fresh;
  }

  /** commentary 항목 없이 '중계된 적 없는' 스코어로 바뀐 경우 감지 (keyEvents-only 매치 보강) */
  scoreChanged(home: number, away: number): boolean {
    return home !== this.lastHomeScore || away !== this.lastAwayScore;
  }

  /** 이 스코어가 이미 중계(합성 또는 실제 골)됐는가 — 이중 중계 억제 */
  isAnnounced(home: number, away: number): boolean {
    return home === this.announcedHome && away === this.announcedAway;
  }

  markAnnounced(home: number, away: number): void {
    this.announcedHome = home;
    this.announcedAway = away;
    this.save();
  }

  addHighlight(e: MatchEvent): void {
    this.highlights.push(e);
    this.save();
  }

  update(state: MatchState, home: number, away: number): void {
    this.lastState = state;
    this.lastHomeScore = home;
    this.lastAwayScore = away;
    this.save();
  }

  markKickoff(): void {
    this.kickoffAnnounced = true;
    this.save();
  }

  markHalftime(): void {
    this.halftimeAnnounced = true;
    this.save();
  }

  markFulltime(): boolean {
    if (this.fulltimeAnnounced) return false;
    this.fulltimeAnnounced = true;
    this.save();
    return true;
  }

  private load(): void {
    try {
      const p: PersistedState = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.seen = new Set(p.seenIds);
      this.lastState = p.lastState;
      this.lastHomeScore = p.lastHomeScore;
      this.lastAwayScore = p.lastAwayScore;
      this.announcedHome = p.announcedHome ?? 0;
      this.announcedAway = p.announcedAway ?? 0;
      this.kickoffAnnounced = p.kickoffAnnounced;
      this.halftimeAnnounced = p.halftimeAnnounced;
      this.fulltimeAnnounced = p.fulltimeAnnounced ?? false;
      this.lastSource = p.lastSource ?? null;
      this.highlights = Array.isArray(p.highlights) ? p.highlights : [];
    } catch {
      // 첫 실행 — 빈 상태로 시작
    }
  }

  save(): void {
    const p: PersistedState = {
      seenIds: [...this.seen],
      lastState: this.lastState,
      lastHomeScore: this.lastHomeScore,
      lastAwayScore: this.lastAwayScore,
      announcedHome: this.announcedHome,
      announcedAway: this.announcedAway,
      kickoffAnnounced: this.kickoffAnnounced,
      halftimeAnnounced: this.halftimeAnnounced,
      fulltimeAnnounced: this.fulltimeAnnounced,
      lastSource: this.lastSource,
      highlights: this.highlights,
    };
    try {
      // temp write + rename으로 원자화 — 중단돼도 state 파일이 반쯤 깨지지 않는다
      fs.writeFileSync(this.statePath + '.tmp', JSON.stringify(p));
      fs.renameSync(this.statePath + '.tmp', this.statePath);
    } catch {
      // 영속화 실패는 치명적이지 않다 — 재시작 시 재방송될 뿐
    }
  }

  /** 경기 종료 후 상태 파일 정리 */
  cleanup(): void {
    try {
      fs.unlinkSync(this.statePath);
    } catch {
      // 없으면 그만
    }
  }
}

function seqOf(id: string): number | null {
  if (!id.startsWith('seq:')) return null;
  const n = Number(id.slice(4));
  return Number.isFinite(n) ? n : null;
}

/**
 * 같은 경기를 향한 데몬 동시 실행 방지 — 잠금 실패 시 기존 소유 pid 반환.
 * 죽은 pid의 stale lock은 회수한다.
 */
export function acquireLock(logDir: string, matchId: string): { ok: true; release: () => void } | { ok: false; pid: number } {
  fs.mkdirSync(logDir, { recursive: true });
  const lockPath = path.join(logDir, `daemon-${matchId}.lock`);
  const tryWrite = (): boolean => {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  };
  if (!tryWrite()) {
    let owner = NaN;
    try {
      owner = Number(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      // 읽기 실패 — stale로 취급
    }
    if (Number.isFinite(owner) && owner > 0 && isAlive(owner)) return { ok: false, pid: owner };
    try {
      fs.unlinkSync(lockPath); // stale 회수
    } catch {
      // 경쟁 상대가 먼저 지웠을 수 있다
    }
    if (!tryWrite()) return { ok: false, pid: -1 };
  }
  return {
    ok: true,
    release: () => {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // 이미 없으면 그만
      }
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
