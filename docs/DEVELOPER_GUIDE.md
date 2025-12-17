# PMT 개발자 가이드

이 문서는 PMT(Proxy Mornitoring Tool)의 소스코드 기반 설치, 구성, 빌드, API 사양 등 개발자를 위한 기술 정보를 제공합니다. 최종 사용자용 설명서는 프로젝트 루트의 [README.md](../README.md)를 참고하세요.

## 1. 시스템 구성 요소

- **백엔드**: FastAPI + SQLAlchemy + Pydantic v2
- **프론트엔드**: Templates(Jinja2) + Static assets (Vanilla JS, DataTables, ApexCharts)
- **데이터베이스**: SQLite 기본 (환경변수 `DATABASE_URL`로 외부 DB 교체 가능)
- **데이터 수집**:
  - **자원 사용률**: aiosnmp (SNMP), paramiko (SSH - 메모리 선택)
  - **세션 브라우저**: paramiko (SSH)

## 2. 로컬 개발 환경 설정

### 사전 요구사항
- Python 3.10 이상

### 설치 및 실행
1.  **가상환경 생성 및 활성화**
    ```bash
    python -m venv .venv
    source .venv/bin/activate
    ```
    Windows에서는 `.\.venv\Scripts\activate`를 사용합니다.

2.  **의존성 설치**
    ```bash
    pip install -r requirements.txt
    ```

3.  **환경변수 설정 (선택 사항)**
    프로젝트 루트에 `.env` 파일을 생성하여 환경변수를 관리할 수 있습니다.

    - `DATABASE_URL`: 데이터베이스 연결 문자열. (기본값: `sqlite:///./pmt.db`)
    - `SESSION_TMP_DIR`: 세션 브라우저 임시 파일 저장 경로. (기본값: 시스템 임시 디렉터리 하위 `session_browser/`)
    - `CORS_ALLOW_ORIGINS`: CORS 허용 출처 목록 (쉼표로 구분). (기본값: `*`)
    - `CORS_ALLOW_CREDENTIALS`: CORS 자격증명 허용 여부. (기본값: `false`)
    - `ENABLE_DOCS`: API 문서(Swagger/ReDoc) 활성화 여부. (기본값: `true`)
    - `PROXY_PASSWORD_KEY`: 프록시 비밀번호 암호화용 Fernet 키. 미설정 시 `./.secret/proxy_key.key`가 자동으로 생성되어 사용됩니다. 컨테이너 또는 다중 서버 환경에서는 이 키를 동일하게 유지해야 암호화된 비밀번호를 일관되게 복호화할 수 있습니다.

4.  **애플리케이션 실행**
    ```bash
    uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
    ```
    - `--reload`: 소스 코드 변경 시 서버 자동 재시작
    - `--host 0.0.0.0`: 외부 네트워크에서 접속 허용
    - `--port 8000`: 서비스 포트

## 3. 주요 API 엔드포인트

- **API 라우트 프리픽스**: `/api`
- **API 문서**: `ENABLE_DOCS=true`일 때 `/docs` (Swagger UI) 또는 `/redoc` (ReDoc)에서 확인 가능합니다.
- **헬스체크**: `GET /healthz`

### 트래픽 로그 업로드 분석 API

- **엔드포인트**: `POST /api/traffic-logs/analyze-upload`
- **쿼리 파라미터**: `topN` (정수, 1~100, 기본값 20) - 상위 N개 항목을 결정합니다.
- **요청 형식**: `multipart/form-data`
  - `logfile`: 업로드할 로그 파일 (필수)
- **특징**: 파일은 서버에 저장되지 않고 스트리밍 방식으로 파싱되어 메모리 사용량이 적습니다.

- **응답 예시**:
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
      // ... 기타 집계 결과
    }
  }
  ```

## 4. 고급 기능 상세

### 자원 사용률 수집 (SSH 메모리)

SNMP 표준 OID 외에 SSH를 통해 직접 서버의 메모리 사용률을 수집할 수 있습니다.

- **설정 방법**: 설정 > OID 관리 페이지에서 `mem` 지표의 값을 `ssh` 또는 `ssh:<command>`로 지정합니다.
- **기본 명령어** (`ssh`로만 지정 시):
  ```bash
  awk '/MemTotal/ {total=$2} /MemAvailable/ {available=$2} END {printf "%.0f", 100 - (available / total * 100)}' /proc/meminfo
  ```
- **사용자 정의 명령어** (`ssh:<command>`): `<command>` 부분에 원하는 셸 명령어를 지정하여 메모리 사용률(%)을 숫자만 출력하도록 할 수 있습니다.
- **성능 관련 환경변수**:
  - `RU_SSH_MAX_CONCURRENCY`: 동시 SSH 수집 작업 최대 개수 (기본값: 8)
  - `RU_SSH_TIMEOUT_SEC`: SSH 연결 및 명령어 실행 타임아웃(초). (기본값: 5)
- **디버깅**: 로그 레벨을 `DEBUG`로 설정하면 SSH 수집 관련 상세 로그를 확인할 수 있습니다.

### 프론트엔드 테이블 공통 모듈

DataTables 라이브러리를 위한 공통 초기화 모듈이 제공됩니다.

- **위치**: `/app/static/js/table_config.js`
- **사용법**: `TableConfig.init('#tableId', { /* DataTables 커스텀 옵션 */ })`
- **기본 적용 옵션**:
  - 한국어 설정
  - 페이지 당 표시 항목 수 선택 (Length Menu)
  - 세로 스크롤 (`scrollY`)
  - Bulma CSS 테마와 일관성을 맞춘 스타일 오버라이드
- **긴 텍스트 처리**: 테이블 셀 안의 텍스트가 길 경우, `div` 태그에 `dt-ellipsis` 클래스를 적용하여 말줄임표 처리를 할 수 있습니다.
  ```html
  <td><div class="dt-ellipsis">아주 긴 텍스트 내용...</div></td>
  ```

#### 컬럼별 필터링
- 헤더 입력칸을 통해 각 컬럼 단위로 부분 일치 검색이 가능합니다.
- 기본 바인딩은 ColumnControl 플러그인을 사용하며, Enter 키 입력 시 서버/클라이언트 데이터에 반영됩니다.
- 서버사이드 테이블(`세션 브라우저`)의 경우, 쿼리스트링 `columns[i][search][value]`로 전달되어 백엔드에서 안전하게 필터됩니다.
- 클라이언트사이드 테이블(`트래픽 로그`)의 경우, DataTables 내부 필터가 적용됩니다.

## 5. Windows 독립 실행 파일 빌드

PyInstaller를 사용하여 모든 의존성이 포함된 단일 `.exe` 파일을 생성할 수 있습니다.

1.  **빌드용 의존성 설치**
    ```powershell
    # Python 3.10+ 가상환경 기준
    pip install -r requirements.txt
    pip install pyinstaller==6.11.0
    ```

2.  **빌드 명령어 실행 (PowerShell)**
    ```powershell
    pyinstaller --name PMT \
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

3.  **결과 확인**
    - 빌드가 성공하면 `dist/` 디렉터리에 `PMT.exe` 파일이 생성됩니다.
    - `path_resolver.py` 유틸리티가 PyInstaller로 패키징된 환경을 감지하여 템플릿, 정적 파일 등 리소스 경로를 올바르게 설정합니다.