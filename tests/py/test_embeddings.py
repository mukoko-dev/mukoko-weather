"""Tests for _embeddings.py — embeddings status endpoint (stub)."""

from __future__ import annotations

import pytest

from py._embeddings import embeddings_status


# ---------------------------------------------------------------------------
# embeddings_status endpoint
# ---------------------------------------------------------------------------


class TestEmbeddingsStatus:
    @pytest.mark.asyncio
    async def test_returns_not_configured(self):
        result = await embeddings_status()
        assert result["status"] == "not_configured"

    @pytest.mark.asyncio
    async def test_returns_message(self):
        result = await embeddings_status()
        assert "message" in result
        assert "not yet active" in result["message"]

    @pytest.mark.asyncio
    async def test_response_shape(self):
        result = await embeddings_status()
        assert isinstance(result, dict)
        assert set(result.keys()) == {"status", "message"}
