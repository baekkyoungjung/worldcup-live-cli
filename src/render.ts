import { sanitizeDesc } from './narrate.js';
import { fillTemplate } from './skin.js';
import type { MatchEvent, MatchSnapshot, Skin } from './types.js';

/**
 * 사실 불변의 구조적 보장: fact 라인(.fact 템플릿)은 항상 스냅샷/원데이터에서
 * 직접 렌더되고 claude를 통과하지 않는다. 각색은 {desc} 한 칸에만 들어간다.
 */

export function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function buildVars(
  event: MatchEvent | null,
  snap: MatchSnapshot,
  desc?: string,
): Record<string, string | number | undefined> {
  // 사실 불변: 득점 주체를 모르면 비워 둔다 — 홈팀 디폴트는 절반 확률로 거짓말이다
  const scoring = event?.teamAbbr;
  const conceding =
    scoring === snap.homeAbbr ? snap.awayAbbr : scoring === snap.awayAbbr ? snap.homeAbbr : '';
  const scoringTeam =
    scoring === snap.homeAbbr ? snap.homeTeam : scoring === snap.awayAbbr ? snap.awayTeam : '';

  // 동일 tick 멀티 골 대비: ESPN 골 텍스트의 당시 스코어가 스냅샷보다 정확하다
  const fromText = event?.category === 'goal' ? parseScoreFromGoalText(event.rawText, snap) : null;

  return {
    time: nowStamp(),
    matchId: snap.matchId,
    venue: snap.venue || 'unknown-venue',
    homeTeam: snap.homeTeam,
    awayTeam: snap.awayTeam,
    homeAbbr: snap.homeAbbr,
    awayAbbr: snap.awayAbbr,
    homeScore: fromText?.home ?? snap.homeScore,
    awayScore: fromText?.away ?? snap.awayScore,
    minute: event?.minute ?? `${snap.minuteNum}'`,
    minuteNum: event?.minuteNum ?? snap.minuteNum,
    player: event?.player ?? '',
    teamAbbr: event?.teamAbbr ?? '',
    scoringAbbr: scoring ?? '',
    concedingAbbr: conceding,
    scoringTeam,
    rawText: event?.rawText ?? '',
    desc: desc ?? '',
  };
}

/** "Goal! Mexico 1, South Africa 0." → 홈/원정 매핑된 스코어 */
export function parseScoreFromGoalText(
  text: string,
  snap: MatchSnapshot,
): { home: number; away: number } | null {
  const m = /(?:Goal!|Own Goal[^.]*\.)\s+(.+?)\s+(\d+)[,:]\s+(.+?)\s+(\d+)\./.exec(text);
  if (!m) return null;
  const [, nameA, scoreA, nameB, scoreB] = m;
  const pairs: Array<[string, number]> = [
    [nameA.trim(), Number(scoreA)],
    [nameB.trim(), Number(scoreB)],
  ];
  let home: number | null = null;
  let away: number | null = null;
  for (const [name, score] of pairs) {
    if (matchesTeam(name, snap.homeTeam, snap.homeAbbr)) home = score;
    else if (matchesTeam(name, snap.awayTeam, snap.awayAbbr)) away = score;
  }
  return home !== null && away !== null ? { home, away } : null;
}

function matchesTeam(name: string, displayName: string, abbr: string): boolean {
  const n = name.toLowerCase();
  const d = displayName.toLowerCase();
  // ESPN 텍스트는 "Korea Republic", header는 "South Korea"처럼 어긋날 수 있다 — 토큰 교집합으로 판정
  if (n === d || n === abbr.toLowerCase()) return true;
  const tokens = (s: string) => new Set(s.split(/\s+/).filter((t) => t.length > 3));
  const a = tokens(n);
  const b = tokens(d);
  for (const t of a) if (b.has(t)) return true;
  return false;
}

function tpl(skin: Skin, key: string, fallbackKey?: string): string | null {
  return skin.templates[key] ?? (fallbackKey ? skin.templates[fallbackKey] : undefined) ?? null;
}

/**
 * 각색(claude)도 스킨 desc도 없을 때의 한국어 최후 폴백 — typeId 기준.
 * ESPN raw 영문 텍스트는 어떤 경로로도 중계 라인에 싣지 않는다.
 */
const KO_DESC_BY_TYPE: Record<string, string> = {
  '66': '파울 휘슬이 울린다, 흐름이 잠시 끊긴다',
  '68': '부심 깃발이 올라간다 — 오프사이드',
  '122': '핸드볼 선언',
  '129': '경기가 잠시 멈춘다',
  '130': '경기가 잠시 멈춘다',
};

/**
 * 이벤트 → 위장 로그 라인들. desc 폴백 체인: 각색 → 스킨 desc → typeId 한국어 맵.
 * 체인이 전부 비면 flavor 라인을 침묵시킨다 — 영문 raw를 흘리느니 버린다 (침묵도 위장).
 */
export function renderEvent(event: MatchEvent, snap: MatchSnapshot, skin: Skin, desc?: string | null): string[] {
  const cat = event.category;
  const vars0 = buildVars(event, snap);
  // 각색·스킨 desc 모두 외부 입력 — 개행·마크다운이 한 줄 형식을 깨지 않도록 항상 위생 처리
  let finalDesc = desc && desc.trim() ? sanitizeDesc(desc) : '';
  if (!finalDesc) {
    const fallbackTpl = tpl(skin, `${cat}.desc`, 'generic.desc');
    if (fallbackTpl) finalDesc = sanitizeDesc(fillTemplate(fallbackTpl, vars0).trim());
  }
  if (!finalDesc) finalDesc = KO_DESC_BY_TYPE[event.typeId ?? ''] ?? '';
  const vars = buildVars(event, snap, finalDesc);

  const lines: string[] = [];
  const factOnly = cat === 'kickoff' || cat === 'halftime' || cat === 'fulltime' || cat === 'resume';

  if (!factOnly) {
    // 득점 팀을 모르는 골은 팀 귀속이 박힌 goal.flavor 대신 generic으로 — 틀린 사실을 찍지 않는다
    const flavorKey = cat === 'goal' && !event.teamAbbr ? 'generic.flavor' : `${cat}.flavor`;
    const flavor = tpl(skin, flavorKey, 'generic.flavor');
    if (flavor && finalDesc) lines.push(fillTemplate(flavor, vars));
  }
  const fact = tpl(skin, `${cat}.fact`);
  if (fact) lines.push(fillTemplate(fact, vars));
  if (factOnly && lines.length === 0) {
    const generic = tpl(skin, 'generic.flavor');
    if (generic) lines.push(fillTemplate(generic, vars));
  }
  return lines;
}

/** tier-2 사후 각색이 도착했을 때 합류하는 보강 라인 */
export function renderReplay(event: MatchEvent, snap: MatchSnapshot, skin: Skin, desc: string): string | null {
  const replay = tpl(skin, 'replay.flavor');
  if (!replay) return null;
  return fillTemplate(replay, buildVars(event, snap, desc));
}

/** 경기 종료 최종 보고 */
export function renderFinalReport(snap: MatchSnapshot, highlights: MatchEvent[], skin: Skin): string[] {
  const lines: string[] = [];
  const vars = buildVars(null, snap);
  const header = tpl(skin, 'report.header');
  const lineTpl = tpl(skin, 'report.line');
  const footer = tpl(skin, 'report.footer');

  if (header) lines.push(fillTemplate(header, vars));
  if (lineTpl) {
    lines.push(fillTemplate(lineTpl, { ...vars, item: `FT ${snap.homeAbbr} ${snap.homeScore} : ${snap.awayScore} ${snap.awayAbbr}` }));
    for (const h of highlights) {
      const who = [h.minute, h.player || h.teamAbbr || '', labelOf(h)].filter(Boolean).join(' ');
      lines.push(fillTemplate(lineTpl, { ...vars, item: who }));
    }
  }
  if (footer) lines.push(fillTemplate(footer, vars));
  return lines;
}

function labelOf(e: MatchEvent): string {
  switch (e.category) {
    case 'goal':
      return '득점';
    case 'red':
      return '퇴장';
    case 'penalty':
      return 'PK';
    case 'yellow':
      return '경고';
    case 'var':
      return 'VAR';
    case 'sub':
      return '교체';
    case 'chance':
      return '기회';
    case 'setpiece':
      return '세트피스';
    default:
      // typeText는 ESPN 영문 — 최종 보고에 영문을 흘리지 않는다
      return '기록';
  }
}
