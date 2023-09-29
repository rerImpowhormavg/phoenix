import logging
from abc import ABC, abstractmethod, abstractproperty
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Type

if TYPE_CHECKING:
    from tiktoken import Encoding

from tenacity import (
    RetryCallState,
    before_sleep_log,
    retry,
    retry_base,
    retry_if_exception_type,
    stop_after_attempt,
    wait_random_exponential,
)
from tqdm import tqdm
from tqdm.asyncio import tqdm_asyncio

from ..utils.threads import to_thread
from ..utils.types import is_list_of

logger = logging.getLogger(__name__)

TQDM_BAR_FORMAT = (
    "Eta:{eta} |{bar}| {percentage:3.1f}% "
    "({n_fmt}/{total_fmt}) "
    "[{elapsed}<{remaining}, {rate_fmt}{postfix}]"
)


def create_base_retry_decorator(
    error_types: List[Type[BaseException]],
    min_seconds: int,
    max_seconds: int,
    max_retries: int,
) -> Callable[[Any], Any]:
    """Create a retry decorator for a given LLM and provided list of error types."""

    # TODO: Nice logging. The logging implemented is huge and overwhelming
    _logging = before_sleep_log(logger, logging.WARNING)

    def _before_sleep(retry_state: RetryCallState) -> None:
        _logging(retry_state)
        return None

    retry_instance: retry_base = retry_if_exception_type(error_types[0])
    for error in error_types[1:]:
        retry_instance = retry_instance | retry_if_exception_type(error)
    return retry(
        reraise=True,
        stop=stop_after_attempt(max_retries),
        wait=wait_random_exponential(multiplier=1, min=min_seconds, max=max_seconds),
        retry=retry_instance,
        # before_sleep=_before_sleep,
    )


@dataclass
class BaseEvalModel(ABC):
    def __call__(self, prompt: str, instruction: Optional[str] = None) -> str:
        """Run the LLM on the given prompt."""
        if not isinstance(prompt, str):
            raise TypeError(
                "Invalid type for argument `prompt`. Expected a string but found "
                f"{type(prompt)}. If you want to run the LLM on multiple prompts, use "
                "`generate` instead."
            )
        if instruction is not None and not isinstance(instruction, str):
            raise TypeError(
                "Invalid type for argument `instruction`. Expected a string but found "
                f"{type(instruction)}."
            )
        return self.generate(prompts=[prompt], instruction=instruction)[0]

    async def async_call(self, prompt: str, instruction: Optional[str] = None) -> str:
        """Run the LLM on the given prompt."""
        if not isinstance(prompt, str):
            raise TypeError(
                "Invalid type for argument `prompt`. Expected a string but found "
                f"{type(prompt)}. If you want to run the LLM on multiple prompts, use "
                "`generate` instead."
            )
        if instruction is not None and not isinstance(instruction, str):
            raise TypeError(
                "Invalid type for argument `instruction`. Expected a string but found "
                f"{type(instruction)}."
            )
        response = await self.agenerate(prompts=[prompt], instruction=instruction)
        return response[0]

    def generate(self, prompts: List[str], instruction: Optional[str] = None) -> List[str]:
        if not is_list_of(prompts, str):
            raise TypeError(
                "Invalid type for argument `prompts`. Expected a list of strings "
                f"but found {type(prompts)}."
            )
        try:
            outputs = []
            for prompt in tqdm(prompts, bar_format=TQDM_BAR_FORMAT, ncols=100):
                output = self._generate(prompt=prompt, instruction=instruction)  # type:ignore
                logger.info(f"Prompt: {prompt}\nInstruction: {instruction}\nOutput: {output}")
                outputs.append(output)

        except (KeyboardInterrupt, Exception) as e:
            raise e
        return outputs

    async def agenerate(self, prompts: List[str], instruction: Optional[str] = None) -> List[str]:
        if not is_list_of(prompts, str):
            raise TypeError(
                "Invalid type for argument `prompts`. Expected a list of strings "
                f"but found {type(prompts)}."
            )
        try:
            result: List[str] = await tqdm_asyncio.gather(
                *[self._agenerate(prompt=prompt, instruction=instruction) for prompt in prompts],
                bar_format=TQDM_BAR_FORMAT,
                ncols=100,
            )
        except (KeyboardInterrupt, Exception) as e:
            raise e
        return result

    @abstractmethod
    def _generate(self, prompt: str, **kwargs: Dict[str, Any]) -> str:
        raise NotImplementedError

    async def _agenerate(self, prompt: str, instruction: Optional[str]) -> str:
        return str(await to_thread(self._generate, prompt=prompt, instruction=instruction))

    @staticmethod
    def _raise_import_error(
        package_name: str, package_display_name: str = "", package_min_version: str = ""
    ) -> None:
        if not package_display_name:
            package_display_name = package_name
        msg = (
            f"Could not import necessary dependencies to use {package_display_name}. "
            "Please install them with"
        )
        if package_min_version:
            msg += f"`pip install {package_name}>={package_min_version}`."
        else:
            msg += f"`pip install {package_name}`."
        raise ImportError(msg)

    @abstractmethod
    def get_tokens_from_text(self, text: str) -> List[int]:
        raise NotImplementedError

    @abstractmethod
    def get_text_from_tokens(self, tokens: List[int]) -> str:
        raise NotImplementedError

    @abstractproperty
    def max_context_size(self) -> int:
        raise NotImplementedError

    @abstractproperty
    def encoder(self) -> "Encoding":
        raise NotImplementedError
