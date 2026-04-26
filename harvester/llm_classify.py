"""Re-classify "Autre / non classé" theses using Gemini's batch API.

The rule-based classifier in classify.py leaves ~28% of records unclassified
because their dc:subject is empty or uses keywords we don't recognize. This
script offloads those to a Gemini Flash model in *batch* mode (cheaper +
designed for bulk async work).

Workflow
--------
  python harvester/llm_classify.py preview [--limit N]
      Show the JSONL that would be sent. No API call. Free dry-run.

  python harvester/llm_classify.py submit [--limit N] [--model gemini-flash-latest]
      Build JSONL, upload, create batch job, print job name. Returns.
      Use this if you want to come back later — batch jobs survive.

  python harvester/llm_classify.py poll JOB_NAME
      Check status. If SUCCEEDED, download + apply results to the DB.

  python harvester/llm_classify.py run [--limit N] [--model ...]
      submit + poll-loop + apply, all in one. Ctrl-C is safe — the batch
      keeps running on Google's side; rerun `poll JOB_NAME` to resume.

Environment
-----------
  GEMINI_API_KEY must be set (https://aistudio.google.com/apikey)

Discipline list comes from harvester/classify.py — the LLM is constrained to
the same canonical labels the rule-based classifier uses, plus "Autre /
non classé" as an explicit "I really don't know" option.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")  # picks up GEMINI_API_KEY / GEMINI_MODEL if present
sys.path.insert(0, str(ROOT / "harvester"))
from classify import DISCIPLINE_RULES, OTHER  # noqa: E402

DB_PATH = ROOT / "data" / "theses.db"
JOBS_DIR = ROOT / "data" / "llm_jobs"

CANONICAL_DISCIPLINES = [d for d, _ in DISCIPLINE_RULES] + [OTHER]

SYSTEM_INSTRUCTION = (
    "Tu es un·e bibliothécaire universitaire québécois·e. On te donne les "
    "métadonnées d'une thèse ou d'un mémoire d'une université du Québec. "
    "Tu dois choisir la discipline canonique la plus appropriée parmi la "
    "liste fournie. Si les informations sont vraiment insuffisantes pour "
    "trancher (titre générique, pas de résumé, pas de mots-clés), réponds "
    f"« {OTHER} ». Réponds uniquement en JSON valide selon le schéma."
)

# Schema enforced server-side: response is guaranteed to be one of these labels.
RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "discipline": {"type": "STRING", "enum": CANONICAL_DISCIPLINES},
    },
    "required": ["discipline"],
}


# ---------------------------------------------------------------- helpers ----

def fetch_unclassified(conn: sqlite3.Connection, limit: int | None) -> list[dict]:
    """Return rows currently labeled OTHER. We need only fields used in the prompt."""
    sql = (
        "SELECT oai_identifier, title, COALESCE(authors, '') AS authors, "
        "       COALESCE(abstract, '') AS abstract, "
        "       COALESCE(subjects, '') AS subjects, "
        "       COALESCE(publisher, '') AS publisher, "
        "       COALESCE(source_name, '') AS source_name, "
        "       COALESCE(year, 0) AS year "
        "FROM theses WHERE discipline = ?"
    )
    if limit:
        sql += f" LIMIT {int(limit)}"
    rows = conn.execute(sql, (OTHER,)).fetchall()
    return [dict(r) for r in rows]


def build_prompt(row: dict) -> str:
    """Compact prompt with the signal-bearing fields, truncated."""
    return (
        f"Disciplines possibles : {', '.join(CANONICAL_DISCIPLINES)}\n\n"
        f"Titre : {row['title'][:300]}\n"
        f"Auteur·rice·s : {row['authors'][:200]}\n"
        f"Université : {row['source_name']}  ·  Année : {row['year'] or '—'}\n"
        f"Mots-clés (dc:subject) : {row['subjects'][:300] or '—'}\n"
        f"Éditeur / département (dc:publisher) : {row['publisher'][:200] or '—'}\n"
        f"Résumé : {row['abstract'][:800] or '—'}\n\n"
        "Choisis la discipline la plus pertinente."
    )


def build_jsonl(rows: list[dict], path: Path) -> None:
    """Write the JSONL the Gemini batch API consumes.

    Field names use the wire-protocol camelCase (`systemInstruction`,
    `generationConfig`, `responseSchema`...) — the SDK accepts snake_case
    in Python calls but the file format is raw JSON.
    """
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            req = {
                "key": row["oai_identifier"],
                "request": {
                    "contents": [
                        {"role": "user", "parts": [{"text": build_prompt(row)}]},
                    ],
                    "systemInstruction": {
                        "parts": [{"text": SYSTEM_INSTRUCTION}],
                    },
                    "generationConfig": {
                        "responseMimeType": "application/json",
                        "responseSchema": RESPONSE_SCHEMA,
                        "temperature": 0.0,
                        # Gemini 3 Flash uses thinking tokens by default. For
                        # structured single-label classification we don't
                        # need it — disabling avoids the thinking budget
                        # eating the response budget.
                        "thinkingConfig": {"thinkingBudget": 0},
                        "maxOutputTokens": 128,
                    },
                },
            }
            f.write(json.dumps(req, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------- batch ----

DEFAULT_MODEL = os.environ.get("GEMINI_MODEL") or "gemini-flash-latest"


def make_client() -> genai.Client:
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        sys.exit(
            "Erreur : GEMINI_API_KEY non définie.\n"
            "Crée une clé sur https://aistudio.google.com/apikey puis renseigne\n"
            "le fichier .env à la racine du projet, ou exporte la variable :\n"
            "  export GEMINI_API_KEY=...\n"
        )
    return genai.Client(api_key=api_key)


def submit(client: genai.Client, jsonl_path: Path, model: str,
           display_name: str = "thesis-discipline-classify") -> str:
    """Upload JSONL, create batch job. Return batch job name."""
    print(f"  uploading {jsonl_path.name} ({jsonl_path.stat().st_size:,} bytes)...", flush=True)
    uploaded = client.files.upload(
        file=str(jsonl_path),
        config=types.UploadFileConfig(
            display_name=display_name,
            mime_type="application/jsonl",
        ),
    )
    print(f"  uploaded as {uploaded.name}", flush=True)

    batch = client.batches.create(
        model=model,
        src=uploaded.name,
        config=types.CreateBatchJobConfig(display_name=display_name),
    )
    print(f"  batch job created: {batch.name}", flush=True)
    print(f"  state: {batch.state.name}", flush=True)
    return batch.name


def poll_until_done(client: genai.Client, job_name: str,
                    interval_s: int = 30) -> "types.BatchJob":
    """Poll a batch job; return the final BatchJob."""
    terminal = {"JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED",
                "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"}
    last_state = None
    while True:
        batch = client.batches.get(name=job_name)
        state = batch.state.name
        if state != last_state:
            print(f"  [{time.strftime('%H:%M:%S')}] state: {state}", flush=True)
            last_state = state
        if state in terminal:
            return batch
        time.sleep(interval_s)


def parse_results(client: genai.Client, batch) -> dict[str, str]:
    """Return {oai_identifier -> discipline}.

    Batch results live either in `batch.dest.inlined_responses` (small jobs)
    or in a Files API output file (`batch.dest.file_name`). We handle both.
    """
    out: dict[str, str] = {}
    dest = batch.dest

    inlined = getattr(dest, "inlined_responses", None) or []
    if inlined:
        print(f"  parsing {len(inlined)} inline responses...", flush=True)
        for item in inlined:
            key = getattr(item, "key", None)
            resp = getattr(item, "response", None)
            disc = _extract_discipline(resp)
            if key and disc:
                out[key] = disc

    file_name = getattr(dest, "file_name", None)
    if file_name:
        print(f"  downloading result file {file_name}...", flush=True)
        blob = client.files.download(file=file_name)
        text = blob.decode("utf-8") if isinstance(blob, (bytes, bytearray)) else str(blob)
        for line in text.splitlines():
            if not line.strip():
                continue
            obj = json.loads(line)
            key = obj.get("key")
            disc = _extract_discipline(obj.get("response"))
            if key and disc:
                out[key] = disc

    return out


def _extract_discipline(response_obj) -> str | None:
    """Pull the JSON discipline string from a single response, robustly."""
    if response_obj is None:
        return None
    # Could be a dict (from JSONL file) or an SDK object (from inlined).
    if hasattr(response_obj, "candidates"):
        candidates = response_obj.candidates or []
        for c in candidates:
            for part in (c.content.parts if c.content else []):
                txt = getattr(part, "text", None)
                if txt:
                    try:
                        return json.loads(txt).get("discipline")
                    except json.JSONDecodeError:
                        return None
        return None
    if isinstance(response_obj, dict):
        for c in response_obj.get("candidates", []):
            for part in c.get("content", {}).get("parts", []):
                if "text" in part:
                    try:
                        return json.loads(part["text"]).get("discipline")
                    except json.JSONDecodeError:
                        return None
    return None


def apply_to_db(updates: dict[str, str], db_path: Path) -> int:
    """Update the discipline column. Returns rows changed."""
    if not updates:
        return 0
    conn = sqlite3.connect(db_path)
    try:
        n = 0
        for oai, disc in updates.items():
            if disc not in CANONICAL_DISCIPLINES:
                continue  # paranoia: schema enforces this, but trust nothing
            cur = conn.execute(
                "UPDATE theses SET discipline = ?, discipline_source = 'llm' "
                "WHERE oai_identifier = ?",
                (disc, oai),
            )
            n += cur.rowcount
        conn.commit()
    finally:
        conn.close()
    return n


def save_job_meta(job_name: str, jsonl_path: Path, n_rows: int) -> Path:
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    safe = job_name.replace("/", "_")
    meta = JOBS_DIR / f"{safe}.json"
    meta.write_text(json.dumps({
        "job_name": job_name,
        "jsonl": str(jsonl_path),
        "n_rows": n_rows,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }, indent=2))
    return meta


# ---------------------------------------------------------------- CLI ----

def cmd_preview(args) -> int:
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    rows = fetch_unclassified(conn, args.limit)
    print(f"{len(rows)} rows would be sent.\n")
    for row in rows[:3]:
        print("--- prompt preview ---")
        print(build_prompt(row))
        print()
    if rows:
        out = ROOT / "data" / "llm_preview.jsonl"
        out.parent.mkdir(parents=True, exist_ok=True)
        build_jsonl(rows, out)
        print(f"Full JSONL written to {out} ({out.stat().st_size:,} bytes)")
    return 0


def cmd_submit(args) -> int:
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    rows = fetch_unclassified(conn, args.limit)
    if not rows:
        print("No unclassified rows. Nothing to do.")
        return 0
    print(f"Found {len(rows)} unclassified rows.")
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    jsonl = JOBS_DIR / f"input_{time.strftime('%Y%m%dT%H%M%S')}.jsonl"
    build_jsonl(rows, jsonl)
    print(f"Wrote {jsonl} ({jsonl.stat().st_size:,} bytes)")

    client = make_client()
    job_name = submit(client, jsonl, args.model)
    save_job_meta(job_name, jsonl, len(rows))
    print(f"\nJob submitted. Resume with:\n  {sys.argv[0]} poll {job_name}")
    return 0


def cmd_poll(args) -> int:
    client = make_client()
    batch = poll_until_done(client, args.job_name, interval_s=args.interval)
    print(f"Final state: {batch.state.name}")
    if batch.state.name != "JOB_STATE_SUCCEEDED":
        print(f"  error: {getattr(batch, 'error', None)}")
        return 1
    updates = parse_results(client, batch)
    print(f"  parsed {len(updates)} discipline assignments")
    n = apply_to_db(updates, Path(args.db))
    print(f"  updated {n} DB rows")

    # quick stats
    conn = sqlite3.connect(args.db)
    counts = {d: c for d, c in conn.execute(
        "SELECT discipline, COUNT(*) FROM theses GROUP BY discipline ORDER BY 2 DESC"
    )}
    other_count = counts.get(OTHER, 0)
    total = sum(counts.values())
    print(f"  remaining unclassified: {other_count}/{total} "
          f"({100 * other_count / total:.1f}%)")
    return 0


def cmd_run(args) -> int:
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    rows = fetch_unclassified(conn, args.limit)
    if not rows:
        print("No unclassified rows. Nothing to do.")
        return 0
    print(f"Found {len(rows)} unclassified rows.")

    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    jsonl = JOBS_DIR / f"input_{time.strftime('%Y%m%dT%H%M%S')}.jsonl"
    build_jsonl(rows, jsonl)

    client = make_client()
    job_name = submit(client, jsonl, args.model)
    save_job_meta(job_name, jsonl, len(rows))
    print(f"\nPolling every {args.interval}s. Ctrl-C is safe — resume with:")
    print(f"  {sys.argv[0]} poll {job_name}\n")

    batch = poll_until_done(client, job_name, interval_s=args.interval)
    if batch.state.name != "JOB_STATE_SUCCEEDED":
        print(f"Job ended with state {batch.state.name}: {getattr(batch, 'error', None)}")
        return 1
    updates = parse_results(client, batch)
    print(f"Parsed {len(updates)} assignments")
    n = apply_to_db(updates, Path(args.db))
    print(f"Updated {n} rows in {args.db}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=str(DB_PATH))
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("preview", help="Show the JSONL that would be sent (no API call).")
    sp.add_argument("--limit", type=int, default=None)
    sp.set_defaults(fn=cmd_preview)

    sp = sub.add_parser("submit", help="Submit a batch job and return.")
    sp.add_argument("--limit", type=int, default=None)
    sp.add_argument("--model", default=DEFAULT_MODEL)
    sp.set_defaults(fn=cmd_submit)

    sp = sub.add_parser("poll", help="Wait for a batch job and apply its results.")
    sp.add_argument("job_name", help="Batch job name returned by submit/run.")
    sp.add_argument("--interval", type=int, default=30)
    sp.set_defaults(fn=cmd_poll)

    sp = sub.add_parser("run", help="Submit, poll, and apply in one shot.")
    sp.add_argument("--limit", type=int, default=None)
    sp.add_argument("--model", default=DEFAULT_MODEL)
    sp.add_argument("--interval", type=int, default=30)
    sp.set_defaults(fn=cmd_run)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
