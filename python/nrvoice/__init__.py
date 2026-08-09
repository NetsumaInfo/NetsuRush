"""NetsuRush — package « voix » : transcription (ASR) et détection de silences (VAD).

Découpé par responsabilité (comme nrsearch/) :
  db            schéma SQLite (cache transcript + silences), réutilise detect.db_path
  asr           dispatch ASR (Whisper turbo / Parakeet v3) → mots horodatés
  asr_whisper   backend faster-whisper large-v3-turbo (CTranslate2, GPU, word timestamps)
  asr_parakeet  backend NVIDIA Parakeet TDT 0.6b v3 via onnx-asr (ONNX, GPU, multilingue)
  vad_silero    Silero VAD v5 (ONNX) → segments parole + complément silence
  vad_nova      NOVA-VAD (sklearn RF+GBT) → confirmation anti-bruit PAR-DESSUS Silero (pas un segmenteur)
  fillers       mots de remplissage FR (liste + répétitions) → tag par index de mot

Contrat de sortie commun (sidecar → core, secondes) :
  mot     = {"start": s, "end": s, "word": str, "conf": 0..1}
  silence = {"start": s, "end": s}
Les conversions secondes → frames vivent côté JS (core/wordTimeline + timeline), JAMAIS ici.
"""
