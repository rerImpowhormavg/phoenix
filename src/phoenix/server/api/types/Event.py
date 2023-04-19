from collections import defaultdict
from typing import Any, Dict, List, Optional

import strawberry
from pandas import Series
from strawberry import ID

from phoenix.datasets import Schema
from phoenix.datasets.dataset import DatasetRole
from phoenix.datasets.event import EventId

from .Dimension import Dimension
from .DimensionWithValue import DimensionWithValue
from .EventMetadata import EventMetadata
from .PromptResponse import PromptResponse


@strawberry.type
class Event:
    id: strawberry.ID
    eventMetadata: EventMetadata
    dimensions: List[DimensionWithValue]
    prompt_and_response: Optional[PromptResponse] = strawberry.field(
        description="The prompt and response pair associated with the event"
    )


def parse_event_ids(event_ids: List[ID]) -> Dict[DatasetRole, List[int]]:
    """
    Parses event IDs and returns the corresponding row indexes.
    """
    row_indexes = defaultdict(list)
    for event_id in event_ids:
        row_index, dataset_role_str = str(event_id).split(":")
        dataset_role = DatasetRole[dataset_role_str.split(".")[-1]]
        row_indexes[dataset_role].append(int(row_index))
    return row_indexes


def create_event(
    row_index: int,
    dataset_role: "DatasetRole",
    row: "Series[Any]",
    schema: Schema,
    dimensions: List[Dimension],
) -> Event:
    """
    Reads dimension values and event metadata from a dataframe row and returns
    an event containing this information.
    """
    event_metadata = EventMetadata(
        prediction_label=(
            row[col] if (col := schema.prediction_label_column_name) is not None else None
        ),
        prediction_score=(
            row[col] if (col := schema.prediction_score_column_name) is not None else None
        ),
        actual_label=row[col] if (col := schema.actual_label_column_name) is not None else None,
        actual_score=row[col] if (col := schema.actual_score_column_name) is not None else None,
    )
    dimensions_with_values = [
        DimensionWithValue(
            dimension=dim,
            value=row[dim.name],
        )
        for dim in dimensions
    ]

    return Event(
        id=ID(str(EventId(row_id=row_index, dataset_id=dataset_role))),
        eventMetadata=event_metadata,
        dimensions=dimensions_with_values,
        prompt_and_response=create_prompt_and_response(schema=schema, row=row),
    )


def create_prompt_and_response(
    schema: Schema,
    row: "Series[Any]",
) -> Optional[PromptResponse]:
    prompt_raw_data_column_name = (
        schema.prompt_column_names.raw_data_column_name
        if schema.prompt_column_names is not None
        else None
    )
    response_raw_data_column_name = (
        schema.response_column_names.raw_data_column_name
        if schema.response_column_names is not None
        else None
    )

    prompt_and_response: Optional[PromptResponse] = None
    if prompt_raw_data_column_name is not None or response_raw_data_column_name is not None:
        return PromptResponse(
            prompt=row[prompt_raw_data_column_name]
            if prompt_raw_data_column_name is not None
            else None,
            response=row[response_raw_data_column_name]
            if response_raw_data_column_name is not None
            else None,
        )

    return prompt_and_response
