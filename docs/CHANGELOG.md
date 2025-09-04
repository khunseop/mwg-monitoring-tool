# 릴리즈 노트

## v1.0.0
- 초기 공개 버전
- 보안/품질 강화: 프록시 비밀번호 응답 제외, 부분 업데이트 허용
- 목록 API 페이지네이션 추가
- 세션 브라우저: SSH 호스트키 정책 준수(`auto_add`/`reject`)
- CORS/보안 헤더/헬스체크 추가, `.env` 로딩, 문서 노출 제어
- DB 연결 개선(`DATABASE_URL`, `pool_pre_ping`)
- Pydantic 기본값 안전화