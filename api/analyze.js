// Vercel 서버리스 함수 (Node 런타임, CommonJS)
// 브라우저가 아니라 서버에서만 실행 → Gemini API 키가 사용자에게 노출되지 않음.
// 필요한 환경변수: GEMINI_API_KEY (Vercel 대시보드에서 설정)
// (선택) GEMINI_MODEL — 기본 gemini-flash-lite-latest (빠르고 가벼운 최신 flash-lite 별칭)

const DEFAULT_MODEL = 'gemini-flash-lite-latest';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const systemInstruction = `당신은 원서를 읽는 한국인 학습자를 위한 영어 구문 분석 전문가입니다.

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
            },
          },
          vocabulary: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { word: { type: 'STRING' }, meaning: { type: 'STRING' } },
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
                },
              },
            },
          },
          final_translation: { type: 'STRING' },
        },
      },
    },
  },
};

async function fetchGemini(url, options, retries = 4) {
  const delays = [1000, 2000, 4000, 8000];
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return await response.json();
      if (!RETRYABLE.has(response.status)) {
        const body = await response.text();
        throw new Error('Gemini API 오류 (' + response.status + '): ' + body.slice(0, 300));
      }
      lastErr = new Error('Gemini API 일시 오류 (' + response.status + ')');
    } catch (err) {
      lastErr = err;
      if (err.message && err.message.indexOf('Gemini API 오류') === 0) throw err;
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
    const { mode, text, imageData, mimeType } = body;

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

    const payload = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      model +
      ':generateContent?key=' +
      apiKey;

    const data = await fetchGemini(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const jsonText =
      data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;

    if (!jsonText) return res.status(502).json({ error: '분석 결과를 받아오지 못했습니다.' });

    return res.status(200).json(JSON.parse(jsonText));
  } catch (err) {
    console.error('[analyze] error:', err);
    return res.status(500).json({ error: '분석 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
};
