"""OpenRouter transport for the shared security model workflows."""

import asyncio

from openai import APIConnectionError, AsyncOpenAI, LengthFinishReasonError
from openai.types.chat import ChatCompletion
from pydantic import BaseModel

from quincy.logging import get_logger
from quincy.models.openai_adapter import ModelOutputError, OpenAISecurityModel
from quincy.schemas.model import TokenUsage
from quincy.progress import report_progress

logger = get_logger(__name__)


class OpenRouterSecurityModel(OpenAISecurityModel):
    provider = "openrouter"

    def __init__(
        self,
        model_name: str,
        api_key: str | None,
        base_url: str = "https://openrouter.ai/api/v1",
        temperature: float = 0.0,
        seed: int | None = None,
        reasoning_enabled: bool = False,
        timeout_seconds: float = 120.0,
    ) -> None:
        if not api_key:
            raise ModelOutputError("OPENROUTER_API_KEY is not set — required to use OpenRouter")
        self.model_name = model_name
        self._temperature = temperature
        self._seed = seed
        self._reasoning_enabled = reasoning_enabled
        self._timeout_seconds = timeout_seconds
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=timeout_seconds, max_retries=1)

    async def _call_structured[T: BaseModel](
        self, prompt: str, schema_model: type[T]
    ) -> tuple[T, TokenUsage]:
        try:
            async with asyncio.timeout(self._timeout_seconds):
                return await self._call_structured_with_retries(prompt, schema_model)
        except TimeoutError as exc:
            raise ModelOutputError(
                f"{schema_model.__name__} exceeded the {self._timeout_seconds:g}s model-call deadline (including retries)"
            ) from exc

    async def _call_structured_with_retries[T: BaseModel](
        self, prompt: str, schema_model: type[T]
    ) -> tuple[T, TokenUsage]:
        response: ChatCompletion
        total = TokenUsage()
        detail = "no response"
        reasoning = self._reasoning_enabled or schema_model.__name__ == "FailureAnalysisOutput"
        budgets = (16384, 32768) if reasoning else (8096, 16384)
        for attempt, max_tokens in enumerate(budgets, start=1):
            labels = {"PatchOutput": "Generating patch", "FailureAnalysisOutput": "Analyzing validation failure", "AssessmentOutput": "Assessing finding", "RedTeamOutput": "Checking attack variants"}
            await report_progress(f"{labels.get(schema_model.__name__, 'Running model analysis')} (model request {attempt}/2; {self._timeout_seconds:g}s total deadline)")
            logger.info(
                "openrouter_call_start",
                model=self.model_name,
                schema=schema_model.__name__,
                attempt=attempt,
                max_tokens=max_tokens,
            )
            try:
                response = await self._client.chat.completions.parse(
                    model=self.model_name,
                    messages=[
                        {
                            "role": "user",
                            "content": prompt
                            + (
                                "\nReturn a complete JSON object matching the response schema. "
                                "Keep explanations concise and include all required fields."
                                if attempt > 1
                                else ""
                            ),
                        }
                    ],
                    response_format=schema_model,
                    max_tokens=max_tokens,
                    temperature=self._temperature,
                    seed=self._seed,
                    # Reserve the completion budget for the structured artifact.
                    # DeepSeek thinking can otherwise consume it all without a patch.
                    extra_body={"provider": {"require_parameters": True}, "reasoning": {"enabled": reasoning}},
                )
            except APIConnectionError:
                if attempt == len(budgets):
                    raise
                await asyncio.sleep(1)
                continue
            except LengthFinishReasonError as exc:
                # The SDK raises before returning a parsed response, but preserves usage.
                response = exc.completion

            usage = response.usage
            cost = getattr(usage, "cost", None) if usage else None
            total = TokenUsage(
                prompt_tokens=total.prompt_tokens + (usage.prompt_tokens if usage else 0),
                completion_tokens=total.completion_tokens
                + (usage.completion_tokens if usage else 0),
                total_tokens=total.total_tokens + (usage.total_tokens if usage else 0),
                cost_usd=total.cost_usd + (float(cost) if cost is not None else 0.0),
            )
            choice = response.choices[0] if response.choices else None
            message = choice.message if choice else None
            finish = getattr(choice, "finish_reason", None)
            refusal = bool(getattr(message, "refusal", None))
            parsed = getattr(message, "parsed", None)
            detail = (
                f"finish_reason={finish}, refusal={refusal}, "
                f"content_chars={len(getattr(message, 'content', None) or '')}, "
                f"completion_tokens={usage.completion_tokens if usage else 0}"
            )
            if finish != "length" and isinstance(parsed, schema_model) and not refusal:
                logger.info(
                    "openrouter_call_done",
                    model=self.model_name,
                    schema=schema_model.__name__,
                    attempt=attempt,
                    total_tokens=total.total_tokens,
                    cost_usd=total.cost_usd,
                )
                return parsed, total
            # Never retry a refusal or filtered response; only incomplete/empty outputs.
            if refusal or finish == "content_filter":
                break
            if attempt == 1:
                logger.warning(
                    "openrouter_incomplete_response_retry",
                    model=self.model_name,
                    schema=schema_model.__name__,
                    detail=detail,
                )
        raise ModelOutputError(
            f"model response did not parse as {schema_model.__name__} ({detail})"
        )
