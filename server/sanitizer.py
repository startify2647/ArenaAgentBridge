"""Sanitiser for answers coming back from the web UI.

The text produced by the site is **untrusted input**: it may contain destructive
shell commands (either because you asked a coding agent to do something and it
volunteered a `rm -rf`, or because a prompt-injection attack is trying to use
your framework's shell tool).  The bridge never executes anything, but a
careless agent loop will happily pipe the answer into a shell, so by default
(``AAB_SANITIZE_MODE=redact``) obviously destructive commands are replaced with a
placeholder before the answer is handed to Hermes/OpenClaw.

Severities:
``block``  destructive / credential-exfiltrating / reverse-shell material.
``warn``   risky but often legitimate (force push, hard reset, ...); reported in
           ``meta.sanitize_findings`` but left untouched.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

MAX_FINDINGS = 32


@dataclass
class Finding:
    pattern: str
    kind: str
    severity: str  # "block" | "warn"
    match: str
    line: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class SanitizeReport:
    mode: str = "redact"
    findings: List[Finding] = field(default_factory=list)
    replacements: int = 0

    @property
    def blocked(self) -> List[Finding]:
        return [f for f in self.findings if f.severity == "block"]

    @property
    def warnings(self) -> List[Finding]:
        return [f for f in self.findings if f.severity == "warn"]

    @property
    def changed(self) -> bool:
        return self.replacements > 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "mode": self.mode,
            "replacements": self.replacements,
            "findings": [f.as_dict() for f in self.findings[:MAX_FINDINGS]],
            "truncated_findings": max(0, len(self.findings) - MAX_FINDINGS),
        }


# ---------------------------------------------------------------------------
# Built-in rule set
# ---------------------------------------------------------------------------
# Each entry: (rule name, kind, severity, regex)
BUILTIN_RULES: Sequence[tuple] = (
    # --- filesystem destruction -------------------------------------------
    (
        "rm_rf_root",
        "destructive-fs",
        "block",
        r"\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*|--recursive\s+--force|--force\s+--recursive)\s+(?:/|/\*|~/?\*?|\\|\$HOME|\$\{?HOME\}?|/etc|/usr|/var|/boot|/home)(?:[\s;|&'\"`)\]},:]|$)",
    ),
    ("mkfs", "destructive-fs", "block", r"\bmkfs(?:\.\w+)?\b"),
    ("dd_to_device", "destructive-fs", "block", r"\bdd\b[^\n]{0,80}\bof=/dev/(?:sd|nvme|hd|vd|disk)"),
    ("shred_device", "destructive-fs", "block", r"\bshred\b[^\n]{0,80}/dev/(?:sd|nvme|hd|vd)"),
    ("fork_bomb", "destructive-fs", "block", r":\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:"),
    ("chmod_root", "destructive-fs", "block", r"\bchmod\s+(?:-R\s+)?(?:777|a\+rwx)\s+/(?:\s|$)"),
    ("chown_root", "destructive-fs", "block", r"\bchown\s+-R\s+[^\n]{0,40}\s+/(?:\s|$)"),
    (
        "wipe_windows",
        "destructive-fs",
        "block",
        r"\b(?:format\s+[a-zA-Z]:|del\s+/[fq]\s+/[sq]\s+/[fq]\s+[a-zA-Z]:\\|rd\s+/s\s+/q\s+[a-zA-Z]:\\|vssadmin\s+delete\s+shadows|bcdedit\s+/set\s+\{default\}\s+recoveryenabled\s+no)",
    ),
    # --- pipe remote code into a shell ------------------------------------
    (
        "curl_pipe_shell",
        "remote-code-execution",
        "block",
        r"\b(?:curl|wget|fetch)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b",
    ),
    (
        "download_and_exec",
        "remote-code-execution",
        "block",
        r"\b(?:curl|wget)\b[^\n]{0,200}(?:-o\s*/tmp/|>\s*/tmp/)[^\n]{0,80}(?:&&|;)\s*(?:chmod\s+\+x\s+)?[^\n]{0,40}(?:ba|z)?sh\b",
    ),
    (
        "powershell_iex",
        "remote-code-execution",
        "block",
        r"\b(?:Invoke-Expression|iex)\b[^\n]{0,120}(?:DownloadString|Invoke-WebRequest|iwr|Net\.WebClient)",
    ),
    (
        "powershell_encoded",
        "remote-code-execution",
        "block",
        r"(?:powershell|pwsh)[^\n]{0,60}-(?:enc|encodedcommand)\b",
    ),
    (
        "base64_pipe_shell",
        "remote-code-execution",
        "block",
        r"\b(?:base64\s+(?:-d|--decode)|certutil\s+-decode)\b[^\n|]{0,160}\|\s*(?:ba|z)?sh\b",
    ),
    (
        "eval_remote",
        "remote-code-execution",
        "block",
        r"\beval\s+[\"']?\$\(\s*(?:curl|wget)",
    ),
    # --- reverse shells / raw sockets -------------------------------------
    (
        "reverse_shell",
        "reverse-shell",
        "block",
        r"(?:\bnc\s+(?:-e|--exec)\s+\S*\s*(?:/bin/)?(?:ba)?sh|\bncat\b[^\n]{0,40}-e\b|/dev/tcp/\d|bash\s+-i\s*>&|python[0-9.]*\s+-c\s+['\"][^'\"]{0,80}socket\.socket)",
    ),
    ("socat_shell", "reverse-shell", "block", r"\bsocat\s+[^\n]{0,80}exec:(?:/bin/)?(?:ba)?sh"),
    # --- credential access -------------------------------------------------
    (
        "ssh_key_read",
        "credential-access",
        "block",
        r"(?:cat|type|less|more|head|tail|cp|curl\s+[^\n]{0,20}-(?:F|-form)\s+@)\s+[^\n]{0,40}(?:\.ssh/id_(?:rsa|ed25519|ecdsa)|\.ssh/authorized_keys)",
    ),
    (
        "cloud_credentials",
        "credential-access",
        "block",
        r"(?:cat|type|less|more|head|tail|cp)\s+[^\n]{0,60}(?:\.aws/credentials|\.config/gcloud/|\.kube/config|\.docker/config\.json|\.netrc|\.npmrc|\.pypirc|\.git-credentials)",
    ),
    (
        "shadow_file",
        "credential-access",
        "block",
        r"\b(?:cat|less|more|head|tail|cp|mimikatz)\s+[^\n]{0,40}(?:/etc/shadow|/etc/gshadow|SAM\b|/etc/sudoers)",
    ),
    (
        "env_exfiltration",
        "credential-access",
        "block",
        r"\b(?:env|printenv|set)\b[^\n]{0,20}\|\s*(?:curl|wget|nc|ncat|mail|base64\s+-w0\s*\|\s*curl)[^\n]*",
    ),
    (
        "browser_profile_steal",
        "credential-access",
        "block",
        r"(?:Login Data|Cookies|cookies\.sqlite|key[34]\.db|logins\.json)[^\n]{0,60}(?:cp|copy|curl|wget|cat|zip)",
    ),
    (
        "history_upload",
        "credential-access",
        "block",
        r"(?:bash_history|zsh_history|history)\b[^\n]{0,40}\|\s*(?:curl|wget|nc|ncat|mail)",
    ),
    (
        "ssh_backdoor",
        "persistence",
        "block",
        r"(?:>>?\s*~?/?\.ssh/authorized_keys|echo\s+['\"]?ssh-(?:rsa|ed25519)[^\n]{0,200}>>\s*\S*authorized_keys)",
    ),
    ("cron_backdoor", "persistence", "block", r"(?:crontab\s+-|\|\s*crontab\b)|\becho[^\n]{0,120}>>\s*/etc/cron"),
    ("shell_profile_backdoor", "persistence", "block", r">>?\s*~?/?\.(?:bashrc|zshrc|profile|bash_profile)\b"),
    # --- git / infra (usually legitimate, reported only) -------------------
    ("git_force_push", "risky-git", "warn", r"\bgit\s+push\b[^\n]{0,60}(?:--force(?![-\w])|-f\b)"),
    ("git_hard_reset", "risky-git", "warn", r"\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f[a-z]*d)"),
    ("git_remote_rewrite", "risky-git", "warn", r"\bgit\s+push\b[^\n]{0,60}\+[^\s\n]"),
    ("docker_privileged", "risky-infra", "warn", r"\bdocker\s+run\b[^\n]{0,120}--privileged"),
    ("k8s_delete_all", "risky-infra", "warn", r"\bkubectl\s+delete\b[^\n]{0,60}--all"),
    ("aws_wide_delete", "risky-infra", "warn", r"\baws\s+s3\s+rm\b[^\n]{0,80}--recursive"),
    ("sql_drop", "risky-infra", "warn", r"\bDROP\s+(?:DATABASE|TABLE|SCHEMA)\b"),
    ("sudo_pipe", "privilege-escalation", "warn", r"\bsudo\s+(?:ba)?sh\b"),
    ("curl_upload", "exfiltration", "warn", r"\bcurl\b[^\n]{0,120}(?:-T\s|--upload-file|-F\s+['\"]?file=@)"),
)


def _compile(rules: Iterable[tuple]) -> List[tuple]:
    compiled: List[tuple] = []
    for name, kind, severity, pattern in rules:
        try:
            compiled.append((name, kind, severity, re.compile(pattern, re.IGNORECASE)))
        except re.error:  # pragma: no cover - defensive, rules are static
            continue
    return compiled


def load_rules(patterns_file: Optional[str] = None) -> List[tuple]:
    """Return compiled rules, optionally extended/overridden from JSON.

    ``AAB_PATTERNS_FILE`` may point to a JSON file shaped as::

        {
          "replace_builtin": false,
          "rules": [
            {"name": "my_rule", "kind": "destructive-fs",
             "severity": "block", "pattern": "rm -rf /data"}
          ]
        }
    """

    rules: List[tuple] = list(BUILTIN_RULES)
    if not patterns_file:
        return _compile(rules)

    path = Path(patterns_file).expanduser()
    if not path.is_file():
        return _compile(rules)

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _compile(rules)

    extra = []
    for item in payload.get("rules", []) or []:
        if not isinstance(item, dict) or not item.get("pattern"):
            continue
        extra.append(
            (
                str(item.get("name", "custom_rule")),
                str(item.get("kind", "custom")),
                str(item.get("severity", "block")).lower(),
                str(item["pattern"]),
            )
        )

    if payload.get("replace_builtin"):
        rules = extra
    else:
        rules.extend(extra)
    return _compile(rules)


def _line_number(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def sanitize(text: str, mode: str = "redact", rules: Optional[List[tuple]] = None) -> tuple:
    """Inspect (and optionally neutralise) an untrusted answer.

    Returns ``(clean_text, report)``.  ``mode``: ``off`` | ``detect`` | ``redact``.
    """

    report = SanitizeReport(mode=mode)
    if not text:
        return text, report
    if mode == "off":
        return text, report

    active_rules = rules if rules is not None else load_rules()
    if not active_rules:
        return text, report

    cleaned = text
    for name, kind, severity, regex in active_rules:
        for match in list(regex.finditer(text))[:8]:
            snippet = match.group(0)
            if len(snippet) > 160:
                snippet = snippet[:157] + "..."
            if len(report.findings) < MAX_FINDINGS:
                report.findings.append(
                    Finding(
                        pattern=name,
                        kind=kind,
                        severity=severity,
                        match=snippet,
                        line=_line_number(text, match.start()),
                    )
                )
        if severity != "block" or mode != "redact":
            continue
        # neutralise: keep the shape of the answer, drop the payload
        def _replace(match, _name=name) -> str:
            return f"[BLOCKED BY ARENA-AGENT-BRIDGE: {_name}]"

        cleaned, count = regex.subn(_replace, cleaned)
        report.replacements += int(count)

    # Normalise ANSI escape sequences that some terminals would interpret when
    # the answer is echoed back to the agent's log.
    ansi = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
    if ansi.search(cleaned):
        cleaned = ansi.sub("", cleaned)
        report.findings.append(
            Finding(
                pattern="ansi_escape",
                kind="terminal-injection",
                severity="warn",
                match="ANSI escape sequences stripped",
            )
        )

    return cleaned, report
