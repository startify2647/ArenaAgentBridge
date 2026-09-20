"""Turn an OpenAI ``messages`` array into the single prompt the web UI receives.

The web UI (Arena.ai/Agent, like most chat pages) has exactly one text box, so a
multi-turn conversation has to be flattened into one plain-text transcript with
role labels.  Two modes are provided:

``agent``
    The site is treated as an autonomous agent.  A short preamble explains that
    the caller is an automated bridge, forbids meta commentary and asks for the
    final answer only.  This is the default and the mode Hermes/OpenClaw want.

``direct``
    No preamble at all - the transcript is pasted as-is.  Useful when you talk to
    the page yourself or when the preamble confuses the model.
"""

from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

from .config import Settings
from .models import ChatMessage


class PromptBuildError(ValueError):
    """Raised when the request cannot be turned into a prompt."""


def _label_for(role: str, settings: Settings) -> str:
    return {
        "system": settings.system_role_label,
        "developer": settings.system_role_label,
        "user": settings.user_role_label,
        "assistant": settings.assistant_role_label,
        "tool": settings.tool_role_label,
        "function": settings.tool_role_label,
    }.get(role, f"### {role}")


def normalise_messages(messages: Sequence[ChatMessage]) -> List[Tuple[str, str]]:
    """Drop empty messages and collapse consecutive same-role turns."""

    pairs: List[Tuple[str, str]] = []
    for message in messages:
        text = message.as_text().strip()
        if not text:
            continue
        role = message.role
        if role in ("developer",):
            role = "system"
        if role in ("function", "tool"):
            role = "tool"
        if pairs and pairs[-1][0] == role and role in ("system", "user", "tool"):
            pairs[-1] = (role, pairs[-1][1] + "\n\n" + text)
        else:
            pairs.append((role, text))
    return pairs


def last_user_message(pairs: Sequence[Tuple[str, str]]) -> str:
    for role, text in reversed(pairs):
        if role == "user":
            return text
    return pairs[-1][1] if pairs else ""


def render_transcript(pairs: Sequence[Tuple[str, str]], settings: Settings) -> str:
    blocks: List[str] = []
    for role, text in pairs:
        blocks.append(f"{_label_for(role, settings)}\n{text}")
    return "\n\n".join(blocks)


def build_prompt(
    messages: Sequence[ChatMessage],
    settings: Settings,
    mode: Optional[str] = None,
) -> Tuple[str, str]:
    """Return ``(prompt, mode)`` ready to be typed into the web UI."""

    resolved_mode = (mode or settings.default_mode or "agent").lower()
    if resolved_mode not in {"agent", "direct"}:
        resolved_mode = settings.default_mode

    pairs = normalise_messages(messages)
    if not pairs:
        raise PromptBuildError(
            "no usable message content: every message in `messages` was empty "
            "(the bridge can only forward text)"
        )

    transcript = render_transcript(pairs, settings)
    final_user = last_user_message(pairs)

    if resolved_mode == "agent":
        prompt = settings.agent_wrapper.format(transcript=transcript, last_user=final_user)
    else:
        prompt = settings.direct_wrapper.format(transcript=transcript, last_user=final_user)

    prompt = prompt.strip()
    if len(prompt) > settings.max_prompt_chars:
        raise PromptBuildError(
            f"prompt is {len(prompt)} characters which exceeds "
            f"AAB_MAX_PROMPT_CHARS={settings.max_prompt_chars}; trim the history, "
            "the bridge types the prompt into a text box with browser speed limits"
        )
    return prompt, resolved_mode
