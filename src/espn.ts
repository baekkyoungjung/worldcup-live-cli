import type { MatchSnapshot, MatchState, RawItem } from './types.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const UA = 'e2e-monitor/1.0 (+https://github.com)';

export interface ScoreboardEntry {
  id: string;
  name: string;
  state: MatchState;
  detail: string;
  home: string;
  away: string;
  homeScore: string;
  awayScore: string;
  dateUtc: string;
}

export type FetchResult<T> = { ok: true; data: T } | { ok: false; error: string; rawBody?: string };

async function getJson(url: string): Promise<FetchResult<unknown>> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, rawBody: body.slice(0, 4000) };
    try {
      return { ok: true, data: JSON.parse(body) };
    } catch {
      return { ok: false, error: 'invalid JSON', rawBody: body.slice(0, 4000) };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchScoreboard(league: string): Promise<FetchResult<ScoreboardEntry[]>> {
  const res = await getJson(`${BASE}/${league}/scoreboard`);
  if (!res.ok) return res;
  try {
    const d = res.data as any;
    const entries: ScoreboardEntry[] = (d.events ?? []).map((e: any) => {
      const comp = e.competitions?.[0] ?? {};
      const find = (side: string) => (comp.competitors ?? []).find((c: any) => c.homeAway === side) ?? {};
      const home = find('home');
      const away = find('away');
      return {
        id: String(e.id ?? ''),
        name: String(e.shortName ?? e.name ?? ''),
        state: (e.status?.type?.state ?? 'unknown') as MatchState,
        detail: String(e.status?.type?.detail ?? ''),
        home: String(home.team?.abbreviation ?? '?'),
        away: String(away.team?.abbreviation ?? '?'),
        homeScore: String(home.score ?? '-'),
        awayScore: String(away.score ?? '-'),
        dateUtc: String(e.date ?? ''),
      };
    });
    return { ok: true, data: entries };
  } catch (e) {
    return { ok: false, error: `schema: ${e}`, rawBody: JSON.stringify(res.data).slice(0, 4000) };
  }
}

/**
 * summary 1콜이 데몬의 한 tick 전부다: 상태+clock+스코어(header), commentary, keyEvents.
 * 어떤 필드도 신뢰하지 않는다 — 비공식 API는 언제든 모양이 바뀐다.
 */
export async function fetchSummary(league: string, eventId: string): Promise<FetchResult<MatchSnapshot>> {
  const res = await getJson(`${BASE}/${league}/summary?event=${encodeURIComponent(eventId)}`);
  if (!res.ok) return res;
  try {
    return { ok: true, data: parseSummary(res.data, eventId) };
  } catch (e) {
    return {
      ok: false,
      error: `schema: ${e instanceof Error ? e.message : e}`,
      rawBody: JSON.stringify(res.data).slice(0, 8000),
    };
  }
}

export function parseSummary(data: unknown, eventId: string): MatchSnapshot {
  const d = data as any;
  const comp = d?.header?.competitions?.[0];
  if (!comp) throw new Error('header.competitions[0] 없음');

  const status = comp.status ?? {};
  const find = (side: string) => (comp.competitors ?? []).find((c: any) => c.homeAway === side) ?? {};
  const home = find('home');
  const away = find('away');
  const abbrOf = (c: any) => String(c.team?.abbreviation ?? c.team?.displayName ?? '?');
  const nameOf = (c: any) => String(c.team?.displayName ?? c.team?.abbreviation ?? '?');

  // play.team은 displayName만 주므로 풀네임 → abbr 매핑을 만들어 둔다
  const teamAbbrByName = new Map<string, string>([
    [nameOf(home), abbrOf(home)],
    [nameOf(away), abbrOf(away)],
  ]);

  const commentary: any[] = Array.isArray(d.commentary) ? d.commentary : [];
  const keyEvents: any[] = Array.isArray(d.keyEvents) ? d.keyEvents : [];
  const keyEventsOnly = commentary.length === 0 && keyEvents.length > 0;

  const items: RawItem[] = keyEventsOnly
    ? keyEvents.map((k) => normalizeKeyEvent(k, teamAbbrByName)).filter((x): x is RawItem => x !== null)
    : commentary.map((c) => normalizeCommentary(c, teamAbbrByName)).filter((x): x is RawItem => x !== null);

  return {
    matchId: eventId,
    state: (status.type?.state ?? 'unknown') as MatchSnapshot['state'],
    statusDetail: String(status.type?.detail ?? ''),
    homeTeam: nameOf(home),
    awayTeam: nameOf(away),
    homeAbbr: abbrOf(home),
    awayAbbr: abbrOf(away),
    homeScore: toInt(home.score),
    awayScore: toInt(away.score),
    venue: String(d?.gameInfo?.venue?.fullName ?? ''),
    minuteNum: parseClockMinute(String(status.displayClock ?? '')),
    items,
    keyEventsOnly,
  };
}

function normalizeCommentary(c: any, teamAbbrByName: Map<string, string>): RawItem | null {
  if (c == null || typeof c !== 'object') return null;
  const seq = c.sequence;
  if (seq === undefined || seq === null) return null;
  const play = c.play ?? {};
  const clock = play.clock ?? {};
  const minute = String(clock.displayValue ?? c.time?.displayValue ?? '');
  const text = String(c.text ?? play.text ?? '').trim();
  if (!text) return null;
  return {
    id: `seq:${seq}`,
    typeId: String(play.type?.id ?? ''),
    typeText: String(play.type?.text ?? ''),
    text,
    minuteNum: parseClockMinute(minute) || Math.ceil(Number(clock.value ?? 0) / 60),
    minute,
    player: play.participants?.[0]?.athlete?.displayName ?? undefined,
    teamAbbr: teamAbbrByName.get(String(play.team?.displayName ?? '')) ?? undefined,
  };
}

function normalizeKeyEvent(k: any, teamAbbrByName: Map<string, string>): RawItem | null {
  if (k == null || typeof k !== 'object' || k.id == null) return null;
  const clock = k.clock ?? {};
  const minute = String(clock.displayValue ?? '');
  return {
    id: `ke:${k.id}`,
    typeId: String(k.type?.id ?? ''),
    typeText: String(k.type?.text ?? ''),
    text: String(k.text ?? k.shortText ?? k.type?.text ?? '').trim(),
    minuteNum: parseClockMinute(minute) || Math.ceil(Number(clock.value ?? 0) / 60),
    minute,
    player: k.participants?.[0]?.athlete?.displayName ?? undefined,
    teamAbbr: teamAbbrByName.get(String(k.team?.displayName ?? '')) ?? undefined,
    scoringPlay: k.scoringPlay === true,
  };
}

/** "84'" / "45'+3'" / "90'+2'" → 분 정수 */
export function parseClockMinute(display: string): number {
  const m = /^(\d+)'/.exec(display);
  return m ? Number(m[1]) : 0;
}

function toInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
