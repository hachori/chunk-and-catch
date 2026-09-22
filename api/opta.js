// Vercel 서버리스 함수 — Opta(The Analyst) 축구 기사 가져오기
//
//   GET /api/opta            → 오늘의 기사(본문 포함) + 최근 기사 목록
//   GET /api/opta?id=261233  → 해당 기사 하나(본문 포함)
//
// theanalyst.com 은 WordPress 라서 공개 REST API 가 열려 있다.
// HTML 을 긁어오는 대신 이 API 를 쓴다 — 마크업이 바뀌어도 잘 안 깨지고, 발행일이
// 정확하게 온다. 본문은 서버에서 평문 단락으로 잘라 내려보낸다(브라우저에 남의
// 사이트 HTML 을 그대로 주입하지 않기 위해서이기도 하다).
//
// ⚠️ 기사 한 편은 1만 5천 자가 넘는다. /api/analyze 한 번에 통째로 넣을 수 없으므로
//    화면에서 '단락 하나'를 골라 분석하는 것을 전제로 단락 배열을 내려준다.

const WP = 'https://theanalyst.com/wp-json/wp/v2';

// 23 = premier-league.
// 사이트의 https://theanalyst.com/competition/premier-league/articles 가 그대로 이
// 카테고리 목록이다 (링크 순서까지 1:1 로 확인했다). 그 메뉴를 보고 고르는 것이므로
// 여기서 따로 손대지 않는다 — 가끔 다른 리그 기사가 섞여 있어도 그 페이지에 실린
// 기사라면 그대로 가져온다.
const PREMIER_LEAGUE_CATEGORY = 23;

// '오늘의 기사'를 고르는 기준 시각(한국 시간). 이 시각 이전에 발행된 것 중 가장
// 최신을 고르면, 하루 동안은 새 기사가 올라와도 오늘의 기사가 바뀌지 않는다.
const CUTOFF_HOUR_KST = 6;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const LIST_SIZE = 30;        // 후보로 훑어볼 최근 기사 수
const MIN_PARAGRAPHS = 4;    // 이보다 짧으면 '읽을 거리'가 아니라고 보고 건너뛴다
const MAX_PICK_TRIES = 4;    // 오늘의 기사를 고르며 본문까지 열어볼 최대 횟수

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', times: '×', deg: '°', middot: '·',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const hit = ENTITIES[name.toLowerCase()];
      return hit === undefined ? m : hit;
    });
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    // 링크·강조 태그를 공백으로 지우면 "supercomputer , we" 처럼 구두점 앞이 벌어진다.
    // 분석기에 그대로 넘기면 청크가 이상하게 잘리므로 여기서 붙여 준다.
    .replace(/\s+([,.;:!?%\u2019’])/g, '$1')
    .replace(/([\u2018\u201C(])\s+/g, '$1')
    .replace(/\s+(n['\u2019]t|['\u2019](s|re|ve|ll|d|m))\b/gi, '$1')
    .trim();
}

// 본문이 아니라 사이트 장치인 문단들. 분석 대상으로 올리면 학습에 방해만 된다.
const BOILERPLATE = [
  /^read more/i,
  /^enjoy this\?/i,
  /subscribe to our/i,
  /^subscribe/i,
  /^follow (us|the analyst)/i,
  /check out our/i,
  /^sign up/i,
  /^photo/i,
  /^\(?(getty|imago|alamy|reuters|ap photo)/i,
  /the analyst app/i,
  /^advertisement$/i,
];

function isBoilerplate(text) {
  return BOILERPLATE.some((re) => re.test(text));
}

// WordPress 블록 마크업에서 읽을 만한 본문만 남긴다.
// 표·그래픽·트윗 임베드·이미지 캡션은 영어 학습용 문장이 아니므로 통째로 버린다.
function htmlToParagraphs(html) {
  const cleaned = String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<figure[\s\S]*?<\/figure>/gi, ' ')
    .replace(/<figcaption[\s\S]*?<\/figcaption>/gi, ' ')
    .replace(/<table[\s\S]*?<\/table>/gi, ' ')
    .replace(/<blockquote[^>]*class="[^"]*(twitter|instagram)[^"]*"[\s\S]*?<\/blockquote>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ');

  const out = [];
  const seen = new Set();
  const block = /<(p|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;

  while ((m = block.exec(cleaned)) !== null) {
    const tag = m[1].toLowerCase();
    const text = stripTags(m[2]);
    if (!text) continue;
    if (isBoilerplate(text)) continue;

    const heading = tag !== 'p';
    // 짧은 p 는 대개 캡션·크레딧·버튼 문구다. 소제목은 짧아도 남긴다.
    if (!heading && text.length < 45) continue;
    // 같은 문장이 요약과 본문에 중복으로 박혀 있는 경우가 있다.
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ type: heading ? 'heading' : 'text', text });
  }
  return out;
}

async function wpFetch(path) {
  const res = await fetch(WP + path, {
    headers: {
      accept: 'application/json',
      // 기본 UA 로는 막히는 경우가 있다.
      'user-agent': 'chunk-and-catch/1.0 (personal English study app)',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const err = new Error('theanalyst.com 응답 오류 (' + res.status + ')');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function summarize(post) {
  return {
    id: post.id,
    title: stripTags(post.title && post.title.rendered),
    excerpt: stripTags(post.excerpt && post.excerpt.rendered),
    publishedAt: post.date_gmt ? post.date_gmt + 'Z' : null,
    link: post.link,
  };
}

async function loadArticle(id) {
  const post = await wpFetch(
    '/posts/' + encodeURIComponent(id) + '?_fields=id,date_gmt,link,title,excerpt,content'
  );
  return {
    ...summarize(post),
    paragraphs: htmlToParagraphs(post.content && post.content.rendered),
  };
}

// '오늘' = 한국 시간 기준 오늘 CUTOFF_HOUR_KST 시. 그 이전에 발행된 기사만 후보다.
function cutoffIso(now) {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  kst.setUTCHours(CUTOFF_HOUR_KST, 0, 0, 0);
  return new Date(kst.getTime() - KST_OFFSET_MS).toISOString();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET 요청만 지원합니다.' });
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');

    if (id) {
      if (!/^\d+$/.test(id)) return res.status(400).json({ error: '잘못된 기사 번호입니다.' });
      const article = await loadArticle(id);
      // 개별 기사는 내용이 바뀌지 않으니 오래 캐시해도 된다.
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json({ article });
    }

    const posts = await wpFetch(
      '/posts?categories=' + PREMIER_LEAGUE_CATEGORY +
      '&per_page=' + LIST_SIZE +
      '&_fields=id,date_gmt,link,title,excerpt'
    );

    const cutoff = cutoffIso(new Date());
    const recent = posts.map(summarize);
    if (recent.length === 0) {
      return res.status(502).json({ error: '최근 프리미어리그 기사를 찾지 못했습니다.' });
    }
    // 후보가 하나도 없을 만큼 발행이 뜸하면(새벽 등) 그냥 최신 기사로 간다.
    const pool = recent.filter((p) => p.publishedAt && p.publishedAt < cutoff);
    const candidates = (pool.length ? pool : recent).slice(0, MAX_PICK_TRIES);

    let today = null;
    for (const candidate of candidates) {
      const article = await loadArticle(candidate.id);
      if (!today) today = article;                       // 최소한 뭐라도 보여주기 위한 보루
      if (article.paragraphs.length >= MIN_PARAGRAPHS) { // 표만 잔뜩인 기사는 건너뛴다
        today = article;
        break;
      }
    }

    // 하루 한 편이 기준이므로 30분 캐시로 충분하다.
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
    return res.status(200).json({
      today,
      recent: recent.filter((p) => !today || p.id !== today.id).slice(0, 12),
      source: { name: 'The Analyst (Opta)', url: 'https://theanalyst.com/' },
    });
  } catch (err) {
    const aborted = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    console.error('[opta] error:', err && err.message);
    return res.status(aborted ? 504 : 502).json({
      error: aborted
        ? 'theanalyst.com 응답이 너무 느립니다. 잠시 후 다시 시도해 주세요.'
        : '기사를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
      detail: err && err.message ? String(err.message).slice(0, 200) : undefined,
    });
  }
};

// 로컬 테스트용
module.exports.htmlToParagraphs = htmlToParagraphs;
module.exports.cutoffIso = cutoffIso;
