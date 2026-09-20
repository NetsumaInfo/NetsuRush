"""Sizing of an upscale job: what the network is fed, and what comes out of it.

Twin of `upscalePlan` in core/upscaleArgs.js; both are checked against
test/fixtures/upscale-plan.json. It lives here too because the rules need the native factor of the
network, which is only known once the model is loaded.

A network ALWAYS outputs `native × input`, so the input is the only free choice:
  - the input is the source, brought down to the 1080p box when it is larger, never below it;
  - when the network cannot reach the output from there, the input is enlarged BEFORE it
    (enlarging after would make up pixels the network never saw);
  - otherwise the network overshoots and its result is reduced to the output.
"""
import math

# Resolution class a network is never fed above: the HD box, 1920×1080.
FEED_CAP = 1080


def _even(n):
    """yuv420 needs even dimensions; never below 2 px."""
    r = int(math.floor(n + 0.5))
    return max(2, r - r % 2)


def _ceil_px(n):
    """Rounds up, ignoring float noise (1920.0000001 stays 1920)."""
    return max(1, int(math.ceil(n - 1e-6)))


def box_scale(w, h, short):
    """Factor fitting an image inside a resolution class. A class is named after its short side
    and spans 16:9, oriented like the image: 1080 is the 1920×1080 box, so a 1920×800 scope frame
    and a 1080×1920 vertical frame are both 1080p."""
    long_ = short * 16 / 9
    box_w, box_h = (long_, short) if w >= h else (short, long_)
    return min(box_w / w, box_h / h)


def plan_size(w, h, native, target=0, scale=1):
    """((feed_w, feed_h), (out_w, out_h)) for a source of w×h.

    `target` = resolution class (1080, 1440, 2160); 0 = the `scale` factor applies.
    `feed` equals (w, h) when the source goes to the network untouched."""
    out_scale = box_scale(w, h, target) if target else (int(scale or 0) or 1)
    out = (_even(w * out_scale), _even(h * out_scale))
    cap = min(1.0, box_scale(w, h, FEED_CAP))
    feed_scale = max(cap, out_scale / max(1, int(native or 1)))
    if feed_scale == 1:
        return (w, h), out
    # Rounded up: `native × input` must never land below the output.
    return (_ceil_px(w * feed_scale), _ceil_px(h * feed_scale)), out


def resize_to(frame, size, before_network=False):
    """Resizes a BGR frame to size (w, h); a no-op when it already has it.

    Before the network, an enlargement uses Lanczos. Every reduction uses INTER_AREA, the cv2 filter
    that averages instead of skipping pixels (Lanczos aliases when shrinking in cv2)."""
    import cv2
    h, w = frame.shape[:2]
    if (w, h) == tuple(size):
        return frame
    shrink = size[0] <= w and size[1] <= h
    interpolation = cv2.INTER_AREA if shrink or not before_network else cv2.INTER_LANCZOS4
    return cv2.resize(frame, tuple(size), interpolation=interpolation)
