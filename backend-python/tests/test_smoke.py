import sys
from pathlib import Path

# Add the backend-python directory to sys.path so `import main` works
# without requiring the package to be installed.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_root_returns_service_info(tmp_path, monkeypatch):
    """没有前端构建产物时，根路径返回服务信息 JSON。

    把 FRONTEND_DIST 指向一个空目录，让结果与本机是否构建过前端无关
    （构建过前端时根路径返回页面，由 test_static.py 覆盖）。
    """
    monkeypatch.setattr(main, "FRONTEND_DIST", tmp_path)

    response = client.get("/")
    assert response.status_code == 200
    body = response.json()
    assert "message" in body
    assert body.get("version") == "1.0.0"


def test_health_check_is_healthy():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}
