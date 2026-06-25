"""헬스체크 엔드포인트 테스트"""


def test_healthz_returns_ok(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] in ("ok", "degraded")
    assert "db" in body
    assert "collector" in body
    assert "uptime_seconds" in body


def test_healthz_db_field(client):
    resp = client.get("/healthz")
    assert resp.json()["db"] == "ok"
