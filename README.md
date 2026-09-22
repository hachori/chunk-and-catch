# chunk-and-catch

## 오늘의 프리미어리그 기사 (Opta)

`/api/opta` 가 [The Analyst](https://theanalyst.com/) (Opta) 의 WordPress REST API 에서
프리미어리그 기사를 가져와 평문 단락으로 잘라 내려준다.

- 대상은 사이트의 <https://theanalyst.com/competition/premier-league/articles>
  메뉴에 실리는 기사 그대로다. 그 페이지가 카테고리 23(premier-league) 목록과
  **순서까지 1:1 로 같다는 것을 확인**하고 그 값을 쓴다. 여기서 따로 걸러내지 않으므로
  그 메뉴에 다른 리그 기사가 섞여 있으면 그대로 들어온다 (의도한 동작).
- **오늘의 기사** = 한국 시간 오늘 06:00 이전에 발행된 프리미어리그 기사 중 가장 최신.
  하루 동안은 새 기사가 올라와도 바뀌지 않는다.
- 기사 한 편은 1만 5천 자가 넘어 `/api/analyze` 한 번에 안 들어간다.
  그래서 화면에서 **단락 하나를 골라** 분석한다. 어디까지 읽었는지는 localStorage 에 남는다.
- 환경변수는 필요 없다. 남의 공개 API 에 의존하므로, 어느 날 형식이 바뀌면
  `htmlToParagraphs()` 의 필터를 손보면 된다.
