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
- 헬스체크: `/healthz`

## 환경변수(옵션)
- `DATABASE_URL` (기본: `sqlite:///./ppat.db`)
- `CORS_ALLOW_ORIGINS` (기본: `*`)
- `CORS_ALLOW_CREDENTIALS` (기본: `false`)
- `ENABLE_DOCS` (기본: `true`)

자세한 정보는 프로젝트 루트의 `README.md`를 참고하세요.

