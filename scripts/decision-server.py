"""Decision-model router for npi's `router.classifierEndpoint`, backed by InternLM's Intern-Decision models.

Intern-Decision scores fixed answer options from logits (no text generation), so one forward pass answers
both npi questions: which route, and which effort tier. Runs on CPU or GPU.

Setup (Python 3.12+):
    uv venv --python 3.12 ~/.npi/decision/venv
    uv pip install --python ~/.npi/decision/venv torch==2.9.1 torchvision==0.24.1 --index-url https://download.pytorch.org/whl/cpu
    uv pip install --python ~/.npi/decision/venv transformers==5.14.1 Pillow huggingface_hub
    hf download internlm/Intern-Decision-0.8B --local-dir ~/.npi/decision/Intern-Decision-0.8B

Run, then set "classifierEndpoint": "http://127.0.0.1:8090/route" in npi.json (or a profile):
    ~/.npi/decision/venv/Scripts/python -I scripts/decision-server.py --model-dir ~/.npi/decision/Intern-Decision-0.8B

Contract: POST /route {text, routes: [{name, description}], tiers} -> {route, confidence, tier, tierConfidence, ms}.
GET /health -> {ok, model, device}.
"""

import argparse
import importlib.util
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

# Keep in sync with TIER_RUBRIC in src/core/router.ts.
TIERS = {
    "light": "Lookups, explanations of small things, renames, formatting, one-line or single-function edits, chit-chat.",
    "standard": "Ordinary multi-step coding, research or writing tasks.",
    "heavy": "Multi-file design or refactors, security, data migrations, proofs, statistics, ambiguous or high-stakes specs, or retrying something that already failed.",
}


def load_engine(model_dir: Path, device: str, dtype: str):
    # The checkpoint ships its own inference module (official DecisionEngine); load it by path.
    spec = importlib.util.spec_from_file_location("intern_decision_inference", model_dir / "inference.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses in the module look themselves up here
    spec.loader.exec_module(module)
    return module.DecisionEngine(str(model_dir), device=device, dtype=dtype)


def build_request(body: dict) -> dict:
    routes = body.get("routes") or []
    if not routes:
        raise ValueError("routes must be a non-empty list")
    tiers = [t for t in (body.get("tiers") or list(TIERS)) if t in TIERS]
    return {
        "state": {"request": str(body.get("text", ""))[:4000]},
        "questions": {
            "route": {
                "type": "choice",
                "instructions": "Which handler should take this user request?",
                "criteria": {r["name"]: r.get("description", r["name"]) for r in routes},
            },
            "tier": {
                "type": "choice",
                "instructions": "How much effort and model capability does this request need?",
                "criteria": {t: TIERS[t] for t in tiers},
            },
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--model-dir", default=str(Path.home() / ".npi" / "decision" / "Intern-Decision-0.8B"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--dtype", default=None, help="float32 | bfloat16 | float16 (default: float32 on CPU, bfloat16 on GPU)")
    parser.add_argument("--threads", type=int, default=0, help="torch CPU threads (0 = torch default)")
    args = parser.parse_args()

    import torch

    if args.threads:
        torch.set_num_threads(args.threads)
    dtype = args.dtype or ("float32" if args.device == "cpu" else "bfloat16")
    model_dir = Path(os.path.expanduser(args.model_dir))
    started = time.perf_counter()
    engine = load_engine(model_dir, args.device, dtype)
    lock = Lock()  # one forward pass at a time; the engine is not documented as thread-safe
    warm = build_request({"text": "warm up", "routes": [{"name": "chat", "description": "general"}, {"name": "code", "description": "code"}]})
    engine.predict(warm)
    print(f"loaded {model_dir.name} on {args.device}/{dtype} in {time.perf_counter() - started:.1f}s; listening on http://{args.host}:{args.port}/route", flush=True)

    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, payload: dict) -> None:
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path == "/health":
                return self._send(200, {"ok": True, "model": model_dir.name, "device": args.device, "dtype": dtype})
            self._send(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path != "/route":
                return self._send(404, {"error": "not found"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
                request = build_request(body)
                t0 = time.perf_counter()
                with lock:
                    answers = engine.predict(request)["answers"]
                ms = round((time.perf_counter() - t0) * 1000, 1)
                route, tier = answers["route"], answers["tier"]
                self._send(200, {
                    "route": route["decision"],
                    "confidence": route["confidence"],
                    "tier": tier["decision"],
                    "tierConfidence": tier["confidence"],
                    "ms": ms,
                })
            except Exception as error:  # report bad requests instead of dropping the connection
                self._send(400, {"error": str(error)})

        def log_message(self, *_args) -> None:  # quiet; npi logs its own telemetry
            pass

    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
