from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_demo():
    response = client.get("/api/demo")
    assert response.status_code == 200
    assert response.json() == {"message": "Hello from Manao", "total": "1,000"}


def test_ready():
    assert client.get("/health/ready").json() == {"status": "ready"}
