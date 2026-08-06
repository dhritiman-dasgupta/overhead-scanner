# Overhead Scanner — Requirements

A browser-based capture and document-processing app for an overhead ("book scanner" /
document camera) USB webcam. Runs entirely client-side; no image ever leaves the machine.

---

## 1. Context and constraints

| | |
|---|---|
| **Hardware** | Any UVC webcam mounted above a desk, pointed down at a document. Typically 1080p–4K, fixed focus or autofocus, uneven desk lighting, no flatbed glass. |
| **Platform** | Single-page HTML app. Chrome / Edge / Safari on macOS. No build step, no server-side code, no network calls at runtime. |
| **Privacy** | All processing local: `getUserMedia` → canvas → WASM OCR. Vendored Tesseract + language data so it works with the network off. |
| **Serving** | Must be served over `http://localhost` (or `file://` in Chrome) because `getUserMedia` requires a secure context. Safari requires `localhost`. |

### Problems specific to overhead capture (these drive the feature list)

1. The camera is **not parallel** to the page → keystone/perspective distortion.
2. Lighting is **uneven** — a lamp on one side leaves a gradient and shadows; the operator's
   hand casts shadow at the page edge.
3. The page is a **small bright rectangle on a dark desk** → naive auto-exposure blows out
   or muddies the paper.
4. The operator's **hands are in frame** while turning pages → capture must wait for stillness.
5. Output must be **legible and small**: a 4K photo of a page is 6 MB; a thresholded scan is 60 KB.

---

## 2. Functional requirements

### FR-1 Capture

- **FR-1.1** Enumerate video input devices; let the user pick one; remember the choice.
- **FR-1.2** Request the highest resolution the device offers; expose a resolution selector
  (Auto / 4K / 1440p / 1080p / 720p) and show the negotiated resolution.
- **FR-1.3** Live preview, correctly letterboxed, never stretched.
- **FR-1.4** Single-shot capture at **full sensor resolution**, not preview resolution.
- **FR-1.5** **Auto-capture on stability** — detect motion via frame differencing; once the
  scene has been still for a configurable dwell time *and* has changed since the last shot,
  capture automatically. This is the page-turn workflow.
- **FR-1.6** **Interval capture** — shoot every N seconds, for bulk work.
- **FR-1.7** Camera controls where the browser exposes them: zoom, torch, focus mode,
  manual exposure. Degrade silently when unsupported.
- **FR-1.8** Framing aids: rule-of-thirds grid, centre cross, A4/Letter aspect guide.
- **FR-1.9** Mirror preview toggle (some overhead rigs use a mirror arm).
- **FR-1.10** Import existing image files as pages (drag-drop or file picker), so the app is
  useful without a camera attached.

### FR-2 Geometry

- **FR-2.1** **Auto page-edge detection** — find the document quadrilateral in the frame.
- **FR-2.2** **Manual corner adjustment** — drag the four corners over a magnified view.
- **FR-2.3** **Perspective correction** — warp the quad to a rectangle (homography +
  bilinear resampling), with output aspect ratio estimated from the quad geometry.
- **FR-2.4** Rotate 90° left/right/180, flip H/V, and fine straighten (±15°).
- **FR-2.5** Output size presets: Original / A4 / Letter / fit-to-detected-aspect.

### FR-3 Enhancement — filters

Selectable, one-click, each tuned for a different source:

| Filter | Use |
|---|---|
| **Original** | No processing |
| **Auto** | Illumination flattening + white balance + contrast stretch. The default. |
| **Colour document** | Keeps photos/highlighter, cleans the paper to white |
| **Greyscale** | Neutral, keeps tone |
| **Black & white** | Adaptive (Bradley/Sauvola-style local) threshold — text pages, smallest files |
| **Whiteboard** | Aggressive background removal, saturated pen strokes |
| **Ink / high contrast** | Pencil and faint print rescue |
| **Photo** | Minimal correction, preserves gradients |

### FR-4 Enhancement — manual colour correction

Independent sliders, live preview, applied in a defined order:

- Shadow / illumination flattening (background division), strength 0–100
- White balance: off / gray-world / white-patch
- Temperature and tint
- Exposure (brightness), contrast, gamma
- Saturation, vibrance
- Highlights and shadows (tone curve endpoints)
- Sharpen (unsharp mask), denoise (median)
- B&W threshold: automatic (Otsu) or manual, plus local-window size
- Invert
- **Reset per-slider and reset-all**; per-page settings, plus "apply my settings to all pages"

### FR-5 OCR

- **FR-5.1** Tesseract WASM, run on the **processed** image (so filters improve accuracy).
- **FR-5.2** Progress reporting, cancellable, non-blocking UI (worker thread).
- **FR-5.3** Page-segmentation mode selector (auto / single block / single column / sparse).
- **FR-5.4** Show recognised text in an editable panel; show mean confidence.
- **FR-5.5** Word-box overlay on the image, coloured by confidence.
- **FR-5.6** OCR one page or the whole batch.
- **FR-5.7** Additional languages loadable by dropping a `.traineddata` file into `vendor/tessdata/`.

### FR-6 Pages and batch

- **FR-6.1** Thumbnail tray: reorder (drag), duplicate, delete, select.
- **FR-6.2** Per-page independent edits; batch-apply of settings and batch OCR.
- **FR-6.3** Persist pages and settings in IndexedDB so a reload doesn't lose the session.
- **FR-6.4** Page counter, total size estimate.

### FR-7 Export

- **FR-7.1** PNG / JPEG / WebP for the current page, quality slider, full resolution.
- **FR-7.2** **Multi-page PDF**, A4 / Letter / auto page size, fit or fill, JPEG-compressed.
- **FR-7.3** **Searchable PDF** — invisible OCR text layer positioned over the image, so the
  PDF is selectable and findable in Preview/Acrobat.
- **FR-7.4** Plain-text export (single page or concatenated).
- **FR-7.5** Copy image to clipboard; print.
- **FR-7.6** PDF writer implemented in-app (no external library) so export works offline.

### FR-8 UI

- **FR-8.1** Dark, high-contrast shell — the app is used next to a lamp; a white UI reflects
  in glossy pages and biases the operator's judgement of the scan.
- **FR-8.2** Three zones: page tray (left), stage (centre), inspector (right, tabbed:
  Capture / Adjust / OCR / Export).
- **FR-8.3** Before/after compare (hold to view original).
- **FR-8.4** Zoom and pan the stage; fit-to-window; 1:1.
- **FR-8.5** Keyboard shortcuts for every frequent action; discoverable via a help overlay.
- **FR-8.6** Non-blocking toasts for status; explicit error text when the camera is denied.
- **FR-8.7** Responsive down to a laptop screen; panels collapsible.

---

## 3. Non-functional requirements

- **NFR-1 Responsiveness** — preview processing at ≤ 1600 px long edge so sliders feel live
  (< 50 ms/update); full-resolution processing only on export and OCR.
- **NFR-2 Offline** — zero runtime network requests. Tesseract core, worker and `eng`
  traineddata are vendored in `vendor/`.
- **NFR-3 No build step** — classic scripts, no bundler, no `type="module"` (so `file://`
  works in Chrome). Open the file, or serve the folder.
- **NFR-4 No runtime dependencies** other than the vendored OCR engine. Image processing,
  geometry and PDF writing are hand-written.
- **NFR-5 Graceful degradation** — missing camera, denied permission, unsupported
  `MediaStreamTrack` capabilities, or absent OCR assets must each leave the rest usable.
- **NFR-6 Memory** — full-resolution bitmaps held per page; thumbnails downscaled; canvases
  released on page delete.

---

## 4. Processing pipeline (defined order)

```
sensor frame (full res)
  └─ perspective warp (quad → rect, bilinear)
      └─ rotate / flip / straighten
          └─ illumination flattening   (divide by heavily-blurred background)
              └─ white balance          (gray-world or white-patch scalars)
                  └─ temperature / tint
                      └─ exposure → contrast → gamma
                          └─ highlights / shadows
                              └─ saturation / vibrance
                                  └─ denoise (median 3×3)
                                      └─ sharpen (unsharp mask)
                                          └─ filter mode
                                              (grey / adaptive threshold / whiteboard / ink)
                                              └─ invert
                                                  └─ output
```

The same code path runs for preview (downscaled) and export (full resolution); only the
input scale differs, so what you see is what you get.

---

## 5. Out of scope (v1)

- Cloud OCR, translation, handwriting recognition
- Multi-camera simultaneous capture, stereo dewarping of curved book spines
- Table/layout reconstruction to DOCX or XLSX
- Barcode/QR decoding
- Mobile browsers (the target is a desk rig)

---

## 6. Acceptance criteria

1. With a webcam attached, the live preview appears within 2 s of granting permission.
2. A sheet of A4 is auto-detected and warped to a rectangle with all four corners within
   ~2 % of the page edge, on a dark mat, a wooden desk, a pale desk, and under a single
   side lamp. Where there is no page, no crop is produced — detection declines rather than
   guessing, since a wrong crop is worse than none.
3. A page shot under a single side lamp comes out with a uniformly white background under
   the **Auto** filter, with no visible gradient.
4. Adjusting any slider updates the preview without perceptible lag.
5. OCR of a clean 12 pt printed page returns > 95 % mean confidence and correct text.
6. A 10-page batch exports to a single searchable PDF whose text is selectable in Preview,
   at under ~300 KB/page in B&W mode.
7. Turning the network off changes nothing about the app's behaviour.
8. Reloading the browser restores the page tray.
