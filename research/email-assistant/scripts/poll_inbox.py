#!/usr/bin/env python3
"""poll_inbox.py — watch the 163 IMAP inbox for new mail and hand each new
message to the DSH headless agent (email-assistant prompt), which processes
it as a request and replies by email.

Invoked every minute by cron via run_job (see ~/.local/cron/run-0100.sh).
Exits in ~1-2s when there is nothing new.

Concurrency:
  - Up to EMAIL_CONCURRENCY (default 4) mails are processed in parallel,
    one `dsh --profile ${DSH_PROFILE}` (default `email`) per worker thread.
  - state.json is guarded by a lock (atomic read-modify-write + rename); the
    shared IMAP connection is used only for the initial fetch/search and a
    short serialized STORE per processed mail.

Long-running tasks:
  - Each `dsh --profile ${DSH_PROFILE}` run has a hard timeout (DSH_TIMEOUT, default
    2 h) as the only safety net. DSH headless is stateless per run (no session
    file), so there is no stall/loop/bloat watchdog. On timeout the process
    group is killed and the mail is requeued (pending) for retry.
  - The subprocess pid is recorded in state.json so the per-minute stale
    check can tell a still-running long task from a crashed one.

State:    ~/.local/cron/inbox/state.json   (keyed by Message-ID)
Archive:  ~/agent-data/email-assistant/archive/YYYY-MM/<date>-<mid8>-<subject>/
          (runtime records live outside the skills repo and outside the
          Nutstore sync folder; override with MAIL_ARCHIVE_ROOT)
          each processed email gets its own directory containing
          original.eml + attachments/ + meta.json (poller writes these);
          the agent adds reply.html + result.txt

Skip rules:
  - Messages carrying `X-Source: pi-*` or `X-Source: dsh-email-assistant` are
    our own outgoing mail — never reprocess them.
  - A Message-ID already done/failed/in_progress is not reprocessed.
  - A message is retried at most MAX_RETRIES times on failure.

Sessions & threads:
  - Each mail thread maps to one pi session file under SESSIONS_DIR
    (~/.local/cron/inbox/sessions/), NAMED AFTER THE THREAD SUBJECT
    ("Re:"/"Fwd:" stripped, slugified): mail-<thread-subject>.jsonl.
    Processing runs `pi -p --session <file>`.
  - In-Reply-To routing (resolve_session):
      * parent (the replied-to mail) was processed and its leaf is still the
        session's current leaf  -> linear continuation;
      * parent was processed but is an EARLIER mail  -> branch_session.mjs
        first moves the leaf back to the parent's entry and appends a
        `mail-branch` marker; the run then continues on a new branch, so the
        reply lands on the TREE NODE of the email it answers;
      * no usable In-Reply-To but the subject matches an existing thread  ->
        routed into that thread's session (subject-based unified routing);
      * otherwise                                  -> fresh session file.
  - After each run we record the session's new leaf in state, keyed by both
    the incoming Message-ID and (if the agent recorded reply_message_id in
    meta.json) the outgoing reply's Message-ID — so a reply to OUR reply
    also lands in the same thread session.

Owner directive lines (`pi:`):
  - Only mail from OWNER_ADDRESSES may carry lines like
    `pi: model=Huawei/glm-52 level=high skill=nature-digest`.
  - model= must exist in ~/.pi/agent/models.json (whitelist); level= must be
    a valid --thinking level. Applied directives become CLI flags; rejected
    ones are reported to the agent so it can state the actual model used.
  - `pi:` lines are stripped from the body preview in all cases, so third
    parties cannot influence the pi invocation.
"""
import email
import email.policy
import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from email.header import decode_header, make_header
from email.utils import parseaddr

sys.path.insert(0, os.path.expanduser("~/.agents/skills/email/scripts"))
from msmtp_lib import get_imap  # noqa: E402

ACCOUNT = os.environ.get("INBOX_ACCOUNT", "163")
BASE = os.path.expanduser(os.environ.get("INBOX_STATE_DIR", "~/.local/cron/inbox"))
STATE_FILE = os.path.join(BASE, "state.json")
ARCHIVE_ROOT = os.path.expanduser(
    # Runtime records live outside the skills repo and outside the Nutstore
    # sync folder (they were 2.6G and growing). Override with MAIL_ARCHIVE_ROOT.
    os.environ.get("MAIL_ARCHIVE_ROOT", "~/agent-data/email-assistant/archive")
)
DSH_BIN = os.environ.get(
    "DSH_BIN",
    "/Users/zliang/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh")
DSH_HOME = os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh"))
# The dsh profile this poller boots. It is a dedicated clone of `headless`
# whose own settings document (~/.dsh/email-assistant-settings.yaml) pins
# email-assistant to deepseek-v4.1-flash. The shared `headless` profile keeps
# reading ~/.dsh/settings.yaml, so x-digest / nature-digest stay on glm-52.
DSH_PROFILE = os.environ.get("DSH_PROFILE", "email")
EMAIL_ASSISTANT_PROMPT = os.path.expanduser(
    "~/.local/cron/prompts/email-assistant.md")
STALE_SECONDS = 60 * 60      # in_progress older than this is stale (crashed run)
MAX_RETRIES = 3
PREVIEW_CHARS = 12000
CONCURRENCY = max(1, int(os.environ.get("EMAIL_CONCURRENCY", "4")))
# DSH headless runs with a generous hard timeout as a safety net (no
# session-file-based stall detection — DSH headless is stateless per run).
DSH_TIMEOUT = int(os.environ.get("DSH_TIMEOUT", 2 * 60 * 60))  # 2 hours
OWNER_ADDRESSES = {"zleung9@163.com", "zleung9@outlook.com"}
SESSIONS_DIR = os.path.join(BASE, "sessions")
MODELS_JSON = os.path.expanduser("~/.pi/agent/models.json")
BRANCH_HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "branch_session.mjs")
NODE_BIN = os.environ.get("NODE_BIN", "/opt/homebrew/bin/node")
VALID_THINKING = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
PI_LINE_RE = re.compile(r"^[ \t]*pi:[ \t]*(.+?)[ \t]*$", re.M)


def ts():
    return datetime.now().strftime("%F %T")


def log(m):
    print(f"[{ts()}] {m}", flush=True)


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_state_unlocked(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE_FILE)


STATE_LOCK = threading.Lock()


def save_state(state):
    with STATE_LOCK:
        _save_state_unlocked(state)


def update_state(state, mutator):
    """Thread-safe read-modify-write of state + save. mutator(state) may return a value."""
    with STATE_LOCK:
        out = mutator(state)
        _save_state_unlocked(state)
        return out


def decode_h(raw):
    if not raw:
        return ""
    try:
        return str(make_header(decode_header(raw)))
    except Exception:
        return str(raw)


def strip_html(h):
    h = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", h)
    h = re.sub(r"(?is)<br\s*/?>", "\n", h)
    h = re.sub(r"(?is)</p>|</div>|</li>", "\n", h)
    h = re.sub(r"(?s)<[^>]+>", " ", h)
    h = h.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    return re.sub(r"[ \t]+", " ", h)


def text_of(msg):
    """Readable text of a message: text/plain preferred, html stripped as fallback."""
    plain, html = [], []
    parts = list(msg.walk()) if msg.is_multipart() else [msg]
    for part in parts:
        cd = str(part.get("Content-Disposition") or "")
        if cd.startswith("attachment"):
            continue
        ct = part.get_content_type()
        try:
            if ct == "text/plain":
                plain.append(str(part.get_content()))
            elif ct == "text/html":
                html.append(str(part.get_content()))
        except Exception:
            pass
    if plain:
        return "\n".join(plain)
    if html:
        return strip_html("\n".join(html))
    return ""


def save_attachments(msg, att_dir):
    names = []
    if not msg.is_multipart():
        return names
    for i, part in enumerate(msg.walk()):
        cd = str(part.get("Content-Disposition") or "")
        is_att = cd.startswith("attachment") or (cd.startswith("inline") and part.get_filename())
        if not is_att:
            continue
        fn = decode_h(part.get_filename() or f"attach_{i}")
        fn = os.path.basename(fn) or f"attach_{i}"
        try:
            payload = part.get_payload(decode=True)
            with open(os.path.join(att_dir, fn), "wb") as f:
                f.write(payload or b"")
            names.append(fn)
        except Exception as e:
            log(f"attachment {fn!r} failed: {e}")
    return names


def slugify(subject, maxlen=40):
    s = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", subject or "").strip("-")
    return s[:maxlen] or "email"


def load_model_whitelist():
    """Set of (provider, model_id) pairs registered in models.json."""
    try:
        with open(MODELS_JSON) as f:
            data = json.load(f)
        pairs = set()
        for prov, cfg in (data.get("providers") or {}).items():
            for m in (cfg.get("models") or []):
                if m.get("id"):
                    pairs.add((prov, m["id"]))
        return pairs
    except Exception:
        return set()


def parse_pi_instructions(body, sender):
    """Parse owner-only `pi:` directive lines from the mail body.

    Returns (flags, notes, clean_body): flags is always [] in DSH mode (the
    headless run uses the configured default model); notes are passed to the
    agent prompt; clean_body has all `pi:` lines removed (so third parties
    cannot inject directives).
    """
    flags, notes = [], []
    is_owner = sender in OWNER_ADDRESSES
    for line in PI_LINE_RE.findall(body or ""):
        if not is_owner:
            continue
        for tok in line.split():
            k, _, v = tok.partition("=")
            k, v = k.lower(), v.strip()
            if not v:
                continue
            if k == "model":
                notes.append(
                    f"pi-directive: model={v} (noted but NOT applied in DSH "
                    f"mode — this run uses the configured default model of "
                    f"the `{DSH_PROFILE}` profile. State this clearly at the "
                    f"top of your reply.)")
            elif k == "level":
                notes.append(
                    f"pi-directive: level={v} (noted but NOT applied in DSH "
                    f"mode — this run uses the default thinking level.)")
            elif k == "skill":
                notes.append(f"pi-directive: skill={v} — the owner wants you to use skill '{v}' if it is available")
    return flags, notes, PI_LINE_RE.sub("", body or "")


def current_leaf(session_file):
    """Id of the last session entry in a pi session JSONL file — the leaf pi
    continues from when opening the file — or None."""
    try:
        with open(session_file, "rb") as f:
            data = f.read()
    except FileNotFoundError:
        return None
    for line in reversed(data.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            return None
        if entry.get("type") == "session":
            continue
        return entry.get("id")
    return None


def new_session_file(subj, mid):
    """Session file for a NEW thread, named after the thread subject.
    Collisions with a foreign existing file get an 8-char Message-ID suffix."""
    base = "mail-" + slugify(subj, 60)
    sf = os.path.join(SESSIONS_DIR, base + ".jsonl")
    if os.path.exists(sf):
        safe = re.sub(r"[^A-Za-z0-9_-]", "", mid.strip("<>"))[-8:] or "mail"
        sf = os.path.join(SESSIONS_DIR, f"{base}-{safe}.jsonl")
        n = 2
        while os.path.exists(sf):
            sf = os.path.join(SESSIONS_DIR, f"{base}-{safe}-{n}.jsonl")
            n += 1
    return sf


def thread_subject(msg):
    """Thread display subject: the mail subject with ALL leading Re:/Fwd: stripped."""
    s = decode_h(msg.get("Subject") or "")
    while True:
        s2 = re.sub(r"^(re|fwd|fw)[\s:：]+", "", s.strip(), flags=re.I).strip()
        if s2 == s:
            break
        s = s2
    return s or "email"


def resolve_session(mid, msg, state):
    """Decide which pi session processes this mail.

    Returns (session_file, branch_entry_id_or_None, note_or_None).
    """
    irtto = (msg.get("In-Reply-To") or "").strip()
    parent = state.get(irtto)
    if irtto and parent and parent.get("session_file") and parent.get("leaf_id"):
        sf = parent["session_file"]
        if os.path.exists(sf):
            if parent["leaf_id"] == current_leaf(sf):
                return sf, None, None  # linear continuation
            return sf, parent["leaf_id"], (
                "thread-note: this reply targets an EARLIER email of the thread "
                f"({irtto}); your session context ends at that email — a branch "
                "was cut from it. You may mention the thread is browsable via "
                "/tree in the pi TUI.")
    # subject-based unified routing: a mail whose (Re:-stripped) subject
    # matches an existing thread joins that thread's session
    subj = thread_subject(msg)
    for st in state.values():
        if (st.get("thread_subject") == subj and st.get("session_file")
                and os.path.exists(st["session_file"])):
            return st["session_file"], None, (
                "thread-note: routed into an existing thread by subject; "
                "continue that thread's session")
    sf = new_session_file(subj, mid)
    note = None
    if irtto:
        note = ("thread-note: the email this reply targets was not processed by "
                "this assistant; starting a fresh session for the thread")
    return sf, None, note


def dsh_run_alive(pid):
    """True if a DSH headless process with the given pid is still running.
    Replaces pi_process_alive (DSH headless has no session file, so we track
    the subprocess pid in state instead)."""
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False
    except Exception:
        return False


def run_dsh(prompt, state, mid):
    """Run `dsh --profile <DSH_PROFILE>` with the email-assistant prompt
    template prepended to the per-mail metadata. A hard timeout is the only
    safety net (DSH headless is stateless per run — no session-file
    stall/loop detection).

    Returns (ok, kill_reason_or_None).
    """
    try:
        with open(EMAIL_ASSISTANT_PROMPT, "r") as f:
            template = f.read()
    except OSError as e:
        log(f"cannot read prompt template {EMAIL_ASSISTANT_PROMPT}: {e}")
        return False, "prompt template missing"

    full_prompt = template + "\n\n--- invocation metadata ---\n" + prompt
    env = dict(os.environ)
    env["DSH_HOME"] = DSH_HOME
    p = subprocess.Popen(
        [DSH_BIN, "--profile", DSH_PROFILE, full_prompt],
        env=env, start_new_session=True)  # inherit stdout/stderr -> per-day cron log
    # record pid so the stale-recovery loop in the next cron tick can see the
    # run is still alive (DSH headless has no session file to stat)
    try:
        update_state(state, lambda s: s[mid].__setitem__("pid", p.pid))
    except Exception:
        pass
    try:
        p.wait(timeout=DSH_TIMEOUT)
        return p.returncode == 0, None
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, 9)
        except (ProcessLookupError, PermissionError):
            p.kill()
        p.wait()
        log(f"WATCHDOG killed dsh run (timeout {DSH_TIMEOUT // 60} min) for {mid}")
        return False, f"timeout (>{DSH_TIMEOUT // 60} min)"
    finally:
        if p.poll() is None:
            try:
                os.killpg(p.pid, 9)
            except (ProcessLookupError, PermissionError):
                p.kill()
            p.wait()
        try:
            update_state(state, lambda s: s[mid].pop("pid", None))
        except Exception:
            pass


def main():
    os.makedirs(BASE, exist_ok=True)
    state = load_state()
    now = time.time()

    # recover stale in_progress entries (crashed/interrupted runs).
    # A long-running mail is NOT stale while its dsh process is still alive.
    for mid, v in list(state.items()):
        if v.get("status") == "in_progress" and now - v.get("ts", 0) > STALE_SECONDS:
            if v.get("pid") and dsh_run_alive(v["pid"]):
                v["ts"] = now  # still running; refresh, don't requeue
                log(f"{mid}: in_progress > {STALE_SECONDS // 60} min but dsh still alive — kept")
                continue
            v["status"] = "failed" if v.get("tries", 0) >= MAX_RETRIES else "pending"
            log(f"recovered stale entry {mid} -> {v['status']}")
    save_state(state)

    conn, _user = get_imap(ACCOUNT)
    conn.select("INBOX")
    _t, data = conn.search(None, "UNSEEN")
    uids = data[0].split()

    todo = []
    for uid_b in uids:
        uid = uid_b.decode()
        _t, msgdata = conn.fetch(uid, "(RFC822)")
        raw = msgdata[0][1]
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        mid = (msg.get("Message-ID") or f"uid:{ACCOUNT}:{uid}").strip()
        xsrc = str(msg.get("X-Source") or "").lower()
        if xsrc.startswith("pi-") or xsrc.startswith("dsh-"):
            continue  # our own outgoing mail delivered to ourselves
        st = state.get(mid)
        if st and st.get("status") in ("done", "failed", "in_progress"):
            continue
        todo.append((uid, raw, msg, mid, None))

    # retries: previously failed attempts keep their raw copy in the archive
    seen_mid = {t[3] for t in todo}
    for mid, st in list(state.items()):
        if st.get("status") != "pending" or mid in seen_mid:
            continue
        arch = st.get("archive") or ""
        p = os.path.join(arch, "original.eml") if arch else ""
        if not p or not os.path.exists(p):
            state[mid]["status"] = "failed"
            log(f"retry {mid}: archive missing, marking failed")
            continue
        with open(p, "rb") as f:
            raw = f.read()
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        todo.append((st.get("uid", "?"), raw, msg, mid, arch))
        log(f"retrying message-id={mid} (try {st.get('tries', 0) + 1})")
    save_state(state)

    if not todo:
        log(f"no new mail ({len(uids)} unseen in {ACCOUNT} INBOX)")
        try:
            conn.logout()
        except Exception:
            pass
        return 0

    log(f"processing {len(todo)} mail(s), concurrency={CONCURRENCY}")
    imap_lock = threading.Lock()
    try:
        with ThreadPoolExecutor(max_workers=min(CONCURRENCY, len(todo))) as ex:
            futs = [ex.submit(process_mail, it, state, conn, imap_lock) for it in todo]
            results = [f.result() for f in futs]
        return 0 if all(results) else 1
    finally:
        try:
            conn.logout()
        except Exception:
            pass


_SESSION_LOCKS = {}
_SESSION_LOCKS_GUARD = threading.Lock()


def _session_lock(key):
    """Per-thread lock: two `pi --session` processes must never write the same
    session JSONL concurrently (would corrupt the thread). Mails of the same
    thread serialize; different threads run in parallel."""
    with _SESSION_LOCKS_GUARD:
        return _SESSION_LOCKS.setdefault(key, threading.Lock())


def process_mail(item, state, conn, imap_lock):
    """Worker: process one mail (archive, pi -p run, state/meta updates).
    Returns True on success."""
    uid, raw, msg, mid = item[0], item[1], item[2], item[3]
    arch_reuse = item[4]
    sender = parseaddr(msg.get("From", ""))[1]
    reply_to = parseaddr(msg.get("Reply-To", ""))[1] or sender
    subject = decode_h(msg.get("Subject"))
    datestr = str(msg.get("Date") or "")
    body = text_of(msg)[:PREVIEW_CHARS]

    stamp = datetime.now()
    tries = state.get(mid, {}).get("tries", 0) + 1
    pi_flags, pi_notes, body = parse_pi_instructions(body, sender)
    thread_subj = thread_subject(msg)
    session_file, branch_at, thread_note = resolve_session(mid, msg, state)
    with _session_lock(os.path.basename(session_file)):
        if branch_at:
            os.makedirs(SESSIONS_DIR, exist_ok=True)
            irtto = (msg.get("In-Reply-To") or "").strip()
            try:
                br = subprocess.run(
                    [NODE_BIN, BRANCH_HELPER, session_file, branch_at, irtto],
                    capture_output=True, text=True, timeout=60)
                if br.returncode == 0:
                    log(f"branched {os.path.basename(session_file)} at {branch_at} (reply to {irtto})")
                else:
                    log(f"branch helper failed rc={br.returncode}: {br.stderr.strip()} — continuing at current leaf")
                    thread_note = "(branch failed; session context = everything so far)"
            except Exception as e:
                log(f"branch helper error: {e} — continuing at current leaf")
                thread_note = "(branch failed; session context = everything so far)"
        if arch_reuse and os.path.isdir(arch_reuse):
            arch = arch_reuse
            att_dir = os.path.join(arch, "attachments")
            atts = sorted(os.listdir(att_dir)) if os.path.isdir(att_dir) else []
            meta = {"message_id": mid, "tries": tries, "status": "in_progress",
                    "retried_at": stamp.isoformat(timespec="seconds")}
            try:
                with open(os.path.join(arch, "meta.json")) as f:
                    meta.update(json.load(f))
                meta.update({"tries": tries, "status": "in_progress"})
            except Exception:
                pass
            with open(os.path.join(arch, "meta.json"), "w") as f:
                json.dump(meta, f, ensure_ascii=False, indent=1)
        else:
            local_id = mid.strip("<>").split("@")[0]
            mid8 = (local_id[-8:] or "nomid").replace(":", "")
            month_dir = os.path.join(ARCHIVE_ROOT, stamp.strftime("%Y-%m"))
            name = f"{stamp:%Y-%m-%d-%H%M}-{mid8}-{slugify(subject)}"
            arch = os.path.join(month_dir, name)
            n = 2
            while os.path.exists(arch):
                arch = os.path.join(month_dir, f"{name}-{n}")
                n += 1
            att_dir = os.path.join(arch, "attachments")
            os.makedirs(att_dir, exist_ok=True)
            with open(os.path.join(arch, "original.eml"), "wb") as f:
                f.write(raw)
            atts = save_attachments(msg, att_dir)
            meta = {
                "message_id": mid, "uid": uid, "from": sender,
                "to": str(msg.get("To") or ""), "subject": subject,
                "date": datestr, "archived_at": stamp.isoformat(timespec="seconds"),
                "tries": tries, "status": "in_progress",
            }
            with open(os.path.join(arch, "meta.json"), "w") as f:
                json.dump(meta, f, ensure_ascii=False, indent=1)
        # mark read now: processing has started; retries are state-driven
        # (IMAP connection is shared — serialize the short STORE)
        try:
            with imap_lock:
                conn.uid("STORE", uid, "+FLAGS", "\\Seen")
        except Exception as e:
            log(f"warn: could not mark read uid={uid}: {e}")

        update_state(state, lambda s: s.__setitem__(mid, {
            "status": "in_progress", "ts": time.time(), "uid": uid,
            "from": sender, "subject": subject, "tries": tries,
            "archive": arch, "thread_subject": thread_subj,
        }))

        notes = list(pi_notes)
        if thread_note:
            notes.append(thread_note)
        prompt = (
            f"/skill:email-assistant account={ACCOUNT} uid={uid} "
            f"message-id={mid} sender={sender} reply-to={reply_to} "
            f"date={datestr} subject={subject} archive={arch} "
            f"attachments={','.join(atts) if atts else 'none'}\n"
            + ("\n".join(notes) + "\n" if notes else "\n")
            + f"\n--- body preview (truncated at {PREVIEW_CHARS} chars) ---\n"
            f"{body}\n--- end preview ---"
        )
        log(f"processing message-id={mid} from={sender} subject={subject!r} (try {tries}, session={os.path.basename(session_file)})")
        try:
            ok, kill_reason = run_dsh(prompt, state, mid)
        except FileNotFoundError:
            log(f"DSH_BIN not found: {DSH_BIN}")
            ok, kill_reason = False, "DSH_BIN missing"

        leaf = current_leaf(session_file)

        def finalize(s):
            s[mid].update({"session_file": session_file, "leaf_id": leaf,
                           "thread_key": os.path.basename(session_file)})
            # register our outgoing reply's Message-ID (recorded by the agent in
            # meta.json) so replies to OUR reply route into the same thread
            try:
                with open(os.path.join(arch, "meta.json")) as f:
                    m2 = json.load(f)
                rm = (m2.get("reply_message_id") or "").strip()
                if rm:
                    s[rm] = {"status": "outgoing", "ts": time.time(),
                             "replied_to": mid, "session_file": session_file,
                             "leaf_id": leaf, "subject": subject}
            except Exception:
                pass
            s[mid]["status"] = "done" if ok else ("pending" if tries < MAX_RETRIES else "failed")
            return s[mid]["status"]

        final_status = update_state(state, finalize)
        try:
            meta["status"] = "done" if ok else "failed"
            meta["finished_at"] = datetime.now().isoformat(timespec="seconds")
            with open(os.path.join(arch, "meta.json"), "w") as f:
                json.dump(meta, f, ensure_ascii=False, indent=1)
        except OSError:
            pass
        log(f"finished message-id={mid} ok={ok} (status={final_status}" + (
            f", watchdog={kill_reason})" if kill_reason else ")"))
        return ok


if __name__ == "__main__":
    sys.exit(main())
