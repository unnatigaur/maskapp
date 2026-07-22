"""
engine/ocr.py
Converts a PDF into page images and runs Tesseract OCR, normalizing the
raw parallel-array output into easy-to-work-with `Word` / `Line` objects
that every detector in this package builds on.
"""

import pytesseract
from pdf2image import convert_from_path

DPI = 300


def pdf_to_images(pdf_path: str, dpi: int = DPI):
    """Returns a list of PIL Images, one per page."""
    return convert_from_path(pdf_path, dpi=dpi)


def _cluster_into_lines(words):
    """
    Groups word indices into visual rows by y-position, rather than
    trusting Tesseract's own block/par/line numbering. In sparse-text
    mode (psm 11, used here because ID-card layouts scatter text in
    boxes) Tesseract frequently assigns words that are visibly on the
    same printed row to different "line" numbers, which silently broke
    every row-aware feature (table headers, same-line name/value
    pairs). Clustering by vertical center is layout-mode-independent.
    """
    if not words:
        return []
    order = sorted(range(len(words)), key=lambda i: (words[i]["top"], words[i]["left"]))
    clusters, current = [], [order[0]]
    for i in order[1:]:
        avg_top = sum(words[j]["top"] for j in current) / len(current)
        avg_h = sum(words[j]["height"] for j in current) / len(current)
        if abs(words[i]["top"] - avg_top) <= max(8, avg_h * 0.6):
            current.append(i)
        else:
            clusters.append(current)
            current = [i]
    clusters.append(current)
    return clusters


def ocr_page(image):
    """
    Runs Tesseract on a single page image and returns:
      words: list of dicts {text,left,top,width,height,right,bottom,conf,line_key}
      lines: list of dicts {key,text,left,top,right,bottom,word_idxs}
    line_key groups words by visual row (see _cluster_into_lines).
    """
    raw = pytesseract.image_to_data(
        image, output_type=pytesseract.Output.DICT, config="--psm 11 --oem 3"
    )
    words = []
    n = len(raw["text"])
    for i in range(n):
        text = raw["text"][i]
        if not text or not text.strip():
            continue
        left, top = raw["left"][i], raw["top"][i]
        width, height = raw["width"][i], raw["height"][i]
        words.append({
            "text": text,
            "left": left, "top": top, "width": width, "height": height,
            "right": left + width, "bottom": top + height,
            "conf": int(float(raw["conf"][i])) if raw["conf"][i] not in ("-1", -1) else -1,
        })

    clusters = _cluster_into_lines(words)
    for line_idx, idxs in enumerate(clusters):
        for i in idxs:
            words[i]["line_key"] = line_idx

    lines = []
    for line_idx, idxs in enumerate(clusters):
        idxs = sorted(idxs, key=lambda i: words[i]["left"])
        text = " ".join(words[i]["text"] for i in idxs)
        left = min(words[i]["left"] for i in idxs)
        top = min(words[i]["top"] for i in idxs)
        right = max(words[i]["right"] for i in idxs)
        bottom = max(words[i]["bottom"] for i in idxs)
        lines.append({
            "key": line_idx, "text": text, "left": left, "top": top,
            "right": right, "bottom": bottom, "word_idxs": idxs,
        })
    lines.sort(key=lambda l: (l["top"], l["left"]))

    return words, lines


def pad_bbox(left, top, right, bottom, img_w, img_h, pad=6):
    return (
        max(0, left - pad),
        max(0, top - pad),
        min(img_w, right + pad),
        min(img_h, bottom + pad),
    )


def words_bbox(words, idxs, img_w, img_h, pad=6):
    left = min(words[i]["left"] for i in idxs)
    top = min(words[i]["top"] for i in idxs)
    right = max(words[i]["right"] for i in idxs)
    bottom = max(words[i]["bottom"] for i in idxs)
    return pad_bbox(left, top, right, bottom, img_w, img_h, pad)
