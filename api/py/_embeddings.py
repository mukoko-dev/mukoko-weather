"""
Embeddings pipeline — foundation for vector/semantic search.

Currently a stub router. The infrastructure is ready in MongoDB
(vector search index, embedding storage functions) but no code
currently generates embeddings. This module will house the
embedding generation and storage endpoints when ready.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/api/py/embeddings/status")
async def embeddings_status():
    """Health check for the embeddings pipeline."""
    return {
        "status": "not_configured",
        "message": "Embedding pipeline is planned but not yet active.",
    }
