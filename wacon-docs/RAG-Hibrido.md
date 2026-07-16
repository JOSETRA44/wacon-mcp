---
tags: [wacon, memoria, rag]
---

# RAG Híbrido

`recall_context` combina tres señales sobre el historial completo, fusionadas con **Reciprocal Rank Fusion** (RRF, k=60):

1. **Keyword (BM25)** — FTS5 de SQLite con `unicode61 remove_diacritics 2`.
2. **Semántica** — vectores locales de 256 dims (ver abajo). Umbral coseno 0.08.
3. **Recencia** — ranking por timestamp, peso 0.5 (desempate, no dominante).

Además, los resúmenes de [[Episodios]] se buscan semánticamente (umbral 0.12) y se devuelven aparte: memoria consolidada junto a mensajes crudos.

## El vectorizador (`memory/vectorizer.ts`)

> [!important] Cero dependencias, cero modelos
> Feature hashing (FNV-1a) sobre **unigramas de palabra (peso 2) + trigramas de carácter (peso 1)**, con signo por bit de hash, L2-normalizado. 256 floats = 1 KB/mensaje.

Por qué funciona para chat informal en español:

- Los trigramas de carácter absorben typos, jerga y tildes omitidas: "q onda cmo estas" ≈ "qué onda cómo estás" (test lo verifica).
- Normalización NFD + strip de acentos ⇒ "qué"="que" con coseno 1.0.
- Las palabras (peso doble) conservan la señal temática.

Costo: brute-force coseno sobre 10k mensajes ≈ pocos ms con `Float32Array`. Indexación incremental en `insertMessage` + `backfillVectors()` idempotente al arrancar el daemon.

## Límites conocidos y camino de evolución

- No captura sinonimia profunda ("coche"≠"auto" salvo contexto compartido). Si algún día duele: la interfaz `Store.vectorCandidates` permite enchufar sqlite-vec + un modelo de embeddings real sin tocar los tools.
- Escala: hasta ~200k mensajes el brute-force es aceptable; después, índice ANN.

Relacionado: [[Sistema-de-Memoria]], [[Episodios]]
