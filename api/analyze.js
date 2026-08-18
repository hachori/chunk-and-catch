// Vercel 서버리스 함수 (Node 런타임, CommonJS)
// 브라우저가 아니라 서버에서만 실행 → Gemini API 키가 사용자에게 노출되지 않음.
//
// 환경변수:
//   GEMINI_API_KEY         (필수) Google AI Studio 에서 발급한 키
//   GEMINI_MODEL           (선택) 기본 gemini-3.5-flash-lite
//   GEMINI_THINKING_LEVEL  (선택) minimal | low | medium | high | off(=파라미터 미전송). 기본 minimal
//
// ⚠️ 모델 ID 는 반드시 '버전이 박힌' 것을 쓸 것.
//    gemini-flash-lite-latest 같은 -latest 별칭은 새 릴리스마다 가리키는 모델이 바뀌고,
//    가리키던 모델이 은퇴하면 코드를 안 건드려도 어느 날 갑자기 404 로 죽는다.

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_THINKING_LEVEL = 'minimal';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const BOOK_INSTRUCTION = `당신은 원서를 읽는 한국인 학습자를 위한 영어 구문 분석 전문가입니다.

1. 사용자가 입력한 텍스트 또는 이미지 내의 **'모든 완전한 문장들'**을 찾아내세요.
2. 찾아낸 각 문장을 순서대로 분리하여 개별적으로 분석하세요.
3. 각 문장을 의미가 통하는 자연스러운 '청크(Chunk)' 단위로 자르세요.
4. 문장 내에 구동사(Phrasal Verb)나 관용구(Idiom)가 있다면 반드시 찾아서 그 의미를 설명하세요.
5. 문장 내에서 학습자가 모를 법한 수준 있는 핵심 영단어(Vocabulary)를 추출하고 문맥에 맞는 뜻을 제공하세요.
6. 각 문장의 **구문(Syntax) 구조**를 분석하세요.
   - structure: 문장의 뼈대를 한 줄로 요약하세요. 주요 성분을 S(주어)/V(동사)/O(목적어)/C(보어) 로 표시합니다. 예: "S(The book that I read) + V(was) + C(fascinating)".
   - points: 관계절, 분사구문, to부정사, 동명사, 가주어·진주어, 도치, 강조구문(it ~ that), 접속사로 이어진 절, 비교구문 등 학습자가 구조 파악에 어려움을 겪을 만한 핵심 문법 포인트를 골라, label(문법 명칭)과 detail(그 구조가 문장에서 어떻게 작동하는지에 대한 쉬운 한국어 설명)로 제공하세요. 특별한 구문이 없으면 빈 배열로 두세요.
7. 각 청크별 직독직해와, 문장 전체의 자연스러운 한국어 최종 해석을 제공해야 합니다.
결과는 반드시 여러 문장(sentences)을 포함하는 배열 형태로 반환해야 합니다.`;

// 유튜브 자막 한 줄은 원서 문장과 다르다. 마침표가 없고, 문장이 아닐 수 있고, 축약과
// 군말이 섞이고, 자동자막이면 오인식도 있다. 문어체 지시문을 그대로 쓰면 짧은 구어
// 문장에서 모델이 chunks·syntax 를 통째로 빼먹는다.
const SPEECH_INSTRUCTION = `당신은 영어 듣기/쉐도잉을 하는 한국인 학습자를 위한 영어 구문 분석 전문가입니다.
입력은 영상 자막에서 뽑은 **말해진 영어 한 토막**입니다. 원서 문장이 아닙니다.

1. 입력 전체를 **하나의 발화로 취급**해 분석하세요. 마침표가 없거나 문법적으로 완전한
   문장이 아니어도 그대로 분석합니다. 명백히 두 문장 이상일 때만 나눠서 여러 개로 반환하세요.
2. 입력이 (Laughter), (Applause), (Music) 같은 효과음 표기이거나 분석할 영어가 없으면
   sentences 를 **빈 배열**로 반환하세요. 억지로 만들어내지 마세요.
3. 구어의 특징을 그대로 다루세요 — 축약(I've, gonna, wanna, ain't), 음 줄임, 군말·담화표지
   (you know, I mean, like, well, uh). 군말은 구문으로 따지지 말고 "말버릇/담화표지"로 짧게
   설명하세요.
4. **구동사·관용구·연어를 최우선으로 잡으세요.** 듣기에서 실제로 막히는 건 어려운 단어가
   아니라 이런 덩어리 표현입니다. 글로 보면 쉬운 단어들의 조합이어도 반드시 잡아내세요.
   (예: blown away, pull off, turn around, come up with, be into)
5. vocabulary 에는 그 발화에서 학습자가 모를 만한 표현을 담되, word 에는 **표제어만**
   적으세요. 설명·부연·괄호 주석을 word 에 넣지 마세요. 뜻은 meaning 에만 씁니다.
   구동사는 원형으로 적으세요 (blown away → blow away).
6. syntax.structure 는 발화의 뼈대를 한 줄로 요약합니다. S/V/O/C 로 표시하되, 생략된
   성분이 있으면 "(생략된 주어) V(...) O(...)" 처럼 생략을 드러내세요. 문장 조각이면
   조각이라고 밝히세요. points 에는 구조 파악에 걸릴 만한 포인트를 label/detail 로 담고,
   특별한 게 없으면 빈 배열로 둡니다.
7. 자동자막 오인식으로 보이는 부분이 있으면 detail 에서 짧게 짚어주세요.
8. 각 청크의 직독직해와, 발화 전체의 자연스러운 한국어 해석을 반드시 제공하세요.

sentences 를 빈 배열로 돌려주는 경우가 아니라면 chunks · vocabulary · syntax ·
final_translation 을 **하나도 빠뜨리지 말고** 채우세요.`;

const responseSchema = {
  type: 'OBJECT',
  properties: {
    sentences: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          original_sentence: { type: 'STRING' },
          chunks: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                english: { type: 'STRING' },
                korean: { type: 'STRING' },
                is_idiom: { type: 'BOOLEAN' },
                idiom_explanation: { type: 'STRING' },
              },
              propertyOrdering: ['english', 'korean', 'is_idiom', 'idiom_explanation'],
              required: ['english', 'korean', 'is_idiom'],
            },
          },
          vocabulary: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                word: { type: 'STRING', description: '표제어만. 설명이나 괄호 주석을 넣지 말 것.' },
                meaning: { type: 'STRING', description: '문맥에 맞는 한국어 뜻.' },
              },
              propertyOrdering: ['word', 'meaning'],
              required: ['word', 'meaning'],
            },
          },
          syntax: {
            type: 'OBJECT',
            properties: {
              structure: { type: 'STRING' },
              points: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: { label: { type: 'STRING' }, detail: { type: 'STRING' } },
                  propertyOrdering: ['label', 'detail'],
                  required: ['label', 'detail'],
                },
              },
            },
            propertyOrdering: ['structure', 'points'],
            required: ['structure', 'points'],
          },
          final_translation: { type: 'STRING' },
        },
        // required 를 안 걸면 모델이 필드를 통째로 생략한다. 짧은 구어 문장에서 chunks 와
        // syntax 가 빠진 채로 오는 사고가 실제로 있었다.
        propertyOrdering: [
          'original_sentence', 'chunks', 'vocabulary', 'syntax', 'final_translation',
        ],
        required: [
          'original_sentence', 'chunks', 'vocabulary', 'syntax', 'final_translation',
        ],
      },
    },
  },
  required: ['sentences'],
};

// Gemini 가 돌려준 에러 본문에서 사람이 읽을 메시지만 뽑아낸다.
function extractGeminiMessage(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && parsed.error && parsed.error.message) return parsed.error.message;
  } catch (_) {
    /* JSON 이 아니면 원문 일부를 그대로 쓴다 */
  }
  return String(bodyText || '').slice(0, 300);
}

// 설정 문제(키/모델/권한)는 재시도해도 소용없으므로 즉시 사용자에게 원인을 알려준다.
function describeConfigError(status, message, model) {
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(message)) {
    return 'Gemini API 키가 유효하지 않습니다. Vercel 환경변수 GEMINI_API_KEY 를 새 키로 교체해 주세요.';
  }
  if (status === 403) {
    return 'Gemini API 키에 권한이 없습니다. 키 제한(referrer/IP) 설정이나 Generative Language API 활성화 여부를 확인해 주세요.';
  }
  if (status === 404) {
    return '모델 "' + model + '" 을(를) 찾을 수 없습니다. 은퇴한 모델일 수 있으니 GEMINI_MODEL 환경변수를 현재 사용 가능한 모델 ID 로 바꿔 주세요.';
  }
  if (status === 429) {
    return 'Gemini API 사용량 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.';
  }
  return null;
}

class GeminiHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.geminiMessage = message;
  }
}

async function fetchGemini(url, options, retries = 4) {
  const delays = [1000, 2000, 4000, 8000];
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

function resolveModel() {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

function buildThinkingConfig() {
  const level = (process.env.GEMINI_THINKING_LEVEL || DEFAULT_THINKING_LEVEL).toLowerCase();
  if (level === 'off') return null;
  // Gemini 3 계열은 thinkingBudget 대신 thinkingLevel 을 쓴다.
  // (둘을 같이 보내면 400. 예전 thinkingBudget: 0 에 해당하는 값이 'minimal')
  return { thinkingLevel: level };
}

// POST 본문의 source 로 지시문이 갈린다:
//   (없음) | 'book'  → 원서 문장 분석 (웹 UI)
//   'speech'         → 자막·발화 분석 (쉐도잉 앱)
// GET /api/analyze → 키·모델 상태 진단. 비밀값은 노출하지 않는다.
async function handleDiagnostics(res) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = resolveModel();
  const report = {
    ok: false,
    apiKeyConfigured: Boolean(apiKey),
    apiKeyLength: apiKey ? apiKey.length : 0,
    model,
    thinkingLevel: (process.env.GEMINI_THINKING_LEVEL || DEFAULT_THINKING_LEVEL).toLowerCase(),
  };

  if (!apiKey) {
    report.error = 'GEMINI_API_KEY 환경변수가 설정되지 않았습니다.';
    return res.status(500).json(report);
  }

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      { headers: { 'x-goog-api-key': apiKey } }
    );
    const bodyText = await response.text();

    if (!response.ok) {
      report.apiKeyValid = false;
      report.geminiStatus = response.status;
      report.error = extractGeminiMessage(bodyText);
      return res.status(200).json(report);
    }

    report.apiKeyValid = true;
    const listed = (JSON.parse(bodyText).models || []).map((m) =>
      String(m.name || '').replace(/^models\//, '')
    );
    report.modelAvailable = listed.includes(model);
    report.availableFlashModels = listed.filter((n) => n.indexOf('flash') !== -1).slice(0, 20);
    report.ok = report.modelAvailable;
    if (!report.modelAvailable) {
      report.error =
        '키는 유효하지만 모델 "' + model + '" 을(를) 쓸 수 없습니다. 위 목록의 모델 ID 로 GEMINI_MODEL 을 설정하세요.';
    }
    return res.status(200).json(report);
  } catch (err) {
    report.error = '진단 중 오류: ' + (err && err.message ? err.message : String(err));
    return res.status(500).json(report);
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return handleDiagnostics(res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'POST 요청만 지원합니다.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: '서버에 GEMINI_API_KEY 환경변수가 설정되지 않았습니다.' });
  }

  const model = resolveModel();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { mode, text, imageData, mimeType } = body;
    // source: 'speech' 는 자막·듣기용. 안 보내면 기존대로 원서(문어체) 기준으로 분석한다.
    const speech = body.source === 'speech';

    let contents;
    if (mode === 'image') {
      if (!imageData || !mimeType) return res.status(400).json({ error: '이미지 데이터가 없습니다.' });
      contents = [
        {
          role: 'user',
          parts: [
            { text: '이 이미지에 있는 모든 영어 문장들을 읽고, 각각의 문장 단위로 분리해서 분석해주세요.' },
            { inlineData: { mimeType, data: imageData } },
          ],
        },
      ];
    } else {
      if (!text || !text.trim()) return res.status(400).json({ error: '분석할 텍스트가 없습니다.' });
      contents = [{ parts: [{ text }] }];
    }

    const generationConfig = {
      responseMimeType: 'application/json',
      responseSchema,
      maxOutputTokens: 16384,
    };
    const thinkingConfig = buildThinkingConfig();
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

    const payload = {
      systemInstruction: { parts: [{ text: speech ? SPEECH_INSTRUCTION : BOOK_INSTRUCTION }] },
      contents,
      generationConfig,
    };

    // 키는 쿼리스트링(?key=)이 아니라 헤더로 보낸다 → URL·로그에 키가 남지 않는다.
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';

    const data = await fetchGemini(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
    });

    const candidate = data && data.candidates && data.candidates[0];
    const jsonText =
      candidate && candidate.content && candidate.content.parts &&
      candidate.content.parts[0] && candidate.content.parts[0].text;

    if (!jsonText) {
      const finishReason = candidate && candidate.finishReason;
      const blockReason =
        data && data.promptFeedback && data.promptFeedback.blockReason;

      if (finishReason === 'MAX_TOKENS') {
        return res.status(502).json({
          error: '입력이 너무 길어 분석이 중간에 잘렸습니다. 문장 수를 줄여서 다시 시도해 주세요.',
        });
      }
      if (blockReason || finishReason === 'SAFETY') {
        return res.status(502).json({
          error: '안전 필터에 걸려 분석 결과를 받지 못했습니다. 다른 문장으로 시도해 주세요.',
        });
      }
      return res.status(502).json({
        error: '분석 결과를 받아오지 못했습니다.',
        detail: finishReason ? 'finishReason=' + finishReason : undefined,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (_) {
      return res.status(502).json({ error: '분석 결과 형식이 올바르지 않습니다. 다시 시도해 주세요.' });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    const status = err instanceof GeminiHttpError ? err.status : null;
    const geminiMessage = err instanceof GeminiHttpError ? err.geminiMessage : (err && err.message) || '';
    console.error('[analyze] error:', status, geminiMessage);

    const friendly = status ? describeConfigError(status, geminiMessage, model) : null;
    return res.status(status && status < 500 ? status : 500).json({
      error: friendly || '분석 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      detail: geminiMessage ? String(geminiMessage).slice(0, 300) : undefined,
    });
  }
};
