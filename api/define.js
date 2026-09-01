// Vercel 서버리스 함수 — 영어 단어 사전 조회 (한국어 뜻 중심)
// 환경변수는 analyze.js 와 동일: GEMINI_API_KEY, (선택) GEMINI_MODEL, GEMINI_THINKING_LEVEL
//
// ⚠️ 모델 ID 는 반드시 버전이 박힌 것을 쓸 것. -latest 별칭은 어느 날 갑자기 죽는다.

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_THINKING_LEVEL = 'minimal';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const systemInstruction = `당신은 한국인 영어 학습자를 위한 영한사전입니다.
사용자가 입력한 영어 단어나 표현을 사전 항목처럼 정리하세요.

1. phonetic: 미국식 발음기호를 IPA 로 반드시 적으세요 (예: /ˈpɑːndər/).
   구동사처럼 발음기호를 붙이기 어려우면 빈 문자열로 두세요.
2. summary: 가장 핵심적인 뜻을 한국어 한 줄로 요약하세요.
3. senses: 품사별 주요 뜻을 최대 4개까지. 각 항목은
   - part_of_speech: 한국어 품사명 (명사, 동사, 형용사, 부사, 구동사, 관용구 등)
   - meaning_ko: 그 품사에서의 한국어 뜻
   - example_en: 그 뜻을 잘 보여주는 자연스러운 영어 예문 (원서에서 나올 법한 수준)
   - example_ko: 예문의 자연스러운 한국어 해석
4. synonyms: 비슷한 뜻의 영어 단어를 최대 5개.
5. notes: 뉘앙스, 자주 쓰이는 연어(collocation), 혼동하기 쉬운 단어와의 차이 등
   학습자가 알아두면 좋은 점을 2~3문장의 한국어로. 특별한 게 없으면 빈 문자열.

입력이 영어 단어나 표현이 아니거나 뜻을 알 수 없으면
summary 에 "찾을 수 없는 단어입니다." 라고 쓰고 senses 는 빈 배열로 두세요.`;

const responseSchema = {
  type: 'OBJECT',
  properties: {
    word: { type: 'STRING' },
    phonetic: { type: 'STRING' },
    summary: { type: 'STRING' },
    senses: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          part_of_speech: { type: 'STRING' },
          meaning_ko: { type: 'STRING' },
          example_en: { type: 'STRING' },
          example_ko: { type: 'STRING' },
        },
        required: ['part_of_speech', 'meaning_ko'],
      },
    },
    synonyms: { type: 'ARRAY', items: { type: 'STRING' } },
    notes: { type: 'STRING' },
  },
  // phonetic/synonyms/notes 도 required 로 둬야 모델이 생략하지 않는다.
  // 값이 없을 땐 빈 문자열/빈 배열을 넣도록 systemInstruction 에서 지시한다.
  required: ['word', 'phonetic', 'summary', 'senses', 'synonyms', 'notes'],
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
    const word = String(body.word || '').trim();
    if (!word) return res.status(400).json({ error: '찾을 단어를 입력해 주세요.' });
    if (word.length > 80) return res.status(400).json({ error: '너무 긴 입력입니다. 단어나 짧은 표현만 검색해 주세요.' });

    const generationConfig = {
      responseMimeType: 'application/json',
      responseSchema,
      maxOutputTokens: 4096,
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
          contents: [{ parts: [{ text: word }] }],
          generationConfig,
        }),
      }
    );

    const candidate = data && data.candidates && data.candidates[0];
    const jsonText =
      candidate && candidate.content && candidate.content.parts &&
      candidate.content.parts[0] && candidate.content.parts[0].text;

    if (!jsonText) return res.status(502).json({ error: '사전 결과를 받아오지 못했습니다.' });

    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch (_) { return res.status(502).json({ error: '사전 결과 형식이 올바르지 않습니다.' }); }

    return res.status(200).json(parsed);
  } catch (err) {
    const status = err instanceof GeminiHttpError ? err.status : null;
    const geminiMessage = err instanceof GeminiHttpError ? err.geminiMessage : (err && err.message) || '';
    console.error('[define] error:', status, geminiMessage);
    const friendly = status ? describeConfigError(status, geminiMessage, model) : null;
    return res.status(status && status < 500 ? status : 500).json({
      error: friendly || '단어를 찾는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      detail: geminiMessage ? String(geminiMessage).slice(0, 300) : undefined,
    });
  }
};
