import json

import pytest

from bookr_preprocess.ai import DeepSeekCorrector


def test_deepseek_request_shape_and_content():
    seen: dict = {}

    def transport(request, timeout):
        seen['url'] = request.full_url
        seen['timeout'] = timeout
        seen['method'] = request.get_method()
        seen['headers'] = {
            key.lower(): value for key, value in request.header_items()
        }
        seen['body'] = json.loads(request.data.decode())
        return json.dumps(
            {'choices': [{'message': {'content': ' 更正后的正文。 '}}]}
        ).encode()

    corrector = DeepSeekCorrector('test-key', transport=transport)
    assert corrector.correct('原文') == '更正后的正文。'
    assert seen['url'] == 'https://api.deepseek.com/chat/completions'
    assert seen['method'] == 'POST'
    assert seen['timeout'] == 30.0
    assert seen['headers']['content-type'] == 'application/json'
    assert seen['headers']['authorization'] == 'Bearer test-key'
    assert seen['body']['model'] == 'deepseek-chat'
    assert seen['body']['temperature'] == 0.2
    assert seen['body']['stream'] is False
    assert 'OCR' in seen['body']['messages'][0]['content']
    assert seen['body']['messages'][0]['role'] == 'system'
    assert seen['body']['messages'][1]['content'] == '原文'


def test_uses_configured_model_endpoint_and_timeout():
    seen: dict = {}

    def transport(request, timeout):
        seen['url'] = request.full_url
        seen['timeout'] = timeout
        seen['body'] = json.loads(request.data.decode())
        return b'{"choices": [{"message": {"content": "ok"}}]}'

    corrector = DeepSeekCorrector(
        'key',
        model='custom-model',
        endpoint='https://example.test/chat',
        timeout=5.0,
        transport=transport,
    )
    assert corrector.correct('原文') == 'ok'
    assert seen['url'] == 'https://example.test/chat'
    assert seen['timeout'] == 5.0
    assert seen['body']['model'] == 'custom-model'


def test_long_text_is_returned_unchanged_and_transport_errors_propagate():
    def unexpected_transport(request, timeout):
        raise AssertionError('transport must not be called for long text')

    corrector = DeepSeekCorrector('test-key', transport=unexpected_transport)
    long_text = '长' * 4001
    assert corrector.correct(long_text) == long_text

    failing = DeepSeekCorrector(
        'test-key',
        transport=lambda request, timeout: (_ for _ in ()).throw(OSError('offline')),
    )
    with pytest.raises(OSError):
        failing.correct('原文')


def test_empty_response_returns_original():
    corrector = DeepSeekCorrector(
        'test-key',
        transport=lambda request, timeout: json.dumps(
            {'choices': [{'message': {'content': '   '}}]}
        ).encode(),
    )
    assert corrector.correct('原文') == '原文'


def test_runaway_response_returns_original():
    corrector = DeepSeekCorrector(
        'test-key',
        transport=lambda request, timeout: json.dumps(
            {'choices': [{'message': {'content': '扩' * 401}}]}
        ).encode(),
    )
    assert corrector.correct('原文') == '原文'


def test_missing_choices_returns_original():
    corrector = DeepSeekCorrector(
        'test-key',
        transport=lambda request, timeout: b'{}',
    )
    assert corrector.correct('原文') == '原文'


def test_exactly_at_utf16_limit_still_requests():
    calls = []

    def transport(request, timeout):
        calls.append(json.loads(request.data.decode())['messages'][1]['content'])
        return b'{"choices": [{"message": {"content": "ok"}}]}'

    corrector = DeepSeekCorrector('test-key', transport=transport)
    text = 'a' * 4000
    assert corrector.correct(text) == 'ok'
    assert calls == [text]
