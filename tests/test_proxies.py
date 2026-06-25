"""프록시 CRUD API 통합 테스트"""

PROXY_PAYLOAD = {
    "host": "192.168.1.1",
    "username": "admin",
    "password": "secret123",
    "port": 22,
}


def test_create_proxy(client):
    resp = client.post("/api/proxies", json=PROXY_PAYLOAD)
    assert resp.status_code in (200, 201)
    body = resp.json()
    assert body["host"] == "192.168.1.1"
    assert "id" in body
    # 비밀번호는 응답에 포함되지 않아야 함
    assert "password" not in body


def test_create_duplicate_proxy_returns_409(client):
    client.post("/api/proxies", json=PROXY_PAYLOAD)
    resp = client.post("/api/proxies", json=PROXY_PAYLOAD)
    assert resp.status_code == 409


def test_list_proxies(client):
    resp = client.get("/api/proxies")
    assert resp.status_code == 200
    body = resp.json()
    assert "items" in body or isinstance(body, list)


def test_get_proxy(client):
    create_resp = client.post("/api/proxies", json={**PROXY_PAYLOAD, "host": "10.0.0.1"})
    assert create_resp.status_code in (200, 201)
    proxy_id = create_resp.json()["id"]

    resp = client.get(f"/api/proxies/{proxy_id}")
    assert resp.status_code == 200
    assert resp.json()["host"] == "10.0.0.1"


def test_get_nonexistent_proxy_returns_404(client):
    resp = client.get("/api/proxies/99999")
    assert resp.status_code == 404


def test_delete_proxy(client):
    create_resp = client.post("/api/proxies", json={**PROXY_PAYLOAD, "host": "10.0.0.2"})
    proxy_id = create_resp.json()["id"]

    del_resp = client.delete(f"/api/proxies/{proxy_id}")
    assert del_resp.status_code in (200, 204)

    get_resp = client.get(f"/api/proxies/{proxy_id}")
    assert get_resp.status_code == 404


def test_invalid_host_returns_422(client):
    resp = client.post("/api/proxies", json={**PROXY_PAYLOAD, "host": "not a valid host!!"})
    assert resp.status_code == 422
