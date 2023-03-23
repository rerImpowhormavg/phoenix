import { fetchQuery, graphql } from "react-relay";
import { interpolateCool, schemeCategory10 } from "d3-scale-chromatic";
import { create, StateCreator } from "zustand";
import { devtools } from "zustand/middleware";

import { ColorSchemes } from "@arizeai/point-cloud";

import {
  ColoringStrategy,
  CorrectnessGroup,
  DatasetGroup,
  DEFAULT_COLOR_SCHEME,
  SelectionDisplay,
  UNKNOWN_COLOR,
} from "@phoenix/constants/pointCloudConstants";
import RelayEnvironment from "@phoenix/RelayEnvironment";
import { Dimension } from "@phoenix/types";
import { assertUnreachable } from "@phoenix/typeUtils";
import { splitPointIdsByDataset } from "@phoenix/utils/pointCloudUtils";

import { pointCloudStore_dimensionMetadataQuery } from "./__generated__/pointCloudStore_dimensionMetadataQuery.graphql";
import {
  pointCloudStore_eventsQuery,
  pointCloudStore_eventsQuery$data,
} from "./__generated__/pointCloudStore_eventsQuery.graphql";

/**
 * THe number of numeric groups to use when coloring by a numeric dimension.
 */
const NUM_NUMERIC_GROUPS = 10;

// Color scales for dynamic coloring.
const sequentialColorScale = interpolateCool;
const discreteColorScaleCategories = schemeCategory10;
const discreteColorScale = (value: number) =>
  discreteColorScaleCategories[value];
const numericColorScale = (idx: number) =>
  sequentialColorScale(idx / NUM_NUMERIC_GROUPS);

type DimensionMetadata = {
  /**
   * The min and max values of a numeric  dimension
   */
  readonly interval: Interval | null;
  /**
   * The unique values of a categorical dimension
   */
  readonly categories: readonly string[] | null;
};

/**
 * The visibility of the two datasets in the point cloud.
 */
type DatasetVisibility = {
  primary: boolean;
  reference: boolean;
};

interface Point {
  id: string;
  readonly eventMetadata: {
    readonly actualLabel: string | null;
    readonly predictionLabel: string | null;
  };
}

type PointData =
  pointCloudStore_eventsQuery$data["model"]["primaryDataset"]["events"][number];
/**
 * A mapping from a point ID to its data
 */
type PointDataMap = Record<string, PointData | undefined>;

/**
 * The properties of the point cloud store.
 */
export interface PointCloudProps {
  /**
   * The point information that is currently loaded into view
   */
  points: readonly Point[];
  /**
   * The point information that is currently loaded into view
   * If it is null, the point data is being loaded.
   */
  pointData: PointDataMap | null;
  /**
   * The IDs of the points that are currently selected.
   */
  selectedPointIds: Set<string>;
  /**
   * The IDs of the clusters that are currently selected.
   */
  selectedClusterId: string | null;
  /**
   * The coloring strategy to use for the point cloud.
   */
  coloringStrategy: ColoringStrategy;
  /**
   * The visibility of the two datasets in the point cloud.
   * @default { primary: true, reference: true }
   */
  datasetVisibility: DatasetVisibility;
  /**
   * The visibility of the point groups in the point cloud.
   */
  pointGroupVisibility: Record<string, boolean>;
  /**
   * The colors of each point group in the point cloud.
   */
  pointGroupColors: Record<string, string>;
  /**
   * The mapping from pointId to point group.
   */
  pointIdToGroup: Record<string, string>;
  /**
   * The way in which the selected points are displayed in the selection panel
   * E.g. as a gallery or a list
   */
  selectionDisplay: SelectionDisplay;
  /**
   * When the coloring strategy is set to `dimension`, this property is set lazily by the user
   */
  dimension: Dimension | null;
  /**
   * Dimension level metadata for the current selected dimension
   */
  dimensionMetadata: DimensionMetadata | null;
}

export interface PointCloudState extends PointCloudProps {
  /**
   * Sets the points displayed within the point cloud
   */
  setPoints: (points: readonly Point[]) => void;
  /**
   * Sets the selected point IDs to the given value.
   */
  setSelectedPointIds: (ids: Set<string>) => void;

  /**
   * Sets the selected cluster id to the given value.
   */
  setSelectedClusterId: (ids: string | null) => void;
  /**
   * Sets the coloring strategy to the given value.
   */
  setColoringStrategy: (strategy: ColoringStrategy) => void;
  /**
   * Sets the dataset visibility to the given value.
   * @param {DatasetVisibility} visibility
   */
  setDatasetVisibility: (visibility: DatasetVisibility) => void;
  /**
   * Sets the point group visibility for the entire point cloud
   * @param {Record<string, PointGroupVisibility>} visibility
   */
  setPointGroupVisibility: (visibility: Record<string, boolean>) => void;
  /**
   * Set the selection display of the selection panel
   */
  setSelectionDisplay: (display: SelectionDisplay) => void;
  /**
   * Set the dimension to use for coloring the point cloud
   */
  setDimension: (dimension: Dimension) => void;
  /**
   * Set the dimension metadata for the current selected dimension
   */
  setDimensionMetadata: (dimensionMetadata: DimensionMetadata) => void;
  /**
   * Clear the selections in the point cloud
   * Done when the point cloud is re-loaded
   */
  reset: () => void;
}

/**
 * The default point cloud properties in the case that there are two datasets.
 */
export const DEFAULT_DRIFT_POINT_CLOUD_PROPS: Partial<PointCloudProps> = {
  coloringStrategy: ColoringStrategy.dataset,
  pointGroupVisibility: {
    [DatasetGroup.primary]: true,
    [DatasetGroup.reference]: true,
  },
  pointGroupColors: {
    [DatasetGroup.primary]: DEFAULT_COLOR_SCHEME[0],
    [DatasetGroup.reference]: DEFAULT_COLOR_SCHEME[1],
  },
};

/**
 * The default point cloud properties in the case that there is only one dataset.
 */
export const DEFAULT_SINGLE_DATASET_POINT_CLOUD_PROPS: Partial<PointCloudProps> =
  {
    coloringStrategy: ColoringStrategy.correctness,
    pointGroupVisibility: {
      [CorrectnessGroup.correct]: true,
      [CorrectnessGroup.incorrect]: true,
    },
    pointGroupColors: {
      [CorrectnessGroup.correct]: ColorSchemes.Discrete2.LightBlueOrange[0],
      [CorrectnessGroup.incorrect]: ColorSchemes.Discrete2.LightBlueOrange[1],
    },
  };

export type PointCloudStore = ReturnType<typeof createPointCloudStore>;

export const createPointCloudStore = (initProps?: Partial<PointCloudProps>) => {
  // The default props irrespective of the number of datasets
  const defaultProps: PointCloudProps = {
    points: [],
    pointData: null,
    selectedPointIds: new Set(),
    selectedClusterId: null,
    coloringStrategy: ColoringStrategy.dataset,
    datasetVisibility: { primary: true, reference: true },
    pointGroupVisibility: {
      [DatasetGroup.primary]: true,
      [DatasetGroup.reference]: true,
    },
    pointGroupColors: {
      // TODO move to a single source of truth
      [DatasetGroup.primary]: DEFAULT_COLOR_SCHEME[0],
      [DatasetGroup.reference]: DEFAULT_COLOR_SCHEME[1],
    },
    pointIdToGroup: {},
    selectionDisplay: SelectionDisplay.gallery,
    dimension: null,
    dimensionMetadata: null,
  };

  const pointCloudStore: StateCreator<PointCloudState> = (set, get) => ({
    ...defaultProps,
    ...initProps,
    setPoints: async (points) => {
      const pointCloudState = get();
      set({
        points: points,
        selectedPointIds: new Set(),
        selectedClusterId: null,
        pointData: null,
        pointIdToGroup: getPointIdToGroup({
          points,
          coloringStrategy: pointCloudState.coloringStrategy,
          pointsData: pointCloudState.pointData ?? {},
          dimension: pointCloudState.dimension || null,
          dimensionMetadata: pointCloudState.dimensionMetadata,
        }),
      });

      // Re-compute the point coloring once the granular data is loaded
      const pointData = await fetchPointEvents(points.map((p) => p.id));

      set({
        pointData,
        pointIdToGroup: getPointIdToGroup({
          points,
          coloringStrategy: pointCloudState.coloringStrategy,
          pointsData: pointData ?? {},
          dimension: pointCloudState.dimension || null,
          dimensionMetadata: pointCloudState.dimensionMetadata,
        }),
      });
    },
    setSelectedPointIds: (ids) => set({ selectedPointIds: ids }),
    setSelectedClusterId: (id) => set({ selectedClusterId: id }),
    setColoringStrategy: (strategy) => {
      const pointCloudState = get();

      set({ coloringStrategy: strategy });
      switch (strategy) {
        case ColoringStrategy.correctness:
          set({
            pointGroupVisibility: {
              [CorrectnessGroup.correct]: true,
              [CorrectnessGroup.incorrect]: true,
              [CorrectnessGroup.unknown]: true,
            },
            pointGroupColors: {
              [CorrectnessGroup.correct]:
                ColorSchemes.Discrete2.LightBlueOrange[0],
              [CorrectnessGroup.incorrect]:
                ColorSchemes.Discrete2.LightBlueOrange[1],
              [CorrectnessGroup.unknown]: UNKNOWN_COLOR,
            },
            dimension: null,
            dimensionMetadata: null,
            pointIdToGroup: getPointIdToGroup({
              points: pointCloudState.points,
              coloringStrategy: strategy,
              pointsData: pointCloudState.pointData ?? {},
              dimension: pointCloudState.dimension || null,
              dimensionMetadata: pointCloudState.dimensionMetadata,
            }),
          });
          break;
        case ColoringStrategy.dataset: {
          // Clear out the point groups as there are no groups
          set({
            pointGroupVisibility: {
              [DatasetGroup.primary]: true,
              [DatasetGroup.reference]: true,
            },
            pointGroupColors: {
              // TODO move these colors to a constants file
              [DatasetGroup.primary]: DEFAULT_COLOR_SCHEME[0],
              [DatasetGroup.reference]: DEFAULT_COLOR_SCHEME[1],
            },
            dimension: null,
            dimensionMetadata: null,
            pointIdToGroup: getPointIdToGroup({
              points: pointCloudState.points,
              coloringStrategy: strategy,
              pointsData: pointCloudState.pointData ?? {},
              dimension: pointCloudState.dimension || null,
              dimensionMetadata: pointCloudState.dimensionMetadata,
            }),
          });
          break;
        }
        case ColoringStrategy.dimension: {
          // come dynamically from the dimension "values"
          set({
            pointGroupVisibility: {
              unknown: true,
            },
            pointGroupColors: {
              unknown: UNKNOWN_COLOR,
            },
            dimension: null,
            dimensionMetadata: null,
            pointIdToGroup: getPointIdToGroup({
              points: pointCloudState.points,
              coloringStrategy: strategy,
              pointsData: pointCloudState.pointData ?? {},
              dimension: pointCloudState.dimension || null,
              dimensionMetadata: pointCloudState.dimensionMetadata,
            }),
          });
          break;
        }
        default:
          assertUnreachable(strategy);
      }
    },
    datasetVisibility: { primary: true, reference: true },
    setDatasetVisibility: (visibility) =>
      set({ datasetVisibility: visibility }),
    setPointGroupVisibility: (visibility) =>
      set({ pointGroupVisibility: visibility }),
    selectionDisplay: SelectionDisplay.gallery,
    setSelectionDisplay: (display) => set({ selectionDisplay: display }),
    reset: () => {
      set({
        points: [],
        selectedPointIds: new Set(),
        selectedClusterId: null,
        pointIdToGroup: {},
      });
    },
    setDimension: async (dimension) => {
      const pointCloudState = get();
      set({ dimension, dimensionMetadata: null });
      const dimensionMetadata = await fetchDimensionMetadata(dimension);
      set({ dimensionMetadata });
      if (dimensionMetadata.categories && dimensionMetadata.categories.length) {
        const numCategories = dimensionMetadata.categories.length;
        // If the number of categories is less than the discrete color scale, use discrete color scheme
        const useDiscreteColorScale =
          numCategories <= discreteColorScaleCategories.length;
        const colorScaleFn = useDiscreteColorScale
          ? discreteColorScale
          : (index: number) => sequentialColorScale(index / numCategories);
        set({
          pointGroupVisibility: {
            ...dimensionMetadata.categories.reduce(
              (acc, category) => ({
                ...acc,
                [category]: true,
              }),
              {}
            ),
            unknown: true,
          },
          pointGroupColors: {
            ...dimensionMetadata.categories.reduce(
              (acc, category, idx) => ({
                ...acc,
                [category]: colorScaleFn(idx),
              }),
              {}
            ),
            unknown: UNKNOWN_COLOR,
          },
          pointIdToGroup: getPointIdToGroup({
            points: pointCloudState.points,
            coloringStrategy: pointCloudState.coloringStrategy,
            pointsData: pointCloudState.pointData ?? {},
            dimension,
            dimensionMetadata,
          }),
        });
      } else if (dimensionMetadata.interval !== null) {
        // Create color groups based on the min / max of the dimension
        const groups = getNumericGroupsFromInterval(dimensionMetadata.interval);

        set({
          pointGroupVisibility: {
            ...groups.reduce(
              (acc, group) => ({
                ...acc,
                [group.name]: true,
              }),
              {}
            ),
            unknown: true,
          },
          pointGroupColors: {
            ...groups.reduce(
              (acc, group, idx) => ({
                ...acc,
                [group.name]: numericColorScale(idx),
              }),
              {}
            ),
            unknown: UNKNOWN_COLOR,
          },
          pointIdToGroup: getPointIdToGroup({
            points: pointCloudState.points,
            coloringStrategy: pointCloudState.coloringStrategy,
            pointsData: pointCloudState.pointData ?? {},
            dimension,
            dimensionMetadata,
          }),
        });
      }
    },
    setDimensionMetadata: (dimensionMetadata) => set({ dimensionMetadata }),
  });

  return create<PointCloudState>()(devtools(pointCloudStore));
};

// ---- Helper functions ----
/**
 * A numeric number Interval. Includes the min, excludes the max.
 * E.g. [min, max)
 */
interface Interval {
  min: number;
  max: number;
}

/**
 * An interval that represents a group of numeric values
 */
interface NumericGroupInterval extends Interval {
  name: string;
}

const numberFormatter = new Intl.NumberFormat([], {
  maximumFractionDigits: 2,
});
/**
 * A human readable string representation of an interval
 */
function intervalToString({ min, max }: Interval): string {
  return `${numberFormatter.format(min)} - ${numberFormatter.format(max)}`;
}

/**
 * Calculates the groups for numeric dimensions and splits it into interval groups
 * E.x. [0, 10] => [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10]
 */
function getNumericGroupsFromInterval({
  min,
  max,
}: Interval): NumericGroupInterval[] {
  const range = max - min;
  // Break the range into 10 groups
  const groupSliceSize = range / NUM_NUMERIC_GROUPS;
  const groups: NumericGroupInterval[] = [];
  for (let i = 0; i < NUM_NUMERIC_GROUPS; i++) {
    const groupMin = min + i * groupSliceSize;
    const groupMax = min + (i + 1) * groupSliceSize;
    groups.push({
      min: groupMin,
      max: groupMax,
      name: intervalToString({ min: groupMin, max: groupMax }),
    });
  }
  return groups;
}

/**
 * Calculates the group mapping for each point
 */
function getPointIdToGroup(
  params: GetPointIdToGroupParams
): Record<string, string> {
  const { points, coloringStrategy, pointsData, dimension, dimensionMetadata } =
    params;
  const pointIdToGroup: Record<string, string> = {};
  const pointIds = points.map((point) => point.id);
  switch (coloringStrategy) {
    case ColoringStrategy.dataset: {
      const { primaryPointIds, referencePointIds } =
        splitPointIdsByDataset(pointIds);
      primaryPointIds.forEach((pointId) => {
        pointIdToGroup[pointId] = DatasetGroup.primary;
      });
      referencePointIds.forEach((pointId) => {
        pointIdToGroup[pointId] = DatasetGroup.reference;
      });
      break;
    }
    case ColoringStrategy.correctness: {
      points.forEach((point) => {
        let group = CorrectnessGroup.unknown;

        const { predictionLabel, actualLabel } = point.eventMetadata;
        if (predictionLabel !== null && actualLabel !== null) {
          group =
            predictionLabel === actualLabel
              ? CorrectnessGroup.correct
              : CorrectnessGroup.incorrect;
        }
        pointIdToGroup[point.id] = group;
      });
      break;
    }
    case ColoringStrategy.dimension: {
      let numericGroupIntervals: NumericGroupInterval[] | null;
      if (dimensionMetadata && dimensionMetadata?.interval !== null) {
        numericGroupIntervals = getNumericGroupsFromInterval(
          dimensionMetadata.interval
        );
      }
      const isColorByPredictionLabel =
        dimension?.type === "prediction" &&
        dimension?.dataType === "categorical";
      const isColorByActualLabel =
        dimension?.type === "actual" && dimension?.dataType === "categorical";

      points.forEach((point) => {
        let group = "unknown";
        const pointData = pointsData[point.id];

        // Flag to determine if we have enough data to color by dimension
        const haveSufficientDataToColorByDimension =
          dimension != null && pointData != null;

        if (haveSufficientDataToColorByDimension) {
          if (isColorByPredictionLabel) {
            group = pointData.eventMetadata.predictionLabel ?? "unknown";
          } else if (isColorByActualLabel) {
            group = pointData.eventMetadata.actualLabel ?? "unknown";
          } else {
            // It is a feature or tag. Find the dimension value
            const dimensionWithValue = pointData.dimensions.find(
              (dimensionWithValue) =>
                dimensionWithValue.dimension.name === dimension.name
            );
            if (
              dimensionWithValue != null &&
              dimension.dataType === "categorical"
            ) {
              // The group is just the categorical value
              group = dimensionWithValue.value;
            } else if (
              dimensionWithValue != null &&
              dimension.dataType === "numeric" &&
              numericGroupIntervals != null
            ) {
              const numericValue = parseFloat(dimensionWithValue.value);
              if (typeof numericValue === "number") {
                let groupIndex = numericGroupIntervals.findIndex(
                  (group) =>
                    numericValue >= group.min && numericValue < group.max
                );
                // If we fail to find the index, it means it belongs to the last group
                groupIndex =
                  groupIndex === -1 ? NUM_NUMERIC_GROUPS - 1 : groupIndex;
                group = numericGroupIntervals[groupIndex].name;
              }
            }
          }
        }

        pointIdToGroup[point.id] = group;
      });

      break;
    }
    default:
      assertUnreachable(coloringStrategy);
  }
  return pointIdToGroup;
}

// ---- Async data retrieval functions ---

/**
 * Fetches the dimension metadata for coloring group computation
 */
async function fetchDimensionMetadata(
  dimension: Dimension
): Promise<DimensionMetadata> {
  const data = await fetchQuery<pointCloudStore_dimensionMetadataQuery>(
    RelayEnvironment,
    graphql`
      query pointCloudStore_dimensionMetadataQuery(
        $id: GlobalID!
        $getDimensionMinMax: Boolean!
        $getDimensionCategories: Boolean!
      ) {
        dimension: node(id: $id) @required(action: THROW) {
          ... on Dimension {
            id
            min: dataQualityMetric(metric: min)
              @include(if: $getDimensionMinMax)
            max: dataQualityMetric(metric: max)
              @include(if: $getDimensionMinMax)
            categories @include(if: $getDimensionCategories)
          }
        }
      }
    `,
    {
      id: dimension.id,
      getDimensionMinMax: dimension.dataType === "numeric",
      getDimensionCategories: dimension.dataType === "categorical",
    }
  ).toPromise();

  const dimensionData = data?.dimension;

  if (!dimension) {
    throw new Error("Dimension not found");
  }

  let interval: Interval | null = null;
  if (
    typeof dimensionData?.min === "number" &&
    typeof dimensionData?.max === "number"
  ) {
    interval = { min: dimensionData.min, max: dimensionData.max };
  }
  return {
    interval,
    categories: dimensionData?.categories ?? null,
  };
}

type GetPointIdToGroupParams = {
  points: readonly Point[];
  coloringStrategy: ColoringStrategy;
  pointsData: PointDataMap;
  /**
   * If coloring by dimension, the dimension to use for coloring
   */
  dimension?: Dimension | null;
  /**
   * If coloring by dimension, the dimension metadata to use for coloring
   */
  dimensionMetadata?: DimensionMetadata | null;
};

async function fetchPointEvents(pointIds: string[]): Promise<PointDataMap> {
  const { primaryPointIds, referencePointIds } = splitPointIdsByDataset([
    ...pointIds,
  ]);
  const data = await fetchQuery<pointCloudStore_eventsQuery>(
    RelayEnvironment,
    graphql`
      query pointCloudStore_eventsQuery(
        $primaryEventIds: [ID!]!
        $referenceEventIds: [ID!]!
      ) {
        model {
          primaryDataset {
            events(eventIds: $primaryEventIds) {
              id
              dimensions {
                dimension {
                  name
                  type
                }
                value
              }
              eventMetadata {
                predictionLabel
                actualLabel
              }
            }
          }
          referenceDataset {
            events(eventIds: $referenceEventIds) {
              id
              dimensions {
                dimension {
                  id
                  name
                  type
                }
                value
              }
              eventMetadata {
                predictionLabel
                actualLabel
              }
            }
          }
        }
      }
    `,
    {
      primaryEventIds: primaryPointIds,
      referenceEventIds: referencePointIds,
    }
  ).toPromise();
  // Construct a map of point id to the event data
  const primaryEvents = data?.model?.primaryDataset?.events ?? [];
  const referenceEvents = data?.model?.referenceDataset?.events ?? [];
  const allEvents = [...primaryEvents, ...referenceEvents];
  return allEvents.reduce((acc, event) => {
    acc[event.id] = event;
    return acc;
  }, {} as PointDataMap);
}
