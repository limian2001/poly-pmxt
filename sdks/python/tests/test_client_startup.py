from pathlib import Path


def test_auto_start_failure_mentions_current_sidecar_package():
    client_source = (
        Path(__file__).resolve().parents[1] / "pmxt" / "client.py"
    ).read_text(encoding="utf-8")

    assert "Please ensure 'pmxt-core' is installed: npm install -g pmxt-core" in client_source
    assert "Or start the server manually: pmxt-server" in client_source
    assert "pmxtjs" not in client_source
