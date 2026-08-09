"""NetsuRush adapter for wentaozhu/AutoShot (CVPRW 2023, MIT)."""

import os

import numpy as np
import torch

from .model import TransNetV2Supernet


OFFICIAL_WEIGHTS_URL = "https://drive.google.com/drive/folders/1xZN6tvefXXmpZlIZ6GoSUUxpDQQOSNfJ?usp=sharing"


class AutoShotModel:
    def __init__(self, checkpoint_path, device=None):
        if not checkpoint_path or not os.path.isfile(checkpoint_path):
            raise FileNotFoundError(
                "Checkpoint AutoShot ckpt_0_200_0.pth introuvable. "
                "Téléchargement officiel : %s" % OFFICIAL_WEIGHTS_URL
            )
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.model = TransNetV2Supernet().eval()
        state = torch.load(checkpoint_path, map_location=self.device, weights_only=False)
        state = state.get("net", state) if isinstance(state, dict) else state
        current = self.model.state_dict()
        compatible = {key: value for key, value in state.items() if key in current}
        if not compatible:
            raise ValueError("Checkpoint AutoShot incompatible : aucune couche reconnue")
        current.update(compatible)
        self.model.load_state_dict(current)
        self.model.to(self.device).eval()

    @staticmethod
    def _batches(frames):
        remainder = (50 - len(frames) % 50) % 50
        padded = np.concatenate(([frames[0]] * 25, frames, [frames[-1]] * (remainder + 25)), axis=0)
        for offset in range(0, len(padded) - 50, 50):
            yield padded[offset:offset + 100]

    def predict(self, frames, threshold=0.296, progress=None):
        if not isinstance(frames, np.ndarray) or frames.ndim != 4 or frames.shape[-1] != 3:
            raise ValueError("AutoShot attend des frames (T,H,W,3)")
        if len(frames) == 0:
            return np.zeros((0,), dtype=np.float32)
        batches = list(self._batches(frames))
        predictions = []
        with torch.inference_mode():
            for index, batch in enumerate(batches):
                tensor = torch.from_numpy(batch.transpose((3, 0, 1, 2))[np.newaxis, ...]).float().to(self.device)
                logits = self.model(tensor)
                if isinstance(logits, tuple):
                    logits = logits[0]
                scores = torch.sigmoid(logits[0]).detach().cpu().numpy().reshape(-1)
                predictions.append(scores[25:75])
                if progress:
                    progress(index + 1, len(batches))
        return np.concatenate(predictions, axis=0)[:len(frames)] > float(threshold)


def load(checkpoint_path, device=None):
    return AutoShotModel(checkpoint_path, device=device)
