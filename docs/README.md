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
- `PROXY_PASSWORD_KEY` (권장): 프록시 비밀번호 암호화용 Fernet 키. 미지정 시 `./.secret/proxy_key.key` 자동 생성/사용. 운영환경에서 키를 고정/백업해야 복호화 일관성 유지

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


## 윈도우 독립 실행 파일(로컬 프로그램) 빌드

아래 방법으로 Windows용 단일 실행 파일을 만들 수 있습니다. (개발 PC에 Python 3.10+, pip, 빌드 도구 필요)

1) 가상환경/의존성 설치
```powershell
py -3.10 -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
pip install pyinstaller==6.11.0
```

2) 빌드 실행 (PowerShell)
```powershell
pyinstaller --name PPAT \
  --onefile \
  --noconsole \
  --add-data "app/templates;app/templates" \
  --add-data "app/static;app/static" \
  --add-data "docs;docs" \
  --collect-all uvicorn \
  --hidden-import "dotenv" \
  --hidden-import "Jinja2" \
  --hidden-import "cryptography.hazmat.bindings._rust" \
  --additional-hooks-dir hooks \
  run_app.py
```

- 출력물은 `dist/PPAT.exe` 입니다.
- 방화벽 경고가 뜰 수 있습니다. 로컬 접속만 필요하므로 허용 후 사용하세요.

3) 실행
```powershell
./dist/PPAT.exe
```
기본으로 브라우저가 자동으로 열리며 주소는 `http://127.0.0.1:8000/` 입니다.

참고: 리소스 경로는 PyInstaller 번들 환경에서도 동작하도록 `app/utils/path_resolver.py` 로 처리합니다.

