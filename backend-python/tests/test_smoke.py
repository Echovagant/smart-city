import sys
from pathlib import Path

# Add the backend-python directory to sys.path so `import main` works
# without requiring the package to be installed.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_root_returns_service_info():
    response = client.get("/")
    assert response.status_code == 200
    body = response.json()
    assert "message" in body
    assert body.get("version") == "1.0.0"


def test_health_check_is_healthy():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}
