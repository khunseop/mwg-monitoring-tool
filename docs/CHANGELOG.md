# 릴리즈 노트

## v1.3.4
- 데이터베이스 관리
  - Session/Traffic logs 최신 데이터만 유지
  - Resource usages 최대 30일 보관

## v1.3.3
- 보안/무결성
  - 프록시 비밀번호 저장 시 대칭키(Fernet)로 암호화 저장, 백엔드에서만 복호화 사용
  - 서버 시작 시 기존 평문 비밀번호를 1회 자동 암호화(마이그레이션 훅)
  - 세션 브라우저 설정의 명령 경로/인자(`command_path`, `command_args`)는 변경 불가로 고정
- 운영 참고
  - 암호화 키: `PROXY_PASSWORD_KEY`(권장) 또는 `./.secret/proxy_key.key` 자동 생성/사용
  - 키가 바뀌면 기존 암호 복호화 실패 → SSH 인증 실패 가능. 키를 고정/백업하세요

## v1.3.2
- 문서/구성
  - API 문서 노출을 `ENABLE_DOCS` 환경변수로 제어(기본 true)
  - 정적 문서 자원 마운트 `/docs-static` 추가
  - 루트 README 엔드포인트 목록 보강: `/traffic-logs`, `/healthz`
- CORS
  - 와일드카드 원본(`*`)만 허용되는 경우 자격증명 자동 비활성화로 Starlette 제약 준수
- 보안
  - 최소 보안 헤더 추가: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`

## v1.3.1
- 테이블 공통화 및 UI 정렬
  - 공통 JS 모듈 `TableConfig` 추가: DataTables 기본 옵션/한국어/초기화 통합
  - DOM 기본값을 `lfrtip`으로 지정해 "n개씩 보기" 복원
  - DataTables 컨트롤을 Bulma 스타일과 일관되게 오버라이드(검색창/길이선택/페이지네이션/정렬아이콘)
  - 페이지네이션 중앙 정렬
  - 긴 텍스트(트래픽 로그 URL/Host/Referer/User-Agent) 말줄임 처리 강화: 셀 내부 래퍼 `.dt-ellipsis` 적용
  - 세션브라우저/트래픽로그 모두 공통 초기화로 이관

## v1.3.0
- 자원 사용률(API)
  - 메모리 수집을 SSH 기반으로 선택적으로 지원(`mem` OID를 `ssh` 또는 `ssh:<command>`로 설정)
  - 기본 명령: `/proc/meminfo`에서 `MemTotal`/`MemAvailable`로 사용률(%) 계산
  - 동시성 제한과 타임아웃 도입: `RU_SSH_MAX_CONCURRENCY`(기본 8), `RU_SSH_TIMEOUT_SEC`(기본 5)
  - 5초 TTL 캐시로 반복 호출 시 지연 감소
  - DEBUG 로그로 SSH 경로 사용 및 실행 시간 확인 가능
- 문서
  - README에 SSH 메모리 수집 사용법과 환경변수 추가

## v1.2.3
- 자원 사용률(UI)
  - 자원사용률 테이블을 Heatmap chart로 변경
  - 임계치 별 색상으로 가독성 향상
  - 실시간 그래프 ApexCharts로 변경
  - 3열 분리에서 다시 단일열로 변경

## v1.2.2
- 자원 사용률(UI)
  - 프록시별 고정 색상 팔레트 적용, 가독성 향상
  - 시간 축 정렬(초 단위 버킷)로 마지막 포인트 드리프트 해결
  - 지표별 멀티 차트(3열)로 분리, 범례 토글로 표시 항목 제어
  - HTTP/HTTPS/FTP 누적 카운터를 구간 Δ값으로 시각화
  - 실행 상태/그래프 버퍼/범례 토글 상태를 로컬 저장하여 새로고침/탭 이동 후에도 유지
  - 테이블을 상단으로 이동하고 차트 높이를 축소하여 레이아웃 개선

## v1.2.1
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
