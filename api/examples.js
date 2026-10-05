// Vercel 서버리스 함수 — 단어장 학습용 '쉬운 예문' 생성
// 환경변수는 analyze.js / define.js 와 동일: GEMINI_API_KEY, (선택) GEMINI_MODEL, GEMINI_THINKING_LEVEL
//
// 단어는 뜻만 봐도 외워지지만 구동사(phrasal verb)는 쓰임을 봐야 외워진다.
// 그래서 원문 문장 대신 '가장 쉬운' 예문을 따로 만들어 준다.
//
// ⚠️ 모델 ID 는 반드시 버전이 박힌 것을 쓸 것. -latest 별칭은 어느 날 갑자기 죽는다.

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_THINKING_LEVEL = 'low';   // 짧은 요청이라 조금 더 생각하게 해도 부담이 없다
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const systemInstruction = `당신은 한국인 영어 학습자에게 표현의 '쓰임'을 보여 주는 예문 작가입니다.
사용자가 준 영어 표현(단어 또는 구동사/관용구)이 실제로 쓰이는 예문 3개를 만드세요.

가장 중요한 규칙 — **쉬울수록 좋습니다.**
1. 중학생이 사전 없이 읽을 수 있는 수준으로 쓰세요. 한 문장은 10단어 안팎, 길어도 12단어를 넘기지 마세요.
2. 어려운 단어를 끼워 넣지 마세요. 표현 자체만 새롭고 나머지는 모두 쉬운 일상 단어여야 합니다.
3. 일상 생활에서 바로 쓸 만한 장면(집, 학교, 친구, 직장)으로 쓰세요. 뉴스체·문어체는 쓰지 마세요.
4. 쉬운 것부터 순서대로 놓으세요. 첫 번째 예문이 가장 짧고 쉬워야 합니다.

구동사(두 단어 이상)일 때 추가로 지킬 것:
5. 세 예문의 쓰임이 서로 겹치지 않게 하세요. 목적어가 명사일 때와 대명사일 때
   (give up smoking / give it up 처럼) 어순이 달라지는 표현이면 그 차이가 드러나게 쓰세요.
6. 입력에 **'학습자가 저장해 둔 뜻'이 적혀 있으면 그 뜻이 최우선입니다.**
   첫 번째와 두 번째 예문은 반드시 그 뜻으로 쓰세요. 구동사는 뜻이 여러 개인 경우가 많은데,
   학습자는 그 중 '저장해 둔 그 뜻'을 외우려고 이 예문을 봅니다.
   (예: back up 을 '뒷받침하다'로 저장했다면 '후진하다'나 '백업하다' 예문부터 보여 주면 안 됩니다.)
   세 번째 예문에서만 다른 흔한 뜻을 보여 줄 수 있고, 그럴 때는 note 에 그 사실을 적으세요.
   저장해 둔 뜻이 없으면 가장 자주 쓰는 뜻으로 쓰세요.

각 예문마다:
- en: 영어 예문 (표현을 원형이 아니라 문장에 맞게 활용해서 쓰세요)
- ko: 자연스러운 한국어 해석. 조사와 어미를 빠뜨리지 마세요.
  **인칭을 영어와 반드시 맞추세요** — She 를 '그는', I 를 '너는' 으로 옮기는 실수가 잦습니다.
  (She used facts... → '그녀는 사실을 들어...' ⭕ / '그는 사실을 들어...' ❌)

note: 이 표현을 쓸 때 한국인이 자주 틀리는 점이나 꼭 알아야 할 어순/전치사 규칙을
한국어 1~2문장으로. 특별히 없으면 빈 문자열로 두세요.

입력이 영어 표현이 아니면 examples 를 빈 배열로 두세요.`;

const responseSchema = {
  type: 'OBJECT',
  properties: {
    term: { type: 'STRING' },
    examples: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          en: { type: 'STRING' },
          ko: { type: 'STRING' },
        },
        required: ['en', 'ko'],
      },
    },
    note: { type: 'STRING' },
  },
  // note 도 required 로 둬야 모델이 생략하지 않는다 (없으면 빈 문자열을 넣도록 지시함).
  required: ['term', 'examples', 'note'],
};

function extractGeminiMessage(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && parsed.error && parsed.error.message) return parsed.error.message;
  } catch (_) { /* JSON 이 아니면 원문 일부 */ }
  return String(bodyText || '').slice(0, 300);
}

function describeConfigError(status, message, model) {
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(message)) {
    return 'Gemini API 키가 유효하지 않습니다. Vercel 환경변수 GEMINI_API_KEY 를 새 키로 교체해 주세요.';
  }
  if (status === 403) return 'Gemini API 키에 권한이 없습니다.';
  if (status === 404) {
    return '모델 "' + model + '" 을(를) 찾을 수 없습니다. GEMINI_MODEL 을 현재 사용 가능한 모델 ID 로 바꿔 주세요.';
  }
  if (status === 429) return '사용량 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.';
  return null;
}

class GeminiHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.geminiMessage = message;
  }
}

async function fetchGemini(url, options, retries = 3) {
  const delays = [1000, 2000, 4000];
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return await response.json();
      const bodyText = await response.text();
      const message = extractGeminiMessage(bodyText);
      if (!RETRYABLE.has(response.status)) throw new GeminiHttpError(response.status, message);
      lastErr = new GeminiHttpError(response.status, message);
    } catch (err) {
      if (err instanceof GeminiHttpError && !RETRYABLE.has(err.status)) throw err;
      lastErr = err;
    }
    if (i < retries) await new Promise((r) => setTimeout(r, delays[i]));
  }
  throw lastErr || new Error('Gemini 요청에 실패했습니다.');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST 요청만 지원합니다.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: '서버에 GEMINI_API_KEY 환경변수가 설정되지 않았습니다.' });
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const term = String(body.term || '').trim();
    const meaning = String(body.meaning || '').trim();
    if (!term) return res.status(400).json({ error: '예문을 만들 표현을 보내 주세요.' });
    if (term.length > 80) return res.status(400).json({ error: '너무 긴 입력입니다. 단어나 짧은 표현만 보내 주세요.' });

    // 뜻을 같이 주면 다의어에서 엉뚱한 뜻으로 예문을 만드는 일이 줄어든다.
    const prompt = meaning
      ? term + '\n학습자가 저장해 둔 뜻: ' + meaning.slice(0, 200) +
        '\n→ 이 뜻으로 쓰이는 예문을 먼저 보여 주세요.'
      : term;

    const generationConfig = {
      responseMimeType: 'application/json',
      responseSchema,
      maxOutputTokens: 2048,
    };
    const level = (process.env.GEMINI_THINKING_LEVEL || DEFAULT_THINKING_LEVEL).toLowerCase();
    if (level !== 'off') generationConfig.thinkingConfig = { thinkingLevel: level };

    const data = await fetchGemini(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig,
        }),
      }
    );

    const candidate = data && data.candidates && data.candidates[0];
    const jsonText =
      candidate && candidate.content && candidate.content.parts &&
      candidate.content.parts[0] && candidate.content.parts[0].text;

    if (!jsonText) return res.status(502).json({ error: '예문을 받아오지 못했습니다.' });

    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch (_) { return res.status(502).json({ error: '예문 형식이 올바르지 않습니다.' }); }

    // 예문은 같은 표현이면 늘 같으므로 CDN 에 하루 재워 둔다 (POST 라 실제 효과는 작지만 무해).
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json(parsed);
  } catch (err) {
    const status = err instanceof GeminiHttpError ? err.status : null;
    const geminiMessage = err instanceof GeminiHttpError ? err.geminiMessage : (err && err.message) || '';
    console.error('[examples] error:', status, geminiMessage);
    const friendly = status ? describeConfigError(status, geminiMessage, model) : null;
    return res.status(status && status < 500 ? status : 500).json({
      error: friendly || '예문을 만드는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      detail: geminiMessage ? String(geminiMessage).slice(0, 300) : undefined,
    });
  }
};
