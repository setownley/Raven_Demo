import stanza
import sys
import json
import io
import os
import time
import torch


# 🧾 Ensure stdin is UTF-8 wrapped
sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')

# 🔧 Limit Torch threads to prevent over-parallelization issues
torch.set_num_threads(4)

# 🧠 System info
print("[INFO] Torch threads available:", os.cpu_count(), flush=True)
print(f"[INFO] Torch set to {torch.get_num_threads()} threads", flush=True)



# 📦 Custom download dir (Railway-compatible)
os.environ["STANZA_RESOURCES_DIR"] = "stanza_resources"

# 📥 Download model if missing
model_path = os.path.join("stanza_resources", "en", "tokenize", "stanza_model.pt")
if not os.path.exists(model_path):
    print("[*] Downloading Stanza English model...", flush=True)
    stanza.download("en")

# ⚙️ Load pipeline
nlp = stanza.Pipeline(
    lang="en",
    processors="tokenize,mwt",
    use_gpu=False,
    verbose=False
)

# 🔄 Warm up to reduce first inference time
_ = nlp("Priming the model.")
print("[STANZA] Stanza NLP pipeline ready", flush=True)

# 🧪 Handle input and process
buffer = ""
for line in sys.stdin:
    buffer += line
    if "<<end>>" in buffer:
        text = buffer.replace("<<end>>", "").strip()
        buffer = ""
        try:
            start = time.perf_counter()
            doc = nlp(text)
            duration = round(time.perf_counter() - start, 3)
            sentences = [s.text for s in doc.sentences]

            # Output JSON with unicode preserved
            print(json.dumps(sentences, ensure_ascii=False), flush=True)
            print(f"[TIMING] Processed in {duration:.3f} seconds using {torch.get_num_threads()} threads", flush=True)

        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)
