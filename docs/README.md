# PPAT 간단 사용법

## 실행
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## 주요 경로
- 메인: `/`
- 자원 사용률: `/resource`
- 세션 브라우저: `/session`
- 트래픽 로그: `/traffic-logs`
- 헬스체크: `/healthz`

## 환경변수(옵션)
- `DATABASE_URL` (기본: `sqlite:///./ppat.db`)
- `CORS_ALLOW_ORIGINS` (기본: `*`)
- `CORS_ALLOW_CREDENTIALS` (기본: `false`) — 허용 원본이 와일드카드(`*`) 단일일 때는 Starlette 제약으로 자동 비활성화됨
- `ENABLE_DOCS` (기본: `true`)

자세한 정보는 프로젝트 루트의 `README.md`를 참고하세요.

## 테이블 공통 모듈 사용법
- 공통 초기화: `TableConfig.init('#tableId', { /* DataTables 옵션 */ })`
- 한국어/페이지 길이/스크롤 등 기본값이 적용됩니다. (길이 선택자 포함)
- 긴 텍스트 말줄임: 셀 내용이 길 경우 `<div class="dt-ellipsis">내용</div>`로 감싸서 사용하세요.
- Bulma 스타일 통합: 검색창/길이선택/페이지네이션/정렬아이콘을 Bulma 톤으로 오버라이드합니다.

예시(트래픽 로그 렌더):
```js
const dt = TableConfig.init('#tlTable', { order: [] });
```

