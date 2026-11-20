#!/usr/bin/env python3
"""Fabrique Feuillet.html : toute l'appli dans un seul fichier, à ouvrir d'un double-clic (sans serveur)."""
import base64, pathlib, sys
root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else root / "Feuillet.html")
html = (root / "index.html").read_text(encoding="utf-8")
app = (root / "app.js").read_text(encoding="utf-8")
b64 = lambda p: base64.b64encode((root / p).read_bytes()).decode()
icon = "data:image/svg+xml;base64," + b64("icons/icon.svg")

app = app.replace('import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";', """const __u = id => URL.createObjectURL(new Blob([Uint8Array.from(atob(document.getElementById(id).textContent.trim()), c => c.charCodeAt(0))], { type: "text/javascript" }));
const pdfjsLib = await import(__u("pdfjs-main"));""")
app = app.replace('const LIB = new URL("./vendor/pdfjs/", import.meta.url).href;\n', "")
app = app.replace('pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + "pdf.worker.min.mjs";', 'pdfjsLib.GlobalWorkerOptions.workerSrc = __u("pdfjs-worker");')
app = app.replace('const DOC_OPTS = { cMapUrl: LIB + "cmaps/", cMapPacked: true, standardFontDataUrl: LIB + "standard_fonts/", wasmUrl: LIB + "wasm/", iccUrl: LIB + "iccs/", isEvalSupported: false };',
                  'const DOC_OPTS = { isEvalSupported: false, useSystemFonts: true };')
assert "LIB" not in app.split("DOC_OPTS")[0] + app.split("DOC_OPTS")[1][:200], "remplacement raté"

html = html.replace('<link rel="manifest" href="manifest.webmanifest">\n', "")
html = html.replace('<link rel="apple-touch-icon" href="icons/icon-192.png">\n', "")
html = html.replace('icons/icon.svg', icon)
libs = (f'<script type="text/plain" id="pdfjs-main">{b64("vendor/pdfjs/pdf.min.mjs")}</script>\n'
        f'<script type="text/plain" id="pdfjs-worker">{b64("vendor/pdfjs/pdf.worker.min.mjs")}</script>\n'
        f'<script>{(root / "vendor/pdf-lib.min.js").read_text(encoding="utf-8")}</script>\n'
        f'<script type="module">{app}</script>')
html = html.replace('<script src="vendor/pdf-lib.min.js"></script>\n<script type="module" src="app.js"></script>', libs)
assert 'src="app.js"' not in html
out.write_text(html, encoding="utf-8")
print(out, round(out.stat().st_size / 1e6, 1), "Mo")
