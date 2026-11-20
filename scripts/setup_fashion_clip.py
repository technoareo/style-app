"""Explicit, one-time FashionCLIP download. Inference itself is network-disabled."""
import hashlib
import os
from pathlib import Path
import shutil

from huggingface_hub import snapshot_download

MODEL = "Marqo/marqo-fashionCLIP"
REVISION = "44f4c655124ed71e90cbf528d82f508d69d8a81b"
FILES = ("open_clip_model.safetensors", "open_clip_config.json")

target = Path(os.environ.get("FASHION_MODEL_DIR", ".runtime/fashionclip-model")).resolve()
target.mkdir(parents=True, exist_ok=True)
snapshot = Path(snapshot_download(repo_id=MODEL, revision=REVISION, allow_patterns=list(FILES)))
lines = []
for name in FILES:
    source = snapshot / name
    destination = target / name
    shutil.copyfile(source, destination)
    lines.append(f"{hashlib.sha256(destination.read_bytes()).hexdigest()}  {name}")
(target / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"Prepared {MODEL}@{REVISION} in {target}")
