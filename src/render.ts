import { sanitizeDesc } from './narrate.js';
import type { MatchEvent, MatchSnapshot, Severity } from './types.js';

/**
 * 로거형 중계 렌더. 한 줄 형식:
 *   HH:MM:SS <이모지> <ANSI>[LEVEL]<reset> 한국어 멘트
 *
 * - 이모지는 라인에 박혀 있어 follow가 ANSI를 벗겨도 세션에 남는다(세션 severity 표시).
 * - ANSI 색은 tail -f 터미널용(warn=노랑, error/critical=빨강).
 * - 사실 불변: 골 라인의 스코어·시간은 항상 원데이터에서 직접 렌더하며 claude를 통과하지 않는다.
 */

const RESET = '\x1b[0m';

interface LevelStyle {
  label: string;
  emoji: string;
  ansi: string;
}

const LEVELS: Record<Severity, LevelStyle> = {
  log: { label: 'log', emoji: '', ansi: '' },
  warn: { label: 'warn', emoji: '🟡', ansi: '\x1b[33m' },
  error: { label: 'error', emoji: '🔴', ansi: '\x1b[31m' },
  critical: { label: 'CRITICAL', emoji: '🟥', ansi: '\x1b[1;31m' },
};

const CUE_ANSI = '\x1b[1;36m'; // [BREAK] — 청록 볼드, tail에서 눈에 띄게

export function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** severity 라인 한 줄 조립 */
export function formatLine(severity: Severity, text: string): string {
  const s = LEVELS[severity];
  const emoji = s.emoji ? `${s.emoji} ` : '';
  const tag = s.ansi ? `${s.ansi}[${s.label}]${RESET}` : `[${s.label}]`;
  return `${nowStamp()} ${emoji}${tag} ${text}`;
}

/** recap 트리거 겸 안내가 되는 브레이크 큐 라인. 중계 루프는 "[BREAK]"로 감지한다 */
export function formatCue(text: string): string {
  return `${nowStamp()} ${CUE_ANSI}[BREAK]${RESET} ${text}`;
}

const AMBIENT_POOL = [
  '중원에서 양 팀이 볼을 주고받습니다',
  '후방에서 천천히 빌드업을 가져갑니다',
  '측면을 활용한 전개를 시도합니다',
  '중앙 경합 — 소유권이 오갑니다',
  '템포를 늦추며 기회를 엿봅니다',
  '미드필드 싸움이 팽팽합니다',
  '롱볼로 전선을 끌어올립니다',
  '점유율 싸움이 이어집니다',
  '수비 라인을 정비하며 간격을 좁힙니다',
  '볼이 좌우로 분배됩니다',
  '전방 압박 수위를 끌어올립니다',
  '느린 호흡으로 경기를 운영합니다',
  '전방 압박에 패스가 끊깁니다',
  '백패스로 다시 빌드업을 시작합니다',
  '중원에서 인터셉트를 노립니다',
  '사이드라인을 따라 공이 흐릅니다',
];

/** 이벤트 없는 구간의 앰비언트 멘트 — log 레벨. 사실(스코어·시간)은 절대 담지 않는다 */
export function renderAmbient(): string {
  const text = AMBIENT_POOL[Math.floor(Math.random() * AMBIENT_POOL.length)];
  return formatLine('log', text);
}

function teamName(abbr: string | undefined, snap: MatchSnapshot): string {
  if (!abbr) return '';
  if (abbr === snap.homeAbbr) return snap.homeTeam;
  if (abbr === snap.awayAbbr) return snap.awayTeam;
  return abbr;
}

function opponentName(abbr: string | undefined, snap: MatchSnapshot): string {
  if (abbr === snap.homeAbbr) return snap.awayTeam;
  if (abbr === snap.awayAbbr) return snap.homeTeam;
  return '';
}

/**
 * 이벤트 → 로거 라인들. desc(각색)가 있으면 멘트로 쓰고, 없으면 한국어 폴백 템플릿.
 * 둘 다 비면 라인을 생략한다 — ESPN 영문 raw는 어떤 경로로도 출력하지 않는다.
 */
export function renderEventLines(event: MatchEvent, snap: MatchSnapshot, desc?: string | null): string[] {
  const cat = event.category;
  const team = teamName(event.teamAbbr, snap);
  const opp = opponentName(event.teamAbbr, snap);

  switch (cat) {
    case 'kickoff': {
      const venue = snap.venue ? ` @ ${snap.venue}` : '';
      return [formatLine('log', `킥오프 — ${snap.homeTeam} vs ${snap.awayTeam}${venue}`)];
    }
    case 'resume':
      return [formatLine('log', '후반전 시작')];
    case 'fulltime':
      // 스코어는 바로 뒤 renderFinalReport가 권위 있는 값으로 출력한다 — 여기서 스냅샷
      // 스코어를 또 찍으면 replay의 running 지연 등으로 최종 보고와 모순될 수 있다.
      return [formatLine('log', '경기 종료 — 풀타임 휘슬')];
    case 'halftime':
      return [formatCue('전반 종료 — 잠시 후 후반전')];
    case 'break':
      return [formatCue('수분 휴식 — 잠시 숨을 고릅니다')];
    case 'goal': {
      const score = parseScoreFromGoalText(event.rawText, snap) ?? { home: snap.homeScore, away: snap.awayScore };
      const scorer = event.player || teamName(event.teamAbbr, snap);
      const who = scorer ? `${scorer} — ` : '';
      return [formatLine('critical', `골! ${who}${snap.homeAbbr} ${score.home} : ${score.away} ${snap.awayAbbr}`)];
    }
    default: {
      const narration = (desc && desc.trim() ? sanitizeDesc(desc) : '') || fallbackKo(event, team, opp);
      return narration ? [formatLine(event.severity, narration)] : [];
    }
  }
}

/** 각색(claude)이 없을 때의 한국어 폴백 — 카테고리별. 영문 raw를 흘리지 않는다 */
function fallbackKo(event: MatchEvent, team: string, opp: string): string {
  const t = team || '공격 팀';
  switch (event.category) {
    case 'penalty':
      return `페널티킥 상황! ${t} 키커가 준비합니다`;
    case 'var':
      return 'VAR 판독이 진행됩니다';
    case 'red':
      return `${t} 레드카드 — 수적 변화가 생깁니다`;
    case 'yellow':
      return `${t} 옐로카드`;
    case 'sub':
      return `${t} 선수 교체`;
    case 'chance':
      return opp ? `${t}의 슛! ${opp} 골문을 위협합니다` : `슛 — 골문을 위협합니다`;
    case 'setpiece':
      return `${t} 세트피스 기회`;
    default:
      // 일반/파울/오프사이드 — typeId 기준 최후 폴백
      return KO_DESC_BY_TYPE[event.typeId ?? ''] ?? '경기가 이어집니다';
  }
}

const KO_DESC_BY_TYPE: Record<string, string> = {
  '66': '파울 — 흐름이 잠시 끊깁니다',
  '68': '오프사이드 — 공격이 멈춥니다',
  '122': '핸드볼 선언',
  '129': '경기가 잠시 멈춥니다',
  '130': '경기가 잠시 멈춥니다',
};

/** 경기 종료 최종 보고 — 로거 스타일 요약 */
export function renderFinalReport(snap: MatchSnapshot, highlights: MatchEvent[]): string[] {
  const lines: string[] = [];
  lines.push(formatLine('log', `── 최종 보고 ── ${snap.homeTeam} ${snap.homeScore} : ${snap.awayScore} ${snap.awayTeam}`));
  for (const h of highlights) {
    const who = [h.minute, h.player || teamName(h.teamAbbr, snap) || '', labelOf(h)].filter(Boolean).join(' ');
    lines.push(formatLine(h.severity, who));
  }
  lines.push(formatLine('log', '경기 종료. 수고하셨습니다.'));
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
      return '기록';
  }
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
  if (n === d || n === abbr.toLowerCase()) return true;
  const tokens = (s: string) => new Set(s.split(/\s+/).filter((t) => t.length > 3));
  const a = tokens(n);
  const b = tokens(d);
  for (const t of a) if (b.has(t)) return true;
  return false;
}
