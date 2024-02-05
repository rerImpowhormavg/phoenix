from abc import ABC, abstractmethod
from datetime import datetime
from typing import List, Optional, Union, cast

import pandas as pd

from phoenix.trace.dsl import SpanQuery


class TraceDataExtractor(ABC):
    """
    An abstract base class intended to constraint both `Client` and
    `Session` so that they both implement the same methods.
    """

    @abstractmethod
    def query_spans(
        self,
        *queries: SpanQuery,
        start_time: Optional[datetime] = None,
        stop_time: Optional[datetime] = None,
        root_spans_only: Optional[bool] = None,
    ) -> Optional[Union[pd.DataFrame, List[pd.DataFrame]]]:
        ...

    def get_spans_dataframe(
        self,
        filter_condition: Optional[str] = None,
        *,
        start_time: Optional[datetime] = None,
        stop_time: Optional[datetime] = None,
        root_spans_only: Optional[bool] = None,
    ) -> Optional[pd.DataFrame]:
        return cast(
            Optional[pd.DataFrame],
            self.query_spans(
                SpanQuery().where(filter_condition or ""),
                start_time=start_time,
                stop_time=stop_time,
                root_spans_only=root_spans_only,
            ),
        )
