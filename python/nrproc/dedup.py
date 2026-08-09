"""Dedup « frames mortes » : détection et traitement des doublons de frames.
Les dessins animés sont souvent « sur 2s / 3s » → images source dupliquées. Traiter chaque doublon = temps GPU gaspillé.

Deux usages :
  - interpolation (interp.py) : ré-échantillonne le mouvement des frames UNIQUES → utilise seulement
    `frames_differ` d'ici (la logique de ré-timing reste dans interp._run_dedup).
  - per-frame (depth / removeBG) : `run_perframe_dedup` ne fait tourner le modèle que sur les frames
    UNIQUES et REDUPLIQUE le dernier résultat pour les frames mortes → même nombre d'images en sortie,
    mais N appels modèle = nb de frames uniques (accélérateur transverse P1)."""

# Seuil de différence moyenne (0..1) sous lequel deux frames sont jugées identiques (mortes).
DEAD_THR = 0.006


def frames_differ(a, b, np, thr):
    """True si `a` et `b` diffèrent visuellement (au-dessus du seuil). Compare une version
    sous-échantillonnée (1 pixel sur 8) → coût négligeable devant un appel modèle."""
    sa = a[::8, ::8].astype(np.int16)
    sb = b[::8, ::8].astype(np.int16)
    return (np.abs(sa - sb).mean() / 255.0) >= thr


def run_perframe_dedup(dec, np, w, h, nb, thr, process_fn, write_fn, log):
    """Boucle streamée per-frame avec dedup. Lit les frames bgr du décodeur, n'appelle `process_fn`
    (le modèle) que sur les frames UNIQUES, réutilise le dernier résultat pour les frames mortes, et
    écrit une sortie par frame source via `write_fn(result, index)`.

    Retourne (done, computed, err) : done = frames écrites, computed = appels modèle réels."""
    frame_bytes = w * h * 3
    done = 0
    computed = 0
    last_pct = -1
    err = None
    prev_unique = None   # dernière frame source ayant déclenché un calcul
    cached = None        # son résultat (réutilisé pour les frames mortes qui suivent)
    try:
        while True:
            buf = dec.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            cur = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            if cached is None or frames_differ(cur, prev_unique, np, thr):
                cached = process_fn(cur)
                prev_unique = cur
                computed += 1
            write_fn(cached, done)
            done += 1
            if nb:
                pct = int(done * 100 / nb)
                if pct != last_pct:
                    last_pct = pct
                    log("STAGE:prog:%d/%d" % (done, nb))
    except BrokenPipeError:
        err = "ffmpeg encodeur interrompu (codec indisponible ?)"
    return done, computed, err
