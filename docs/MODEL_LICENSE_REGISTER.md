# Model licence register

This register is an engineering gate, not legal advice. An entry marked
`owner-test only` must not be enabled for beta or public use until its training
data and commercial-use terms have been reviewed and recorded.

| Model | Exact version | Weights licence | Base model / data disclosure | Current gate |
| --- | --- | --- | --- | --- |
| Marqo FashionCLIP | `44f4c655124ed71e90cbf528d82f508d69d8a81b` | Apache-2.0 per publisher model card | Publisher says it fine-tunes ViT-B-16 `laion2b_s34b_b88k`; the full fine-tuning dataset provenance is not sufficiently documented here | Owner-test only; disabled by default; beta/public blocked |
| BiRefNet Lite | Not selected | Review pending | Training-data and commercial-use review pending | Not integrated; beta/public blocked |

Runtime packages `torch`, `open_clip_torch`, `Pillow`, and `huggingface_hub`
must also appear in the distributed third-party notices before any packaged
FashionCLIP build is shared.
