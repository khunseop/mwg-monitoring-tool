# 릴리즈 노트

## v1.3.2
- 자원 사용률(UI)
  - Chart.js 라인 차트로 전환(로컬 번들 `/static/vendor/chartjs/chart.umd.js`)
  - 수집 주기에 맞춰 자동 갱신(최근 1시간 버퍼)
- 자원 사용률(API)
  - `POST /api/resource-usage/series` 제거(실시간 UI는 collect + latest로 동작)

## v1.2.0
- 자원 사용률(UI)
  - 자원 사용률 페이지에 실시간 그래프 추가(다중 프록시/지표)
  - UI는 수집 주기에 맞춰 자동 갱신(최근 1시간 뷰), 시간 컨트롤 제거
- 자원 사용률(API)
  - Breaking: `POST /api/resource-usage/series`를 원시 시계열(시작~종료 선택적) 응답으로 변경
    - 요청: `proxy_ids`, `start`, `end(선택)`
    - 응답: 프록시별 포인트 배열(`ts, cpu, mem, cc, cs, http, https, ftp`)

## v1.1.0
- 프록시 관리
  - `proxies.host` 유니크 제약 추가(중복 등록 방지)
  - 생성/수정 시 호스트 중복 검사(409 Conflict)
  - 입력 검증 강화: 호스트(도메인/IP) 정규식, `username` 빈값 금지, 비밀번호 필수
- 세션 브라우저
  - 동시 수집 설정 `max_workers`를 설정값에 추가 및 적용
  - 수집/조회 성능을 위한 복합 인덱스 추가: `session_records(proxy_id, collected_at)`
- 자원 사용률
  - 집계 엔드포인트 추가: `POST /api/resource-usage/series`
    - 구간 버킷(분/시간/일) 평균, 이동평균, 누적평균 제공

UI 변경:
- 프록시 목록 및 폼에서 포트 표시/입력 제거(내부 기본값 사용)

마이그레이션 참고사항: 기존 DB에는 유니크/인덱스가 자동 적용되지 않을 수 있습니다. 운영 환경에서는 마이그레이션 도구(Alembic 등)를 통해 `proxies.host` 유니크 인덱스와 `session_records(proxy_id, collected_at)` 인덱스를 수동 적용하세요.

## v1.0.0
- 초기 공개 버전
- 보안/품질 강화: 프록시 비밀번호 응답 제외, 부분 업데이트 허용
- 목록 API 페이지네이션 추가
- 세션 브라우저: SSH 호스트키 정책 준수(`auto_add`/`reject`)
- CORS/보안 헤더/헬스체크 추가, `.env` 로딩, 문서 노출 제어
- DB 연결 개선(`DATABASE_URL`, `pool_pre_ping`)
- Pydantic 기본값 안전화