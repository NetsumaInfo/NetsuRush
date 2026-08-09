"""Détection ACOUSTIQUE des hésitations (« euh / ah / eee ») par la courbe audio (méthode Goto allégée).

Un filled pause = son SOUTENU : F0 (pitch) plat + flux spectral bas + énergie stable + voisé + timbre
de VOYELLE CENTRALE (formants LPC dans la zone schwa/« euh » : F1 ~250-900 Hz, F2 ~850-2000 Hz —
critère de Goto original, discrimine les consonnes tenues et bruits). On ne SCANNE PAS tout l'audio
(trop de faux positifs : voyelles tenues de fin de phrase). Fenêtres candidates : (a) TROUS entre
mots (≥ gap_min) — là où l'ASR a avalé le « euh » ; (b) mots à faible confiance ; (c) mots COURTS
TRAÎNÉS (≤ 4 lettres, ≥ drag_min s) — confirmation acoustique des prolongations. Chaque fenêtre peut
produire PLUSIEURS segments (tous les runs voisés, pas seulement le plus long). Les silences Silero
confirmés sont exclus. Pur signal (librosa), aucun modèle entraîné.

Sortie : segments [{start, end, conf}] (secondes). conf = nb de critères satisfaits / 6.
"""
import sys

import numpy as np

SR = 16000
HOP = 160      # 10 ms à 16 kHz
N_FFT = 400    # 25 ms


def _emit(tag):
    sys.stderr.write(tag + "\n")
    sys.stderr.flush()


def _windows(words, silences, duration, gap_min, conf_low, drag_min):
    """Fenêtres candidates : trous inter-mots + mots low-conf + mots courts traînés (sinon clip
    entier hors silences si pas de transcription)."""
    wins = []
    ws = sorted(words or [], key=lambda w: w.get("start", 0.0))
    for i in range(len(ws) - 1):
        g0, g1 = ws[i].get("end", 0.0), ws[i + 1].get("start", 0.0)
        if g1 - g0 >= gap_min:
            wins.append((g0, g1))
    if ws:
        if ws[0].get("start", 0.0) > gap_min:
            wins.append((0.0, ws[0]["start"]))
        if duration - ws[-1].get("end", 0.0) > gap_min:
            wins.append((ws[-1]["end"], duration))
        for w in ws:
            w0, w1 = w.get("start", 0.0), w.get("end", 0.0)
            if w.get("conf", 1.0) < conf_low:
                wins.append((max(0.0, w0 - 0.1), w1 + 0.1))
            # mot COURT tenu anormalement longtemps (« ettttt », « laaaa ») → à confirmer au signal
            elif drag_min > 0 and (w1 - w0) >= drag_min and len(str(w.get("word", "")).strip(" .,!?;:…")) <= 4:
                wins.append((max(0.0, w0 - 0.05), w1 + 0.05))
    else:  # pas de transcription : tout sauf les silences
        cur = 0.0
        for s in (silences or []):
            if s["start"] - cur > gap_min:
                wins.append((cur, s["start"]))
            cur = s["end"]
        if duration - cur > gap_min:
            wins.append((cur, duration))
    return wins


def detect_fillers(audio_path, words, silences, params=None):
    p = params or {}
    # Défauts AGRESSIFS (recall max demandé : « détecte vraiment tous les euh/ah »). 2/5 critères
    # suffisent, fenêtre de durée large, F0 toléré jusqu'à 20 Hz. On assume les faux positifs :
    # ce sont des suggestions barrables au clic dans le panneau CUTS.
    f0_std_max = float(p.get("f0_std", 20.0))
    flux_ratio = float(p.get("flux_ratio", 0.7))
    rms_std_db = float(p.get("rms_std_db", 5.0))
    min_dur = float(p.get("min_dur", 0.12))
    max_dur = float(p.get("max_dur", 1.6))
    min_score = float(p.get("min_score", 0.4))
    conf_low = float(p.get("conf_low", 0.6))
    gap_min = float(p.get("gap_min", 0.08))
    drag_min = float(p.get("drag_min", 0.35))  # durée mini d'un mot court pour la fenêtre « traîné »
    # garde anti-faux-positif sur les voyelles tenues : seuil HAUT (0.97) → on ne rejette QUE les
    # prolongations quasi-identiques. L'utilisateur VEUT les sons traînés (= hésitations) détectés.
    cont_max = float(p.get("cont_max", 0.97))

    _emit("STAGE:load")
    import librosa
    import soundfile as sf
    data, sr = sf.read(audio_path, dtype="float32")
    if getattr(data, "ndim", 1) > 1:
        data = data[:, 0]
    if sr != SR:
        data = librosa.resample(data, orig_sr=sr, target_sr=SR)
        sr = SR
    duration = float(len(data)) / sr
    if duration < min_dur:
        return {"fillers": [], "duration": duration}

    _emit("STAGE:infer")
    S = np.abs(librosa.stft(data, n_fft=N_FFT, hop_length=HOP))
    logS = np.log(S + 1e-6)  # enveloppe spectrale (log) pour la continuité mel/spectre
    flux = np.zeros(S.shape[1])
    if S.shape[1] > 1:
        flux[1:] = np.sqrt(np.sum(np.maximum(0.0, S[:, 1:] - S[:, :-1]) ** 2, axis=0))
    pos = flux[flux > 0]
    flux_med = float(np.median(pos)) if pos.size else 1e-6
    rms = librosa.feature.rms(S=S, frame_length=N_FFT, hop_length=HOP)[0]
    rms_db = 20.0 * np.log10(rms + 1e-8)
    zcr = librosa.feature.zero_crossing_rate(data, frame_length=N_FFT, hop_length=HOP)[0]
    f0, vflag, _ = librosa.pyin(data, fmin=65, fmax=400, sr=sr, frame_length=N_FFT * 2, hop_length=HOP)

    n = min(len(flux), len(rms_db), len(zcr), len(f0))
    flux, rms_db, zcr, f0 = flux[:n], rms_db[:n], zcr[:n], f0[:n]

    # plancher de bruit = médiane RMS des silences Silero + 6 dB
    sil = []
    for s in (silences or []):
        a, b = int(s["start"] * sr / HOP), int(s["end"] * sr / HOP)
        sil.extend(rms_db[max(0, a):min(n, b)])
    base = float(np.median(sil)) if sil else float(np.percentile(rms_db, 10))
    # plancher robuste : un silence numérique pur (~-160 dB) donnerait un plancher absurde → on borne
    # par le 10e percentile du RMS du clip (proxy fiable du bruit de fond réel).
    noise_floor = max(base + 6.0, float(np.percentile(rms_db, 10)))

    def fr(t):
        return max(0, min(n, int(t * sr / HOP)))

    # son présent (au-dessus du plancher de bruit) ET voisé (pitch détecté) → frame de « son tenu »
    voiced_all = (np.nan_to_num(f0) > 0) & (rms_db > noise_floor)

    def all_runs(mask):
        """Tous les segments True (indices locaux) — une fenêtre peut contenir PLUSIEURS sons tenus
        (« euh… euh »), le plus long seul en ratait."""
        runs = []; cs = None
        for i, m in enumerate(mask):
            if m and cs is None:
                cs = i
            elif not m and cs is not None:
                runs.append((cs, i)); cs = None
        if cs is not None:
            runs.append((cs, len(mask)))
        return runs

    def formants(rs, re):
        """(F1, F2) par LPC sur le cœur du run (pré-emphase, ordre 2+sr/1000). Les racines sont
        filtrées par LARGEUR DE BANDE (< 400 Hz) : un vrai formant est un pôle étroit, les pôles
        larges sont des parasites d'enveloppe (validé : sans ce filtre, faux F2 ~1245 Hz systématique).
        None si échec."""
        try:
            import librosa as _lr
            pad = max(0, (re - rs) // 5)  # cœur ~60 % (évite les transitions aux bords)
            s0, s1 = (rs + pad) * HOP, (re - pad) * HOP
            seg = data[s0:min(s1, len(data))]
            if len(seg) < 320:  # < 20 ms : trop court pour un LPC stable
                return None
            seg = np.append(seg[0], seg[1:] - 0.97 * seg[:-1])  # pré-emphase
            A = _lr.lpc(seg.astype(np.float64), order=2 + SR // 1000)
            freqs = []
            for r in np.roots(A):
                if np.imag(r) <= 0.01:
                    continue
                f = float(np.angle(r) * SR / (2 * np.pi))
                bw = float(-(SR / np.pi) * np.log(np.abs(r) + 1e-12))
                if 90.0 < f < SR / 2 - 50.0 and bw < 400.0:
                    freqs.append(f)
            freqs.sort()
            if len(freqs) < 2:
                return None
            return freqs[0], freqs[1]
        except Exception:  # noqa: BLE001 — critère bonus, jamais bloquant
            return None

    ws = sorted(words or [], key=lambda w: w.get("start", 0.0))

    def prev_word_end_frame(t_start):
        """Frame de fin du mot CONFIANT juste avant t_start (pour la garde de continuité)."""
        best = None
        for w in ws:
            we = w.get("end", 0.0)
            if we <= t_start + 0.05 and w.get("conf", 1.0) >= 0.6:
                if best is None or we > best:
                    best = we
        return fr(best) if best is not None else None

    def spectral_continuity(rs):
        """Cosinus enveloppe(fin mot précédent) vs enveloppe(début run). Haut = prolongation de voyelle."""
        pe = prev_word_end_frame(rs * HOP / sr)
        if pe is None or pe < 1 or abs(pe - rs) * HOP / sr > 0.12:
            return 0.0
        ev_prev = logS[:, max(0, pe - 3):pe].mean(axis=1)
        ev_run = logS[:, rs:min(n, rs + 3)].mean(axis=1)
        d = float(np.linalg.norm(ev_prev) * np.linalg.norm(ev_run))
        return float(np.dot(ev_prev, ev_run) / d) if d > 0 else 0.0

    out = []
    seen = set()  # les fenêtres se chevauchent (trou + mot low-conf) → dédoublonnage des runs
    for (t0, t1) in _windows(words, silences, duration, gap_min, conf_low, drag_min):
        a, b = fr(t0), fr(t1)
        if b - a < 3:
            continue
        # scorer TOUS les runs de son tenu de la fenêtre (≠ scorer le mélange euh+silence)
        for (rs0, re0) in all_runs(voiced_all[a:b]):
            rs, re = a + rs0, a + re0
            if (rs, re) in seen:
                continue
            seen.add((rs, re))
            dur_run = (re - rs) * HOP / sr
            if dur_run < min_dur or dur_run > max_dur:
                continue
            f0v = f0[rs:re][np.nan_to_num(f0[rs:re]) > 0]
            score = 0
            score += 1  # durée déjà dans [min_dur, max_dur]
            if len(f0v) > 2 and float(np.nanstd(f0v)) < f0_std_max:
                score += 1
            if float(np.median(flux[rs:re])) < flux_ratio * flux_med:
                score += 1
            if float(np.std(rms_db[rs:re])) < rms_std_db and float(np.median(rms_db[rs:re])) > noise_floor:
                score += 1
            if float(np.mean(zcr[rs:re])) < 0.15:
                score += 1
            # timbre de voyelle centrale (« euh »/schwa) : F1 250-900 Hz, F2 850-2000 Hz (Goto)
            fm = formants(rs, re)
            if fm and 250.0 <= fm[0] <= 900.0 and 850.0 <= fm[1] <= 2000.0:
                score += 1
            if score / 6.0 < min_score:
                continue
            # garde anti-faux-positif : voyelle tenue en prolongation d'un mot confiant (même spectre)
            # → rejet SEULEMENT si quasi-identique (seuil haut) — les sons traînés d'hésitation passent.
            if spectral_continuity(rs) > cont_max:
                continue
            out.append({"start": round(rs * HOP / sr, 3),
                        "end": round(re * HOP / sr, 3),
                        "conf": round(score / 6.0, 2)})
    out.sort(key=lambda s: s["start"])
    return {"fillers": out, "duration": duration}
