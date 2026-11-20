import io
import hashlib
import json
import os
from pathlib import Path
import sys

import open_clip
import torch
from PIL import Image

CATEGORIES = {"tops": "a top, shirt, blouse, t-shirt, sweater, or cardigan", "bottoms": "trousers, jeans, shorts, or a skirt", "dresses": "a dress or jumpsuit", "outerwear": "a jacket, coat, blazer, or outerwear", "shoes": "shoes, boots, sandals, or sneakers", "accessories": "a bag, belt, scarf, hat, jewellery, or accessory"}
PATTERNS = {"solid": "a solid colour garment with no print", "striped": "a striped garment", "checked": "a checked, plaid, or gingham garment", "floral": "a floral garment", "graphic": "a garment with a graphic print", "polka dot": "a polka dot garment", "animal print": "an animal print garment"}
MATERIALS = {name: f"visible {description} texture" for name, description in {"denim": "denim", "knit": "knitted", "leather": "leather", "suede": "suede", "corduroy": "corduroy", "fleece": "fleece", "satin": "satin", "lace": "lace", "sheer": "sheer", "canvas": "canvas", "mesh": "mesh"}.items()}
EXPECTED_REVISION = "44f4c655124ed71e90cbf528d82f508d69d8a81b"

def verify_model(model_dir: Path) -> Path:
    if os.environ.get("HF_HUB_OFFLINE") != "1" or os.environ.get("FASHION_MODEL_REVISION") != EXPECTED_REVISION:
        raise RuntimeError("FashionCLIP must run offline at the reviewed revision")
    manifest = model_dir / "SHA256SUMS"
    weights = model_dir / "open_clip_model.safetensors"
    if not manifest.is_file() or not weights.is_file():
        raise RuntimeError("FashionCLIP model was not prepared")
    expected = {}
    for line in manifest.read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", 1)
        expected[name] = digest
    required = ["open_clip_model.safetensors", "open_clip_config.json"]
    for name in required:
        target = model_dir / name
        if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != expected.get(name):
            raise RuntimeError(f"FashionCLIP checksum failed: {name}")
    return weights

def classify(model, tokenizer, image_features, choices):
    labels = list(choices.keys())
    text = tokenizer([choices[label] for label in labels])
    with torch.inference_mode():
        text_features = model.encode_text(text, normalize=True)
        probabilities = (100.0 * image_features @ text_features.T).softmax(dim=-1)[0]
    index = int(probabilities.argmax().item())
    return {"label": labels[index], "score": float(probabilities[index].item())}

def main():
    image = Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB")
    weights = verify_model(Path(os.environ["FASHION_MODEL_DIR"]).resolve())
    model, _, preprocess = open_clip.create_model_and_transforms("ViT-B-16", pretrained=str(weights), device="cpu")
    tokenizer = open_clip.get_tokenizer("ViT-B-16")
    with torch.inference_mode():
        image_features = model.encode_image(preprocess(image).unsqueeze(0), normalize=True)
    result = {"category": classify(model, tokenizer, image_features, CATEGORIES), "pattern": classify(model, tokenizer, image_features, PATTERNS), "material": classify(model, tokenizer, image_features, MATERIALS)}
    sys.stdout.write(json.dumps(result, separators=(",", ":")))

if __name__ == "__main__":
    main()
