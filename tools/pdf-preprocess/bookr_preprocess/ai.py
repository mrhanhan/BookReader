"""Optional DeepSeek-based correction for OCR-derived text."""

from __future__ import annotations

import json
import urllib.request
from typing import Callable

from .model import utf16_len

SYSTEM_PROMPT = (
    "你是中文图书 OCR 校对助手。修正明显的 OCR 错字、被硬换行切断的句子和多余空格，"
    "保留原意、段落与标点。只输出校对后的正文，不要解释。"
)

MAX_INPUT_UTF16 = 4000
MAX_MIN_RESPONSE_UTF16 = 400

Transport = Callable[[urllib.request.Request, float], bytes]


def default_transport(request: urllib.request.Request, timeout: float) -> bytes:
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


class DeepSeekCorrector:
    """``TextCorrector`` implementation calling the DeepSeek chat API.

    Only the standard library is used. Transport failures propagate so the
    pack builder can warn and keep the uncorrected block.
    """

    def __init__(
        self,
        api_key: str,
        model: str = "deepseek-chat",
        endpoint: str = "https://api.deepseek.com/chat/completions",
        timeout: float = 30.0,
        transport: Transport | None = None,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._endpoint = endpoint
        self._timeout = timeout
        self._transport = transport if transport is not None else default_transport

    def correct(self, text: str) -> str:
        if not text.strip() or utf16_len(text) > MAX_INPUT_UTF16:
            return text

        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            "temperature": 0.2,
            "stream": False,
            # Give the model room to reflow and fix the text without letting
            # a runaway completion inflate the bill.
            "max_tokens": max(256, 2 * utf16_len(text)),
        }
        request = urllib.request.Request(
            self._endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._api_key}",
            },
            method="POST",
        )
        body = self._transport(request, self._timeout)
        response = json.loads(body.decode("utf-8"))

        try:
            content = response["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            return text
        if not isinstance(content, str):
            return text

        corrected = content.strip()
        limit = max(MAX_MIN_RESPONSE_UTF16, 4 * utf16_len(text))
        if not corrected or utf16_len(corrected) > limit:
            return text
        return corrected
