import io
import json
import sys

import open_clip
import torch
from PIL import Image

CATEGORIES = {"tops": "a top, shirt, blouse, t-shirt, sweater, or cardigan", "bottoms": "trousers, jeans, shorts, or a skirt", "dresses": "a dress or jumpsuit", "outerwear": "a jacket, coat, blazer, or outerwear", "shoes": "shoes, boots, sandals, or sneakers", "accessories": "a bag, belt, scarf, hat, jewellery, or accessory"}
PATTERNS = {"solid": "a solid colour garment with no print", "striped": "a striped garment", "checked": "a checked, plaid, or gingham garment", "floral": "a floral garment", "graphic": "a garment with a graphic print", "polka dot": "a polka dot garment", "animal print": "an animal print garment"}
MATERIALS = {name: f"visible {description} texture" for name, description in {"denim": "denim", "knit": "knitted", "leather": "leather", "suede": "suede", "corduroy": "corduroy", "fleece": "fleece", "satin": "satin", "lace": "lace", "sheer": "sheer", "canvas": "canvas", "mesh": "mesh"}.items()}

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
    model, _, preprocess = open_clip.create_model_and_transforms("hf-hub:Marqo/marqo-fashionCLIP", device="cpu")
    tokenizer = open_clip.get_tokenizer("hf-hub:Marqo/marqo-fashionCLIP")
    with torch.inference_mode():
        image_features = model.encode_image(preprocess(image).unsqueeze(0), normalize=True)
    result = {"category": classify(model, tokenizer, image_features, CATEGORIES), "pattern": classify(model, tokenizer, image_features, PATTERNS), "material": classify(model, tokenizer, image_features, MATERIALS)}
    sys.stdout.write(json.dumps(result, separators=(",", ":")))

if __name__ == "__main__":
    main()
