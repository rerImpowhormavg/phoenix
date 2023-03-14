from collections import defaultdict
from datetime import datetime, timedelta
from itertools import chain
from typing import Any, Optional

import numpy as np
import numpy.typing as npt
import strawberry
from pandas import DataFrame, Series
from strawberry.scalars import ID
from strawberry.types import Info
from typing_extensions import Annotated

from phoenix.core import EmbeddingDimension as CoreEmbeddingDimension
from phoenix.datasets import Dataset
from phoenix.datasets.dataset import DatasetType
from phoenix.datasets.errors import SchemaError
from phoenix.datasets.event import EventId
from phoenix.metrics.timeseries import row_interval_from_sorted_time_index
from phoenix.pointcloud.clustering import Hdbscan
from phoenix.pointcloud.pointcloud import PointCloud
from phoenix.pointcloud.projectors import Umap
from phoenix.server.api.context import Context
from phoenix.server.api.input_types.TimeRange import TimeRange

from ..input_types.Granularity import Granularity
from .DataQualityMetric import DataQualityMetric
from .DriftMetric import DriftMetric
from .EmbeddingMetadata import EmbeddingMetadata
from .EventMetadata import EventMetadata
from .node import Node
from .TimeSeries import DataQualityTimeSeries, DriftTimeSeries
from .UMAPPoints import UMAPPoint, UMAPPoints, to_gql_clusters, to_gql_coordinates

# Default UMAP hyperparameters
DEFAULT_N_COMPONENTS = 3
DEFAULT_MIN_DIST = 0
DEFAULT_N_NEIGHBORS = 30
DEFAULT_N_SAMPLES = 500

DRIFT_EVAL_WINDOW_NUM_INTERVALS = 72
EVAL_INTERVAL_LENGTH = timedelta(hours=1)


@strawberry.type
class EmbeddingDimension(Node):
    """A embedding dimension of a model. Represents unstructured data"""

    name: str

    @strawberry.field
    def drift_metric(
        self,
        info: Info[Context, None],
        metric: DriftMetric,
        time_range: Optional[TimeRange] = None,
    ) -> Optional[float]:
        """
        Computes a drift metric between all reference data and the primary data
        belonging to the input time range (inclusive of the time range start and
        exclusive of the time range end). Returns None if no reference dataset
        exists, if no primary data exists in the input time range, or if the
        input time range is invalid.
        """
        if len(
            data := DriftTimeSeries(
                str(info.context.model.primary_dataset.get_embedding_vector_column(self.name).name),
                info.context.model,
                metric,
                time_range,
            ).data
        ):
            return data.pop().value
        return None

    @strawberry.field(
        description=(
            "Returns the time series of the specified metric for data within timeRange. Data points"
            " are generated starting at the end time, are separated by the sampling interval. Each"
            " data point is labeled by the end instant of and contains data from their respective"
            " evaluation window."
        )
    )  # type: ignore  # https://github.com/strawberry-graphql/strawberry/issues/1929
    def data_quality_time_series(
        self,
        info: Info[Context, None],
        metric: DataQualityMetric,
        time_range: TimeRange,
        granularity: Granularity,
    ) -> DataQualityTimeSeries:
        return DataQualityTimeSeries(
            str(info.context.model.primary_dataset.get_embedding_vector_column(self.name).name),
            info.context.model,
            metric,
            time_range,
            granularity,
        )

    @strawberry.field
    def drift_time_series(
        self,
        info: Info[Context, None],
        metric: DriftMetric,
        time_range: TimeRange,
        granularity: Granularity,
    ) -> DriftTimeSeries:
        """
        Computes a drift time-series between the primary and reference datasets.
        The output drift time-series contains one data point for each whole hour
        in the input time range (inclusive of the time range start and exclusive
        of the time range end). Each data point contains the drift metric value
        between all reference data and the primary data within the evaluation
        window ending at the corresponding time.

        Returns None if no reference dataset exists or if the input time range
        is invalid.
        """
        return DriftTimeSeries(
            str(info.context.model.primary_dataset.get_embedding_vector_column(self.name).name),
            info.context.model,
            metric,
            time_range,
            granularity,
        )

    @strawberry.field
    def UMAPPoints(
        self,
        info: Info[Context, None],
        time_range: Annotated[
            TimeRange,
            strawberry.argument(
                description="The time range of the primary dataset to generate the UMAP points for",
            ),
        ],
        n_components: Annotated[
            Optional[int],
            strawberry.argument(
                description="UMAP target dimension hyperparameter. Must be 2 or 3",
            ),
        ] = DEFAULT_N_COMPONENTS,
        min_dist: Annotated[
            Optional[float],
            strawberry.argument(
                description="UMAP minimum distance hyperparameter",
            ),
        ] = DEFAULT_MIN_DIST,
        n_neighbors: Annotated[
            Optional[int],
            strawberry.argument(
                description="UMAP N neighbors hyperparameter",
            ),
        ] = DEFAULT_N_NEIGHBORS,
        n_samples: Annotated[
            Optional[int],
            strawberry.argument(
                description="UMAP N samples",
            ),
        ] = DEFAULT_N_SAMPLES,
    ) -> UMAPPoints:
        n_samples = n_samples or DEFAULT_N_SAMPLES

        datasets = {
            DatasetType.PRIMARY: info.context.model.primary_dataset,
            DatasetType.REFERENCE: info.context.model.reference_dataset,
        }

        data = dict(
            chain.from_iterable(
                (
                    ()
                    if dataset is None
                    else (
                        (
                            EventId(row_id, dataset_id),
                            dataset.get_embedding_vector_column(self.name).iloc[row_id],
                        )
                        for row_id in (
                            range(
                                *(
                                    row_interval_from_sorted_time_index(
                                        dataset.dataframe.index,
                                        start=time_range.start,
                                        end=time_range.end,
                                    )
                                    if dataset_id == DatasetType.PRIMARY
                                    else (len(dataset.dataframe),)
                                )
                            )
                        )[:n_samples]
                    )
                )
                for dataset_id, dataset in datasets.items()
            )
        )

        # validate n_components to be 2 or 3
        n_components = DEFAULT_N_COMPONENTS if n_components is None else n_components
        if not 2 <= n_components <= 3:
            raise Exception(f"n_components must be 2 or 3, got {n_components}")

        min_dist = DEFAULT_MIN_DIST if min_dist is None else min_dist
        n_neighbors = DEFAULT_N_NEIGHBORS if n_neighbors is None else n_neighbors

        vectors, cluster_membership = PointCloud(
            dimensionalityReducer=Umap(n_neighbors=n_neighbors, min_dist=min_dist),
            clustersFinder=Hdbscan(),
        ).generate(data, n_components=n_components)

        points = defaultdict(list)

        for event_id, vector in vectors.items():
            row_id, dataset_id = event_id
            dataset = datasets[dataset_id]
            if dataset is None:
                continue

            prediction_label = None
            prediction_score = None
            actual_label = None
            actual_score = None
            link_to_data = None
            raw_data = None

            try:
                prediction_label = dataset.get_prediction_label_column()[row_id]
            except SchemaError:
                pass

            try:
                prediction_score = dataset.get_prediction_score_column()[row_id]
            except SchemaError:
                pass

            try:
                actual_label = dataset.get_actual_label_column()[row_id]
            except SchemaError:
                pass

            try:
                actual_score = dataset.get_actual_score_column()[row_id]
            except SchemaError:
                pass

            link_to_data_column = dataset.get_embedding_link_to_data_column(self.name)
            if link_to_data_column is not None:
                link_to_data = link_to_data_column[row_id]

            embedding_raw_data_column = dataset.get_embedding_raw_data_column(self.name)
            if embedding_raw_data_column is not None:
                raw_data = embedding_raw_data_column[row_id]

            points[dataset_id].append(
                UMAPPoint(
                    id=ID(str(event_id)),
                    coordinates=to_gql_coordinates(vector),
                    event_metadata=EventMetadata(
                        prediction_label=prediction_label,
                        prediction_score=prediction_score,
                        actual_label=actual_label,
                        actual_score=actual_score,
                    ),
                    embedding_metadata=EmbeddingMetadata(
                        link_to_data=link_to_data,
                        raw_data=raw_data,
                    ),
                )
            )

        has_reference_data = datasets[DatasetType.REFERENCE] is not None

        return UMAPPoints(
            data=points[DatasetType.PRIMARY],
            reference_data=points[DatasetType.REFERENCE],
            clusters=to_gql_clusters(cluster_membership, has_reference_data=has_reference_data),
        )


def to_gql_embedding_dimension(
    id_attr: int, embedding_dimension: CoreEmbeddingDimension
) -> EmbeddingDimension:
    """
    Converts a phoenix.core.EmbeddingDimension to a
    phoenix.server.api.types.EmbeddingDimension
    """
    return EmbeddingDimension(
        id_attr=id_attr,
        name=embedding_dimension.name,
    )


def _compute_mean_vector(embeddings: npt.NDArray[np.float64]) -> npt.NDArray[np.float64]:
    """
    Computes mean vector for an embeddings array. If the embeddings array has
    dimensions num_records x num_embedding_dimensions, the output mean vector is
    a one-dimensional array of length num_embedding_dimensions.
    """
    return embeddings.mean(axis=0)  # type: ignore


def _get_embeddings_array_for_time_range(
    dataset: Dataset, embedding_feature_name: str, start: datetime, end: datetime
) -> Optional[npt.NDArray[np.float64]]:
    """
    Returns the embeddings belonging to a particular dataset and time range as
    an array, or returns None if no embeddings from the dataset belong to the
    desired time range.
    """
    embeddings_column = dataset.get_embedding_vector_column(embedding_feature_name)
    timestamp_column = dataset.get_timestamp_column()
    dataframe = DataFrame({"embeddings": embeddings_column, "timestamp": timestamp_column})
    query = _time_range_query(timestamp_column_name="timestamp", start=start, end=end)
    embeddings_column = dataframe.query(query).embeddings
    num_embeddings = embeddings_column.shape[0]
    if num_embeddings == 0:
        return None
    return _to_array(embeddings_column)


def _time_range_query(timestamp_column_name: str, start: datetime, end: datetime) -> str:
    """
    Returns a string used to query a dataframe for rows belonging to a
    particular time range.
    """
    return f'"{start}" <= `{timestamp_column_name}` < "{end}"'


def _to_array(embeddings_column: "Series[Any]") -> npt.NDArray[np.float64]:
    """
    Converts an embeddings column to a numpy array. If the embeddings column
    contains N embeddings, each of dimension M, the output array has dimensions
    N x M.
    """
    return np.stack(embeddings_column.to_numpy())  # type: ignore
