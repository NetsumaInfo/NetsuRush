"""File I/O for native libraries that open paths in the Windows ANSI code page.

OpenCV (`imread`, `imwrite`, `FaceDetectorYN.create`, ...) and FAISS (`read_index`, `write_index`)
pass the path to the C runtime as a narrow string. On Windows that string is read in the ANSI code
page, so a profile such as `C:\\Users\\Hélène` or `C:\\Users\\山田` cannot be opened, and
`PYTHONUTF8` does not change it. Python's own file I/O takes the wide-character path, so these
helpers read and write the bytes in Python and hand buffers to the native side.
"""
import os

import numpy as np


def read_u8(path):
    """Whole file as a uint8 array (the buffer form OpenCV's `create` overloads take)."""
    return np.fromfile(path, dtype=np.uint8)


def cv_imread(path, flags):
    """`cv2.imread` that accepts any path. None when the file is missing, empty or undecodable."""
    import cv2
    try:
        buf = np.fromfile(path, dtype=np.uint8)
    except OSError:
        return None
    if buf.size == 0:
        return None
    return cv2.imdecode(buf, flags)


def cv_imwrite(path, img, params=None):
    """`cv2.imwrite` that accepts any path. The format follows the extension. False on failure."""
    import cv2
    ext = os.path.splitext(path)[1] or ".png"
    try:
        ok, buf = cv2.imencode(ext, img, list(params or []))
    except cv2.error:
        return False
    if not ok:
        return False
    try:
        buf.tofile(path)
    except OSError:
        return False
    return True


def faiss_write(faiss, index, path):
    """`faiss.write_index` through Python file I/O."""
    data = faiss.serialize_index(index)
    with open(path, "wb") as f:
        f.write(np.asarray(data, dtype=np.uint8).tobytes())


def faiss_read(faiss, path):
    """`faiss.read_index` through Python file I/O."""
    return faiss.deserialize_index(np.fromfile(path, dtype=np.uint8))
