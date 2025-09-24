## PPAT (Proxy Performance Analysis Tool)

FastAPI 기반의 프록시 성능 분석/운영 도구입니다. 프록시/그룹 관리, 세션 브라우저 수집(SSH), 자원 사용률 수집(SNMP), 간단한 UI와 API 문서를 제공합니다.

### 구성 요소
- FastAPI + SQLAlchemy + Pydantic v2
- Templates(Jinja2) + Static assets
- SQLite 기본(DB_URL로 교체 가능)
- SNMP 수집(aiosnmp), SSH 수집(paramiko)

### 빠른 시작
1) Python 3.10+ 준비, 가상환경 권장
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

2) 환경변수(.env 권장) 설정
- `DATABASE_URL`: 기본 `sqlite:///./ppat.db`
- `SESSION_TMP_DIR`: 세션 브라우저 임시파일 저장 경로(미설정 시 시스템 tmp 하위 `session_browser/`)
- `CORS_ALLOW_ORIGINS`: 기본 `*` (쉼표로 다중 허용)
- `CORS_ALLOW_CREDENTIALS`: 기본 `false` (와일드카드일 때 자동 비활성)
- `ENABLE_DOCS`: 기본 `true` (API 문서 노출)
- `PROXY_PASSWORD_KEY`: 프록시 비밀번호 암호화용 Fernet 키. 미설정 시 `./.secret/proxy_key.key` 자동 생성/사용. 컨테이너/배포 간 동일 키 유지 필요

3) 애플리케이션 실행
```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

4) UI/엔드포인트
- 메인 설정 페이지: `/`
- 자원 사용률 페이지: `/resource`
- 세션 브라우저 페이지: `/session`
- 트래픽 로그 페이지: `/traffic-logs`
- 헬스체크: `/healthz`
- API 라우트 프리픽스: `/api`
- API 문서: `ENABLE_DOCS=true` 상태에서 자동 제공

트래픽 로그 페이지는 두 가지 방식을 제공합니다:
- 원격 조회(SSH): 프록시에 설정된 로그 경로에서 head/tail로 조회(필터 포함)
- 파일 업로드 분석: 로컬 로그파일을 업로드하여 대용량도 스트리밍으로 파싱/집계

### 주요 기능
- 프록시/그룹 CRUD
- 세션 브라우저 수집(SSH) 및 임시파일(JSONL) 저장/조회(프록시별 최신 1개 배치 유지)
- 자원 사용률 수집(SNMP 기본, 메모리는 선택적으로 SSH) 및 저장/조회
- 트래픽 로그 업로드 분석(신규)
  - 과부하 원인 파악에 유용한 집계 제공: 과다 다운로드/업로드, 요청 상위 클라이언트·호스트·URL, 차단 건수
  - 호스트/클라이언트별 다운로드·업로드 바이트 합계, 요청 건수, 상위 Top N 분석
  - 시간 범위 자동 계산(로그 내 earliest~latest)
  - ApexCharts 기반 차트 시각화, 결과는 로컬 저장소(localStorage)에 보존되어 새로고침 시에도 유지

### API - 트래픽 로그 업로드 분석

엔드포인트:

```
POST /api/traffic-logs/analyze-upload?topN=20
Content-Type: multipart/form-data
Form fields:
  - logfile: 업로드할 로그 파일 (필수)
```

응답 예시(요약):

```json
{
  "summary": {
    "total_lines": 12345,
    "parsed_lines": 12000,
    "unparsed_lines": 345,
    "unique_clients": 87,
    "unique_hosts": 213,
    "total_recv_bytes": 123456789,
    "total_sent_bytes": 987654321,
    "blocked_requests": 42,
    "time_range_start": "2025-09-24T10:00:00+09:00",
    "time_range_end": "2025-09-24T12:00:00+09:00"
  },
  "top": {
    "hosts_by_requests": [["example.com", 1234], ...],
    "urls_by_requests": [["example.com/path", 456], ...],
    "clients_by_requests": [["10.0.0.5", 789], ...],
    "clients_by_download_bytes": [["10.0.0.5", 123456], ...],
    "clients_by_upload_bytes": [["10.0.0.6", 98765], ...],
    "hosts_by_download_bytes": [["cdn.example.com", 2222222], ...],
    "hosts_by_upload_bytes": [["upload.example.com", 1111111], ...]
  }
}
```

비고:
- `topN`은 1~100 사이 정수(기본 20)
- 파일은 서버에 저장되지 않고 스트리밍으로 파싱만 수행

### 자원 사용률(SSH 메모리)
- OID 설정에서 `mem` 값을 `ssh` 또는 `ssh:<command>`로 지정하면 SSH로 메모리 사용률(%)을 수집합니다.
  - 기본 명령은 다음과 같습니다:
```bash
awk '/MemTotal/ {total=$2} /MemAvailable/ {available=$2} END {printf "%.0f", 100 - (available / total * 100)}' /proc/meminfo
```
- 성능/타임아웃 환경변수:
  - `RU_SSH_MAX_CONCURRENCY`: 동시 SSH 수집 개수(기본 8)
  - `RU_SSH_TIMEOUT_SEC`: SSH 접속/명령 타임아웃 초(기본 5)
- 검증(디버깅): 로그 레벨을 DEBUG로 올리면 다음 로그가 출력됩니다.
  - `Using SSH mem for host=... oidSpec=ssh...`
  - `SSH mem start host=...` / `SSH mem end host=... ms=... value=...`

### 윈도우 독립 실행 파일로 빌드 (PyInstaller)

Windows에서 로컬 프로그램처럼 실행할 수 있는 `PPAT.exe`를 생성합니다.

1) 의존성 설치
```powershell
py -3.10 -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
pip install pyinstaller==6.11.0
```

2) 빌드 명령
```powershell
pyinstaller --name PPAT \
  --onefile \
  --noconsole \
  --add-data "app/templates;app/templates" \
  --add-data "app/static;app/static" \
  --add-data "docs;docs" \
  --collect-all uvicorn \
  --collect-all fastapi_standalone_docs \
  --collect-all aiosnmp \
  --collect-all asyncio_dgram \
  --collect-all pyasn1 \
  --collect-all paramiko \
  --collect-all pynacl \
  --collect-all bcrypt \
  --hidden-import "dotenv" \
  --hidden-import "Jinja2" \
  --hidden-import "cryptography.hazmat.bindings._rust" \
  --additional-hooks-dir hooks \
  run_app.py
```

- 결과: `dist/PPAT.exe`
- 실행 시 기본 브라우저가 자동으로 열리고 주소는 `http://127.0.0.1:8000/` 입니다.
- 리소스 경로는 `app/utils/path_resolver.py` 에서 PyInstaller 번들을 고려해 처리합니다.
