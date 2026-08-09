"""NetsuRush — package de recherche de plans par embeddings SigLIP 2.

Découpé par responsabilité (le point d'entrée reste python/search.py) :
  config   constantes (modèle, seuils, perf, bascule FAISS)
  db       schéma SQLite (embeddings de plans, runs d'indexation, visages)
  model    SigLIP 2 : chargement, embedding image/texte, calibration, esthétique
  qtext    compréhension de la requête : normalisation, langue, vues de prompt (pur, sans torch)
  media    extraction de frames ffmpeg, vignettes JPEG, plans (cache détection)
  store    backends de recherche (BruteForce / FAISS IVFPQ) + sync SQLite paresseuse
  index    indexation (1 vecteur/plan, échantillonnage adaptatif) + images fixes
  query    recherche unifiée (texte/réfs/négatif/esthétique), dedup, clustering
  catalog  état d'indexation (status/indexed/shots)
  faces    recherche par visage (cascades animé + réel, embed des crops)
"""
