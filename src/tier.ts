import type { Category, Config, MatchEvent, MatchSnapshot, RawItem, Severity, Tier } from './types.js';

/**
 * 분류기. 한 RawItem을:
 *  - tier (0 스킵 / 1 기본 / 2 고속 폴링 승격) — 폴링 케이던스 결정
 *  - severity (log/warn/error/critical) — 로거 라인의 위험도/색/이모지 결정
 *  - category — 서사 분기
 * 로 정규화한다.
 *
 * severity는 "필드 위치 = 골 위험도"를 근사한다. 위치 좌표가 없으므로
 * 이벤트 타입(base) + ESPN 텍스트 키워드(upgrade)로 판정한다. 절대 강등하지 않는다.
 */

/** "이름 (팀) 액션 at N'" 템플릿 노이즈 — 출력 스킵 (실측 63%가 Pass) */
const NOISE_TYPE_IDS = new Set([
  '118', '177', '176', '63', '178', '181', '148', '182', '65', '196', '179',
  '141', '110', '162', '77', '185', '180', '78', '202', '195', '200', '96', '124',
]);

const CHANCE_TYPE_IDS = new Set(['106', '117', '135', '136']); // 슛 온/오프/블록/골대

const SEVERITY_RANK: Record<Severity, number> = { log: 0, warn: 1, error: 2, critical: 3 };

// 박스 안/결정적 기회 — error로 끌어올린다
const ERROR_KEYWORDS =
  /\b(in the box|inside the box|penalty area|penalty box|close range|point-?blank|one-?on-?one|1v1|clear chance|big chance|rebound|tap-?in|breakaway|through on goal|denied by the|brilliant save|great save|forces? the goalkeeper)\b/i;
// 위험 지역 전개·세트피스 — warn으로 끌어올린다
const WARN_KEYWORDS =
  /\b(corner|free kick|free-kick|cross(?:es|ed)?|whipped|dangerous|into the box|through ball|threat|counter-?attack|set-?piece|long throw|swung in|delivery)\b/i;

interface Rule {
  category: Category;
  tier: Tier;
}

function ruleFor(item: RawItem): Rule {
  const t = item.typeText;
  const text = item.text;

  // 경기 경계 — 저볼륨·고신호
  if (item.typeId === '80' || /^Kickoff$/i.test(t)) return { category: 'kickoff', tier: 2 };
  if (item.typeId === '81' || /^First Half ends/i.test(text)) return { category: 'halftime', tier: 2 };
  if (item.typeId === '82' || /^Second Half begins/i.test(text)) return { category: 'resume', tier: 2 };
  if (item.typeId === '83' || /^Match ends/i.test(text) || /^Second Half ends/i.test(text)) {
    return { category: 'fulltime', tier: 2 };
  }
  // 수분 휴식 / 쿨링 브레이크 — typeId가 불안정해 텍스트로 잡는다
  if (/cooling break|water break|drinks break|hydration break/i.test(t) || /cooling break|water break|drinks break|hydration break/i.test(text)) {
    return { category: 'break', tier: 1 };
  }

  // 노이즈는 골 판정보다 먼저 — 110 "Goal Kick"이 /^Goal/에 잡히는 오분류 방지
  if (NOISE_TYPE_IDS.has(item.typeId)) return { category: 'generic', tier: 0 };
  if (/^Goal kick/i.test(t)) return { category: 'generic', tier: 0 };

  if (/^Goal\b/i.test(t) || /^Own Goal/i.test(t) || /^Goal!/i.test(text) || item.scoringPlay) {
    return { category: 'goal', tier: 2 };
  }
  if (/penalty/i.test(t) || /penalty/i.test(text)) return { category: 'penalty', tier: 2 };
  if (/^VAR/i.test(t) || /^VAR/i.test(text)) return { category: 'var', tier: 2 };
  if (item.typeId === '93' || /red card/i.test(text)) return { category: 'red', tier: 2 };

  // tier-1: 기본 흐름
  if (item.typeId === '94' || /yellow card/i.test(text)) return { category: 'yellow', tier: 1 };
  if (item.typeId === '76' || /^Substitution/i.test(text)) return { category: 'sub', tier: 1 };
  if (CHANCE_TYPE_IDS.has(item.typeId)) return { category: 'chance', tier: 1 };
  if (item.typeId === '95') return { category: 'setpiece', tier: 1 };
  if (item.typeId === '66' || item.typeId === '68' || item.typeId === '122') return { category: 'generic', tier: 1 };
  if (item.typeId === '129' || item.typeId === '130') return { category: 'generic', tier: 1 };

  // 미지의 type: 템플릿 텍스트면 노이즈, 자연어 문장이면 tier-1
  if (/\) [A-Za-z ]+ at \d+'$/.test(text)) return { category: 'generic', tier: 0 };
  return { category: 'generic', tier: 1 };
}

/** 카테고리 기본 severity */
function baseSeverity(category: Category): Severity {
  switch (category) {
    case 'goal':
      return 'critical';
    case 'penalty':
    case 'chance':
      return 'error';
    case 'var':
    case 'red':
    case 'setpiece':
      return 'warn';
    default:
      return 'log';
  }
}

/** 카테고리 base + 텍스트 키워드 upgrade (강등 없음) */
export function severityFor(category: Category, text: string, typeText: string): Severity {
  let sev = baseSeverity(category);
  const blob = `${text} ${typeText}`;
  // VAR은 골/PK 관련이면 error로
  if (category === 'var' && /goal|penalty/i.test(blob)) sev = max(sev, 'error');
  if (ERROR_KEYWORDS.test(blob)) sev = max(sev, 'error');
  else if (WARN_KEYWORDS.test(blob)) sev = max(sev, 'warn');
  return sev;
}

function max(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export function classify(item: RawItem, config: Config): MatchEvent {
  const base = ruleFor(item);
  let tier = base.tier;
  if (tier === 1 && config.tier2.typeIds.includes(item.typeId)) tier = 2;
  return {
    id: item.id,
    category: base.category,
    tier,
    severity: severityFor(base.category, item.text, item.typeText),
    minuteNum: item.minuteNum,
    minute: item.minute || `${item.minuteNum}'`,
    rawText: item.text,
    typeId: item.typeId,
    typeText: item.typeText,
    player: item.player,
    teamAbbr: item.teamAbbr,
  };
}

/** error/critical 또는 박빙 후반 — 고속 폴링을 켜야 하는 위험 상황인가 */
export function isHot(event: MatchEvent): boolean {
  return event.tier === 2 && SEVERITY_RANK[event.severity] >= SEVERITY_RANK.error;
}

/** 80'+ 박빙 — 상황 전체가 고속 폴링 */
export function isEndgameClose(snap: MatchSnapshot, config: Config): boolean {
  return (
    snap.state === 'in' &&
    snap.minuteNum >= config.tier2.lateGameMinute &&
    Math.abs(snap.homeScore - snap.awayScore) <= config.tier2.closeScoreDiff
  );
}
