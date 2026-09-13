from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import BaseModel

from quincy.config import Settings
from quincy.models.factory import get_model
from quincy.models.openai_adapter import ModelOutputError
from quincy.models.openrouter_adapter import OpenRouterSecurityModel
from quincy.models.router import ModelTask, resolve_candidates


class Output(BaseModel):
    answer: str


def test_factory_and_routing():
    settings = Settings(_env_file=None, model_provider="openrouter", openrouter_api_key="test-key")
    model = get_model(settings)
    assert isinstance(model, OpenRouterSecurityModel)
    assert str(model._client.base_url) == "https://openrouter.ai/api/v1/"
    assert model.model_name == "deepseek/deepseek-v4-flash-0731"
    assert (
        resolve_candidates(settings, ModelTask.PATCH_GENERATION)[0].model_name == model.model_name
    )


def test_missing_key():
    with pytest.raises(ModelOutputError, match="OPENROUTER_API_KEY"):
        OpenRouterSecurityModel("test", None)


@pytest.mark.asyncio
async def test_structured_transport_and_usage():
    model = OpenRouterSecurityModel("deepseek/deepseek-v4-flash-0731", "test-key", seed=42)
    parse = AsyncMock(
        return_value=SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(parsed=Output(answer="ok")))],
            usage=SimpleNamespace(
                prompt_tokens=10, completion_tokens=5, total_tokens=15, cost=0.001
            ),
        )
    )
    model._client.chat.completions.parse = parse
    result, usage = await model._call_structured("test prompt", Output)
    assert result.answer == "ok"
    assert usage.cost_usd == 0.001
    assert usage.total_tokens == 15
    assert parse.call_args.kwargs["response_format"] is Output
    assert parse.call_args.kwargs["seed"] == 42
    assert parse.call_args.kwargs["extra_body"]["reasoning"] == {"enabled": False}
    assert parse.call_args.kwargs["model"] == model.model_name
    parse.return_value.choices = []
    with pytest.raises(ModelOutputError, match="did not parse"):
        await model._call_structured("test", Output)


def _response(content=None, finish="stop", refusal=None):
    from openai.types.chat import ChatCompletion

    return ChatCompletion.model_validate(
        {
            "id": "test",
            "object": "chat.completion",
            "created": 0,
            "model": "test",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": finish,
                    "message": {"role": "assistant", "content": content, "refusal": refusal},
                }
            ],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
                "cost": 0.001,
            },
        }
    )


@pytest.mark.parametrize("truncated", [False, True])
async def test_incomplete_response_retries_and_accumulates_usage(truncated):
    from openai import LengthFinishReasonError
    from openai.types.chat import ParsedChatCompletion

    model = OpenRouterSecurityModel("test", "test-key")
    first = _response(finish="length" if truncated else "stop")
    success = ParsedChatCompletion[Output].model_validate(_response('{"answer":"ok"}').model_dump())
    success.choices[0].message.parsed = Output(answer="ok")
    model._client.chat.completions.parse = AsyncMock(
        side_effect=[
            LengthFinishReasonError(completion=first) if truncated else first,
            success,
        ]
    )
    result, usage = await model._call_structured("test", Output)
    assert result.answer == "ok"
    assert usage.total_tokens == 30
    assert usage.cost_usd == 0.002
    assert model._client.chat.completions.parse.call_args.kwargs["max_tokens"] == 16384


async def test_refusal_is_not_retried():
    model = OpenRouterSecurityModel("test", "test-key")
    model._client.chat.completions.parse = AsyncMock(return_value=_response(refusal="refused"))
    with pytest.raises(ModelOutputError, match="refusal=True"):
        await model._call_structured("test", Output)
    assert model._client.chat.completions.parse.call_count == 1


async def test_empty_response_retries_are_bounded():
    model = OpenRouterSecurityModel("test", "test-key")
    model._client.chat.completions.parse = AsyncMock(return_value=_response())
    with pytest.raises(ModelOutputError, match="content_chars=0"):
        await model._call_structured("test", Output)
    assert model._client.chat.completions.parse.call_count == 2


async def test_transient_connection_error_retries_without_resetting_workflow():
    from openai import APIConnectionError
    import httpx
    model = OpenRouterSecurityModel('test', 'test-key')
    success = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(parsed=Output(answer='ok')))], usage=None)
    model._client.chat.completions.parse = AsyncMock(side_effect=[APIConnectionError(request=httpx.Request('POST', 'https://example.test')), success])
    result, _ = await model._call_structured('test', Output)
    assert result.answer == 'ok'
    assert model._client.chat.completions.parse.call_count == 2


async def test_patch_retry_does_not_automatically_enable_reasoning():
    from quincy.models._shared import PatchOutput
    model = OpenRouterSecurityModel('test', 'test-key')
    output = PatchOutput(summary='fix', rationale='fix')
    model._client.chat.completions.parse = AsyncMock(return_value=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(parsed=output))], usage=None))
    await model._call_structured('## Why the previous attempt failed\nTests failed', PatchOutput)
    assert not model._client.chat.completions.parse.call_args.kwargs['extra_body']['reasoning']['enabled']
    assert model._client.chat.completions.parse.call_args.kwargs['max_tokens'] == 8096


async def test_wall_deadline_cancels_slow_provider():
    import asyncio
    cancelled = asyncio.Event()
    async def slow(**kwargs):
        try:
            await asyncio.sleep(10)
        finally:
            cancelled.set()
    model = OpenRouterSecurityModel('test', 'test-key', timeout_seconds=0.03)
    model._client.chat.completions.parse = AsyncMock(side_effect=slow)
    with pytest.raises(ModelOutputError, match='deadline'):
        await model._call_structured('test', Output)
    assert cancelled.is_set()
    assert model._client.chat.completions.parse.call_count == 1


async def test_deadline_includes_retry_backoff():
    import httpx
    from openai import APIConnectionError
    model = OpenRouterSecurityModel('test', 'test-key', timeout_seconds=0.03)
    model._client.chat.completions.parse = AsyncMock(side_effect=APIConnectionError(request=httpx.Request('POST', 'https://example.test')))
    with pytest.raises(ModelOutputError, match='deadline'):
        await model._call_structured('test', Output)
    assert model._client.chat.completions.parse.call_count == 1
